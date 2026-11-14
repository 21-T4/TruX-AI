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

  const stream = await client.models.generateContentStream({ model, contents, config: request });
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
   Two text models: Gemini 4 Hydrogen answers everyday and moderately complex requests quickly; Gemini 4 Argon
   takes the hard ones. routeModel() scores the request on several independent signals and sends it to Argon
   once the score reaches ARGON_THRESHOLD, so one weak signal ("debug" in a one-liner) stays on Hydrogen while a
   long, multi-part, code-heavy or proof-style request goes to Argon. */
const CODE_RE = /\b(code|coding|program|script|function|class|bug|debug|refactor|implement|compile|api|endpoint|javascript|typescript|python|java|html|css|react|node|sql|regex|github|repo|codebase|stack trace|exception|dependency)\b/i;
const HARD_RE = /\b(debug|refactor|architect|architecture|root cause|race condition|deadlock|concurren\w*|security|vulnerab\w*|migrat\w*|integrat\w*|optimi[sz]\w*|performance|multi[- ]file|end[- ]to[- ]end|unit tests?|full[- ]stack|step[- ]by[- ]step|multi[- ]step|in[- ]depth|prove|proof|derive|derivation|trade[- ]offs?|system design|distributed|scalab\w*|algorithm\w*|complexity|theorem|calculus|differential|eigen\w*|probabilit\w*|statistic\w*|regression)\b/i;
const HARD_RE_G = new RegExp(HARD_RE.source, 'gi');
const REASON_RE = /\b(reason|analy[sz]e|analysis|evaluate|compare|contrast|justify|strategy|solve|calculate|explain why|pros and cons|plan|summari[sz]e|outline|review|critique|rewrite|translate)\b/i;
const BUILD_RE = /\b(build|create|make|write|develop|design|implement|generate)\b[^.?!\n]{0,60}\b(app|application|website|web ?app|backend|frontend|service|system|game|compiler|interpreter|framework|library|pipeline|platform|dashboard|bot|extension|database schema|architecture)\b/i;
const MATH_RE = /(\bprove\b|\bderive\b|\btheorem\b|\bintegral\b|\bintegrate\b|\bdifferentiate\b|\bmatrix\b|\beigen|\blimit as\b|[∫∑∏√≤≥≈∞∂]|\\(frac|int|sum|lim)\b|\d\s*[\^*/]\s*\d.*=)/i;
const TRACE_RE = /(\bat\s+\S+\s*\(\S+:\d+:\d+\)|Traceback \(most recent call last\)|\bException in thread|\bUncaught \w*Error|\bSegmentation fault|^\s+at .+\.(js|ts|py|java|go|rs):\d+)/m;
const CHEAP_RE = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|good (morning|night|evening)|who are you|what('| i)?s your name)\b[\s!.?]*$/i;

export const ARGON_THRESHOLD = 4;

/**
 * Scores one request and returns { model, tier, score, thinking, reasons }.
 * `thinking` is the level the router suggests; an explicit higher level chosen in the app always wins.
 */
export function routeModel({ message = '', hasMedia = false, attachmentCount = 0, thinking = 'low', mode = 'chat' } = {}) {
  const text = String(message || '');
  const reasons = [];
  let score = 0;
  const add = (points, why) => { score += points; reasons.push(why + ' +' + points); };

  if (mode === 'deep-research') return { model: MODELS.argon, tier: 'argon', score: 99, thinking: thinking === 'low' ? 'medium' : thinking, reasons: ['deep research'] };
  if (thinking === 'high') add(ARGON_THRESHOLD, 'max thinking requested');
  if (CHEAP_RE.test(text.trim())) return { model: MODELS.hydrogen, tier: 'hydrogen', score: 0, thinking: 'low', reasons: ['small talk'] };

  const words = text.split(/\s+/).filter(Boolean).length;
  const hasFence = /```/.test(text);
  const codeLines = hasFence ? (text.match(/\n/g) || []).length : 0;
  const hardHits = (text.match(HARD_RE_G) || []).length;
  const hasCode = hasFence || CODE_RE.test(text);
  const listItems = (text.match(/^\s*(?:\d+[.)]|[-*•])\s+\S/gm) || []).length;
  const questions = (text.match(/\?/g) || []).length;

  if (hardHits >= 4) add(4, 'many hard-topic terms');
  else if (hardHits >= 2) add(3, 'several hard-topic terms');
  else if (hardHits === 1) add(2, 'hard-topic term');
  if (hasCode && words > 80) add(2, 'code with a long brief');
  else if (hasCode && words > 30) add(1, 'code request');
  if (hasFence && codeLines > 25) add(3, 'large code block');
  else if (hasFence && codeLines > 8) add(1, 'code block');
  if (TRACE_RE.test(text)) add(2, 'stack trace');
  if (BUILD_RE.test(text)) add(3, 'build a system or app');
  if (MATH_RE.test(text)) add(2, 'maths or proof');
  if (words > 600) add(4, 'very long request');
  else if (words > 250) add(2, 'long request');
  if (listItems >= 4) add(2, 'many-part request');
  if (questions >= 3) add(1, 'several questions');
  if (attachmentCount >= 3) add(1, 'many attachments');
  if (hasMedia && (REASON_RE.test(text) || hardHits)) add(1, 'analysing attachments');

  if (score >= ARGON_THRESHOLD) return { model: MODELS.argon, tier: 'argon', score, thinking: thinking === 'low' ? 'medium' : thinking, reasons };

  /* Hydrogen: choose how much it should think. Plain chat needs none; slightly complex asks get a little. */
  const moderate = score >= 2 || hasCode || REASON_RE.test(text) || words > 60 || hasMedia || thinking === 'medium';
  return { model: MODELS.hydrogen, tier: 'hydrogen', score, thinking: thinking === 'high' ? 'high' : (moderate ? 'medium' : 'low'), reasons };
}

/** Backwards-compatible helper: just the model id. */
export function pickModel(args) { return routeModel(args).model; }

/** Lightest thinking, for small helper calls (titles, home-screen copy). */
export const QUICK_THINKING = Object.freeze({ thinkingConfig: { thinkingLevel: 'LOW' } });

export function thinkingConfig(model, level) {
  const normalized = { high: 'HIGH', medium: 'MEDIUM' }[level] || 'LOW';
  /* Gemini 4 models reject thinkingBudget ("use thinking level instead"), so every call uses thinkingLevel.
     LOW is the lightest level, so plain chat on Hydrogen stays quick. */
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
