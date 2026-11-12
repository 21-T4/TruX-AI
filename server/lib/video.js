/*
 * Video studio pipeline.
 *
 *   1. Gemini 4 Argon (the director) turns the user's brief into a shot plan
 *      with production-ready prompts.
 *   2. Veo 3.1 (the highest-quality Veo) renders the opening shot with audio.
 *   3. Gemini Omni extends that clip shot by shot for longer videos, keeping
 *      characters, motion and sound coherent. Omni also handles edits of a
 *      video the user attached.
 *
 * Everything runs on Vertex AI; outputs are written straight to the user's
 * folder in the TruX bucket.
 */
import { getProjectId, googleApi } from './config.js';
import { generateOnce, getVertexClient, MODELS } from './vertex.js';

export const VIDEO_LENGTHS = [8, 18, 28];
const OMNI_STEP_SECONDS = 10;
const POLL_MS = 7000;
const DEADLINE_MS = 25 * 60 * 1000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stopped = () => Object.assign(new Error('Video generation was stopped.'), { stopped: true });

function cleanRatio(value) { return value === '9:16' ? '9:16' : '16:9'; }
export function cleanLength(value) {
  const n = Number(value);
  return VIDEO_LENGTHS.includes(n) ? n : 0; // 0 = let the director decide
}

/* ---------- 1. Director (Gemini 4 Argon) ---------- */
const PLAN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    aspectRatio: { type: 'STRING', enum: ['16:9', '9:16'] },
    length: { type: 'INTEGER', description: 'Duration in seconds: 8, 18, or 28.' },
    look: { type: 'STRING' },
    shots: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { prompt: { type: 'STRING' }, caption: { type: 'STRING' } },
        required: ['prompt', 'caption']
      }
    }
  },
  required: ['title', 'aspectRatio', 'length', 'look', 'shots']
};

const DIRECTOR_PROMPT = `You are the director and prompt designer for an AI video studio.
Turn the user's brief into a shot plan that a video model will render.

Engines:
- Shot 1 is rendered by Veo 3.1 as an 8-second clip with native audio.
- Each later shot is rendered by Gemini Omni as a 10-second continuation of the video so far.
So a plan has 1 shot (8 s), 2 shots (18 s) or 3 shots (28 s).

Rules:
- Pick "length" 8 unless the brief needs a story, sequence, explainer or several beats; then 18 or 28. If the user fixed a length, use it.
- Pick 9:16 for phone, reels, shorts, stories or portrait subjects; otherwise 16:9, unless the user fixed it.
- "look" is one line describing the shared visual style, palette, lens and mood. Repeat the essentials in every shot prompt.
- Shot 1 prompt: a complete, vivid description of subject, setting, action, camera movement, lens, lighting, style and sound (dialogue in quotes, ambience, music). 60-150 words.
- Later shot prompts start with "The scene continues:" and describe only what happens next, keeping the same characters, wardrobe, location and sound unless the story changes them. 40-100 words.
- Text that must appear on screen goes in quotes. Never ask questions; make confident creative choices.
- "caption" is a 3-8 word label for the storyboard.`;

