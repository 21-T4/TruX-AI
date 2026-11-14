/* Vertex AI access: one cached client on the global endpoint, streaming
   helpers, model routing, and media generation (image, video, speech). */
import { GoogleGenAI } from '@google/genai';
import { getProjectId, googleApi, VERTEX_LOCATION } from './config.js';
import { VOICE_IDS } from './personalization.js';

export const MODELS = Object.freeze({
  hydrogen: 'gemini-4-hydrogen',      // light and moderately complex work
  argon: 'gemini-4-argon',            // complex, multi-step and deep-research work
  image: 'gemini-3-pro-image',       // Nano Banana Pro
  video: 'veo-3.1-generate-001',      // Veo 3.1 (full quality)
  omni: 'gemini-omni-1.2-flash',      // Gemini Omni: video extension and editing
  director: 'gemini-4-argon',         // shot planning / prompt design (same model as argon)
  tts: 'gemini-3.8-flash-tts',
  live: 'gemini-3.8-live'
});

let clientPromise = null;
export function getVertexClient() {
  if (!clientPromise) {
    clientPromise = getProjectId()
      .then(project => new GoogleGenAI({ vertexai: true, project, location: VERTEX_LOCATION }))
      .catch(error => { clientPromise = null; throw error; });
  }
  return clientPromise;
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
export { stableJson };

function mergeGrounding(previous, incoming) {
  if (!incoming) return previous;
  const seen = new Set();
  const chunks = [];
  for (const chunk of [...(previous?.groundingChunks || []), ...(incoming.groundingChunks || [])]) {
    const key = String(chunk?.web?.uri || stableJson(chunk));
    if (seen.has(key)) continue;
    seen.add(key);
    chunks.push(chunk);
  }
  return {
    ...(previous || {}),
    ...incoming,
    groundingChunks: chunks,
    webSearchQueries: [...new Set([...(previous?.webSearchQueries || []), ...(incoming.webSearchQueries || [])])],
    searchEntryPoint: incoming.searchEntryPoint?.renderedContent ? incoming.searchEntryPoint : previous?.searchEntryPoint
  };
}

/**
 * Streams one model round. Text is forwarded through onText as it arrives.
 * Returns the full model content (with thought signatures intact, which
 * Gemini 3 requires when function calls are sent back) plus any calls.
 */
export async function streamRound({ model, contents, systemInstruction, tools, config = {}, signal, onText }) {
  const client = await getVertexClient();
  const request = { ...config };
  if (systemInstruction) request.systemInstruction = systemInstruction;
  if (tools?.length) request.tools = tools;
  if (signal) request.abortSignal = signal;

  const parts = [];
  const functionCalls = [];
  let text = '';
  let grounding = null;
  let finishReason = '';
  let usage = null;

  let stream;
  try {
    stream = await client.models.generateContentStream({ model, contents, config: request });
  } catch (error) {
    /* A model that does not know the MINIMAL thinking level: retry once with LOW. */
    if (request.thinkingConfig?.thinkingLevel === 'MINIMAL' && /thinking|level|minimal|INVALID_ARGUMENT/i.test(String(error?.message || '')) && !signal?.aborted) {
      request.thinkingConfig = { thinkingLevel: 'LOW' };
      stream = await client.models.generateContentStream({ model, contents, config: request });
    } else throw error;
  }
  for await (const chunk of stream) {
    const candidate = chunk?.candidates?.[0];
    if (chunk?.usageMetadata) usage = chunk.usageMetadata;
    if (candidate?.finishReason) finishReason = String(candidate.finishReason);
    if (candidate?.groundingMetadata) grounding = mergeGrounding(grounding, candidate.groundingMetadata);
    for (const part of candidate?.content?.parts || []) {
      if (part.functionCall) {
        functionCalls.push(part.functionCall);
        parts.push(part);
        continue;
      }
      if (typeof part.text === 'string') {
        if (part.thought) { if (part.thoughtSignature) parts.push(part); continue; }
        text += part.text;
        // Merge consecutive text parts so history stays compact.
        const last = parts[parts.length - 1];
        if (last && typeof last.text === 'string' && !last.thought && !last.functionCall) {
          last.text += part.text;
          if (part.thoughtSignature) last.thoughtSignature = part.thoughtSignature;
        } else {
          parts.push({ ...part });
        }
        if (part.text && onText) await onText(part.text);
        continue;
      }
      if (part.thoughtSignature) parts.push(part);
    }
  }
  return {
    text,
    functionCalls,
    modelContent: parts.length ? { role: 'model', parts } : null,
    grounding,
    finishReason,
    usage
  };
}

export async function generateOnce({ model, contents, systemInstruction, config = {}, signal }) {
  const client = await getVertexClient();
  const response = await client.models.generateContent({
    model,
    contents,
    config: { ...config, ...(systemInstruction ? { systemInstruction } : {}), ...(signal ? { abortSignal: signal } : {}) }
  });
  const parts = response?.candidates?.[0]?.content?.parts || [];
  return {
    response,
    text: parts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('').trim(),
    parts
  };
}

export function groundingSources(grounding, limit = 8) {
  const seen = new Set();
  const sources = [];
  for (const chunk of grounding?.groundingChunks || []) {
    const web = chunk?.web;
    if (!web?.uri || seen.has(web.uri)) continue;
    seen.add(web.uri);
    sources.push({ title: String(web.title || web.domain || 'Source'), uri: String(web.uri), domain: String(web.domain || '') });
    if (sources.length >= limit) break;
  }
  return sources;
}

/* ---------- Model routing ----------
   Gemini 4 Hydrogen is the default for everything, including hard-ish questions: it is the fast model. Gemini 4
   Argon is reserved for the genuinely heavy cases: very long prompts and very hard coding tasks (plus deep research
   and an explicit "Extended" thinking choice). routeModel() scores independent signals and needs ARGON_THRESHOLD
   points, so one or two hard-sounding words never move a request off Hydrogen. */
const CODE_RE = /\b(code|coding|program|script|function|class|bug|debug|refactor|implement|compile|api|endpoint|javascript|typescript|python|java|html|css|react|node|sql|regex|github|repo|codebase|stack trace|exception|dependency)\b/i;
const HARD_RE = /\b(refactor|architect|architecture|root cause|race condition|deadlock|concurren\w*|vulnerab\w*|migrat\w*|multi[- ]file|end[- ]to[- ]end|full[- ]stack|system design|distributed|scalab\w*|algorithm\w*|compiler|interpreter|memory leak|performance bottleneck|optimi[sz]\w*|prove|proof|derive|theorem)\b/i;
const HARD_RE_G = new RegExp(HARD_RE.source, 'gi');
const REASON_RE = /\b(reason|analy[sz]e|analysis|evaluate|compare|contrast|justify|strategy|solve|calculate|explain why|pros and cons|plan|summari[sz]e|outline|review|critique|rewrite|translate|explain|difference|how does|how do)\b/i;
const BUILD_RE = /\b(build|create|make|write|develop|design|implement|generate)\b[^.?!\n]{0,60}\b(app|application|website|web ?app|backend|frontend|service|system|game|compiler|interpreter|framework|library|pipeline|platform|dashboard|extension|architecture)\b/i;
const TRACE_RE = /(\bat\s+\S+\s*\(\S+:\d+:\d+\)|Traceback \(most recent call last\)|\bException in thread|\bUncaught \w*Error|\bSegmentation fault|^\s+at .+\.(js|ts|py|java|go|rs):\d+)/m;
/* Greetings, thanks and one-word replies: answer instantly, no thinking, no tools. */
const SMALL_TALK_RE = /^(hi+|hello+|hey+|hola|yo|sup|thanks?|thank you|thx|ok(ay)?|cool|nice|great|yes|no|yep|nope|good (morning|night|evening|afternoon)|how are you|who are you|what('| i)?s your name|what can you do)\b[\s!.?,]*[\w\s,'!?.]{0,30}$/i;

export const ARGON_THRESHOLD = 6;

/**
 * Scores one request and returns { model, tier, score, thinking, simple, reasons }.
 * `thinking` is the app's setting: 'auto' (let the router choose) or an explicit 'low' | 'medium' | 'high'.
 * An explicit level is always used exactly as chosen; only 'auto' is adjusted by the router.
 */
export function routeModel({ message = '', hasMedia = false, attachmentCount = 0, thinking = 'auto', mode = 'chat' } = {}) {
  const text = String(message || '');
  const explicit = ['low', 'medium', 'high'].includes(thinking) ? thinking : '';
  const reasons = [];
  let score = 0;
  const add = (points, why) => { score += points; reasons.push(why + ' +' + points); };

  if (mode === 'deep-research') return { model: MODELS.argon, tier: 'argon', score: 99, thinking: explicit || 'medium', simple: false, reasons: ['deep research'] };
  if (explicit === 'high') return { model: MODELS.argon, tier: 'argon', score: 99, thinking: 'high', simple: false, reasons: ['extended thinking chosen'] };

  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  if (!hasMedia && words <= 8 && SMALL_TALK_RE.test(trimmed)) {
    return { model: MODELS.hydrogen, tier: 'hydrogen', score: 0, thinking: explicit || 'low', simple: true, reasons: ['small talk'] };
  }

  const hasFence = /```/.test(text);
  const codeLines = hasFence ? (text.match(/\n/g) || []).length : 0;
  const hardHits = (text.match(HARD_RE_G) || []).length;
  const hasCode = hasFence || CODE_RE.test(text);
  const listItems = (text.match(/^\s*(?:\d+[.)]|[-*•])\s+\S/gm) || []).length;

  /* very long prompts */
  if (words > 900) add(6, 'very long prompt');
  else if (words > 500) add(4, 'long prompt');
  else if (words > 300) add(2, 'lengthy prompt');
  if (listItems >= 8) add(2, 'many-part request');

  /* very hard coding: hard terms only count when the request is about code */
  if (hasCode && hardHits >= 3) add(4, 'many hard coding terms');
  else if (hasCode && hardHits === 2) add(2, 'hard coding terms');
  if (hasFence && codeLines > 60) add(3, 'very large code block');
  else if (hasFence && codeLines > 25) add(1, 'large code block');
  if (TRACE_RE.test(text) && hardHits) add(2, 'stack trace with a hard problem');
  if (BUILD_RE.test(text) && hasCode && words > 40) add(3, 'build a whole system');
  if (attachmentCount >= 4) add(1, 'many attachments');

  if (score >= ARGON_THRESHOLD) return { model: MODELS.argon, tier: 'argon', score, thinking: explicit || 'medium', simple: false, reasons };

  /* Hydrogen answers everything else. Auto keeps thinking low unless the request clearly needs some. */
  const needsSome = score >= 2 || (hasCode && words > 40) || (REASON_RE.test(text) && words > 25) || (hasMedia && words > 6);
  return { model: MODELS.hydrogen, tier: 'hydrogen', score, thinking: explicit || (needsSome ? 'medium' : 'low'), simple: false, reasons };
}

/** Backwards-compatible helper: just the model id. */
export function pickModel(args) { return routeModel(args).model; }

/** Lightest thinking, for small helper calls (titles, home-screen copy). */
export const QUICK_THINKING = Object.freeze({ thinkingConfig: { thinkingLevel: 'LOW' } });

export function thinkingConfig(model, level, { minimal = false } = {}) {
  /* Gemini 4 models reject thinkingBudget ("use thinking level instead"), so only thinkingLevel is ever sent.
     `minimal` (small talk) asks for the lightest level; streamRound falls back to LOW if the model refuses it. */
  if (minimal) return { thinkingConfig: { thinkingLevel: 'MINIMAL' } };
  const normalized = { high: 'HIGH', medium: 'MEDIUM' }[level] || 'LOW';
  return { thinkingConfig: { thinkingLevel: normalized } };
}

/* ---------- Image generation ---------- */
export const IMAGE_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9'];

export async function generateImage({ prompt, aspectRatio = '1:1', size = '2K', referenceImages = [], signal }) {
  const parts = [];
  for (const ref of referenceImages.slice(0, 6)) {
    if (ref?.uri) parts.push({ fileData: { fileUri: ref.uri, mimeType: ref.mimeType || 'image/png' } });
  }
  parts.push({ text: String(prompt || '').slice(0, 6000) });
  const { parts: out } = await generateOnce({
    model: MODELS.image,
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: IMAGE_RATIOS.includes(aspectRatio) ? aspectRatio : '1:1', imageSize: ['1K', '2K', '4K'].includes(size) ? size : '2K' }
    },
    signal
  });
  const image = out.find(p => p.inlineData?.data);
  if (!image) throw new Error('The image model did not return an image. Try rephrasing the request.');
  return { mimeType: image.inlineData.mimeType || 'image/png', data: image.inlineData.data };
}

/* ---------- Text to speech (Gemini TTS, streaming PCM) ---------- */
export const TTS_VOICES = VOICE_IDS;

/**
 * Streams 24 kHz mono 16-bit PCM for `text`. Calls the REST endpoint
 * directly so speechMetadata (style prompt) is always passed through.
 */
export async function* streamSpeech({ text, voice = 'Kore', style = '', signal }) {
  const project = await getProjectId();
  const url = `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${VERTEX_LOCATION}/publishers/google/models/${MODELS.tts}:streamGenerateContent?alt=sse`;
  const part = { text: String(text || '').slice(0, 8000) };
  if (style) part.speechMetadata = { style: String(style).slice(0, 400) };
  const response = await googleApi(url, {
    method: 'POST',
    signal,
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [part] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICES.includes(voice) ? voice : 'Kore' } } }
      }
    })
  });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error('Speech generation failed (HTTP ' + response.status + '). ' + detail.slice(0, 300));
  }
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
      if (!data) continue;
      let payload;
      try { payload = JSON.parse(data); } catch { continue; }
      for (const p of payload?.candidates?.[0]?.content?.parts || []) {
        if (p.inlineData?.data) yield Buffer.from(p.inlineData.data, 'base64');
      }
    }
  }
}