export async function planVideo({ brief, length = 0, aspectRatio = '', hasImage = false, editing = false, signal }) {
  const wanted = [
    'Brief: ' + String(brief || '').slice(0, 6000),
    length ? `Length is fixed: ${length} seconds.` : 'Length: choose.',
    aspectRatio ? `Aspect ratio is fixed: ${cleanRatio(aspectRatio)}.` : 'Aspect ratio: choose.',
    hasImage ? 'The user attached a reference image; shot 1 animates it, so describe motion that starts from that image.' : '',
    editing ? 'The user attached a video to edit. Return exactly one shot whose prompt is a precise edit instruction for that video.' : ''
  ].filter(Boolean).join('\n');
  try {
    const { text } = await generateOnce({
      model: MODELS.director,
      contents: [{ role: 'user', parts: [{ text: wanted }] }],
      systemInstruction: DIRECTOR_PROMPT,
      config: { responseMimeType: 'application/json', responseSchema: PLAN_SCHEMA, temperature: 0.8 },
      signal
    });
    const plan = JSON.parse(text);
    const chosenLength = VIDEO_LENGTHS.includes(Number(length)) ? Number(length) : (VIDEO_LENGTHS.includes(Number(plan.length)) ? Number(plan.length) : 8);
    const count = editing ? 1 : Math.round((chosenLength - 8) / OMNI_STEP_SECONDS) + 1;
    const shots = (plan.shots || []).filter(s => s?.prompt).slice(0, count);
    if (!shots.length) throw new Error('empty plan');
    return {
      title: String(plan.title || 'Untitled').slice(0, 80),
      aspectRatio: cleanRatio(aspectRatio || plan.aspectRatio),
      look: String(plan.look || '').slice(0, 400),
      shots: shots.map(s => ({ prompt: String(s.prompt).slice(0, 4000), caption: String(s.caption || '').slice(0, 80) }))
    };
  } catch (error) {
    if (signal?.aborted) throw stopped();
    console.warn('[video] director failed, using the brief directly:', error?.message || error);
    return { title: String(brief).slice(0, 60), aspectRatio: cleanRatio(aspectRatio), look: '', shots: [{ prompt: String(brief).slice(0, 4000), caption: 'Opening shot' }] };
  }
}

/* ---------- 2. Veo 3.1 ---------- */
async function renderVeo({ prompt, aspectRatio, outputGcsUri, image, signal, onTick }) {
  const client = await getVertexClient();
  let operation = await client.models.generateVideos({
    model: MODELS.video,
    prompt,
    ...(image ? { image: { gcsUri: image.uri, mimeType: image.mimeType } } : {}),
    config: { numberOfVideos: 1, aspectRatio, durationSeconds: 8, resolution: '1080p', generateAudio: true, outputGcsUri }
  });
  const deadline = Date.now() + DEADLINE_MS;
  while (!operation?.done) {
    if (signal?.aborted) throw stopped();
    if (Date.now() > deadline) throw new Error('Veo took too long. Please try again.');
    await sleep(POLL_MS);
    onTick?.();
    operation = await client.operations.get({ operation });
  }
  if (operation.error?.message) throw new Error(String(operation.error.message));
  const video = operation.response?.generatedVideos?.[0]?.video;
  const uri = String(video?.uri || video?.gcsUri || '');
  if (!uri) throw new Error('Veo returned no video (it may have been filtered for safety).');
  return { uri, mimeType: video?.mimeType || 'video/mp4' };
}

/* ---------- 3. Gemini Omni (Interactions API) ---------- */
async function renderOmni({ prompt, aspectRatio, outputGcsUri, video, task, signal, onTick }) {
  const project = await getProjectId();
  const base = `https://aiplatform.googleapis.com/v1beta1/projects/${encodeURIComponent(project)}/locations/global/interactions`;
  const body = {
    model: MODELS.omni,
    background: true,
    store: false,
    input: [{ type: 'text', text: prompt }, { type: 'video', uri: video.uri, mime_type: video.mimeType || 'video/mp4' }],
    response_format: [{ type: 'video', delivery: 'uri', gcs_uri: outputGcsUri, aspect_ratio: aspectRatio, resolution: '1080p', ...(task === 'extend' ? { duration: OMNI_STEP_SECONDS + 's' } : {}) }],
    ...(task === 'extend' ? { generation_config: { video_config: { task: 'extend' } } } : {})
  };
  let start = await googleApi(base, { method: 'POST', body: JSON.stringify(body), signal });
  if (start.status === 400) {
    // Older Omni versions reject some output options; retry with the defaults.
    body.response_format = [{ type: 'video', delivery: 'uri', gcs_uri: outputGcsUri, aspect_ratio: aspectRatio }];
    start = await googleApi(base, { method: 'POST', body: JSON.stringify(body), signal });
  }
  let interaction = await start.json().catch(() => ({}));
  if (!start.ok) throw new Error('Gemini Omni: ' + String(interaction?.error?.message || 'HTTP ' + start.status).slice(0, 300));
  const deadline = Date.now() + DEADLINE_MS;
  while (interaction?.status !== 'completed') {
    if (signal?.aborted) throw stopped();
    if (['failed', 'cancelled', 'incomplete'].includes(interaction?.status) || interaction?.error) {
      throw new Error('Gemini Omni: ' + String(interaction?.error?.message || interaction?.status).slice(0, 300));
    }
    if (Date.now() > deadline) throw new Error('Gemini Omni took too long.');
    await sleep(POLL_MS);
    onTick?.();
    const poll = await googleApi(base + '/' + encodeURIComponent(interaction.id), { signal });
    interaction = await poll.json().catch(() => ({}));
    if (!poll.ok) throw new Error('Gemini Omni: ' + String(interaction?.error?.message || 'HTTP ' + poll.status).slice(0, 300));
  }
  for (const step of interaction.steps || interaction.outputs || []) {
    for (const item of step?.content || [step]) {
      if (item?.type === 'video' && item.uri) return { uri: String(item.uri), mimeType: item.mime_type || 'video/mp4' };
    }
  }
  throw new Error('Gemini Omni returned no video.');
}

/**
 * Runs the whole pipeline. `onEvent` receives storyboard and progress updates
 * for the UI. Returns the final video plus the plan. If a later Omni shot
 * fails, the longest finished cut is returned with a note.
 */
export async function produceVideo({ brief, length, aspectRatio, image, video, outputPrefix, signal, onEvent }) {
  const editing = !!video;
  onEvent?.({ stage: 'planning', label: 'Designing the shots with Gemini 4 Argon…' });
  const plan = await planVideo({ brief, length: editing ? 0 : length, aspectRatio, hasImage: !!image, editing, signal });
  onEvent?.({ stage: 'plan', plan });

  let ticks = 0;
  const tick = label => () => onEvent?.({ stage: 'render', label: label + ' ' + '·'.repeat((ticks++ % 3) + 1) });
  let current;
  const note = [];

  if (editing) {
    onEvent?.({ stage: 'render', shot: 0, label: 'Editing your video with Gemini Omni' });
    current = await renderOmni({ prompt: plan.shots[0].prompt, aspectRatio: plan.aspectRatio, outputGcsUri: `${outputPrefix}/edit/`, video, task: 'edit', signal, onTick: tick('Editing with Gemini Omni') });
  } else {
    onEvent?.({ stage: 'render', shot: 0, label: 'Rendering shot 1 with Veo 3.1' });
    current = await renderVeo({ prompt: [plan.look, plan.shots[0].prompt].filter(Boolean).join('\n'), aspectRatio: plan.aspectRatio, outputGcsUri: `${outputPrefix}/shot-1/`, image, signal, onTick: tick('Rendering shot 1 with Veo 3.1') });
    for (let i = 1; i < plan.shots.length; i++) {
      onEvent?.({ stage: 'render', shot: i, label: `Extending with Gemini Omni (shot ${i + 1} of ${plan.shots.length})` });
      try {
        current = await renderOmni({ prompt: plan.shots[i].prompt + (plan.look ? '\nKeep the look: ' + plan.look : ''), aspectRatio: plan.aspectRatio, outputGcsUri: `${outputPrefix}/shot-${i + 1}/`, video: current, task: 'extend', signal, onTick: tick(`Extending with Gemini Omni (shot ${i + 1})`) });
      } catch (error) {
        if (signal?.aborted) throw stopped();
        console.warn('[video] Omni extension failed:', error?.message || error);
        note.push(`Shot ${i + 1} could not be rendered (${String(error?.message || 'error').slice(0, 160)}); the video stops after shot ${i}.`);
        break;
      }
    }
  }
  return { ...current, plan, note: note.join(' ') };
}
