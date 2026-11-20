/* Vertex AI access: one cached client on the global endpoint, streaming
   helpers, model routing, and media generation (image, video, speech). */
import { GoogleGenAI } from '@google/genai';
import { getProjectId, googleApi, VERTEX_LOCATION } from './config.js';
import { VOICE_IDS } from './personalization.js';

export const MODELS = Object.freeze({
  flashLite: 'gemini-3.5-flash-lite', // TruX-2 Spark; also writes the home-screen greeting and suggestions
  flash: 'gemini-3.8-flash',          // TruX-2 Quasar; also writes chat titles
  hydrogen: 'gemini-4-hydrogen',      // TruX-2 Aegis and deep research
  image: 'gemini-3-pro-image',       // Nano Banana Pro
  video: 'veo-3.1-generate-001',      // Veo 3.1 (full quality)
  omni: 'gemini-omni-1.2-flash',      // Gemini Omni: video extension and editing
  director: 'gemini-4-hydrogen',      // shot planning / prompt design
  tts: 'gemini-3.8-flash-tts',          // read aloud (Gemini 3.8 Flash TTS, not the retired preview model)
  ttsLite: 'gemini-3.8-flash-lite-tts', // used when the main TTS model is unavailable
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
/* True when a failed request looks like the tool setup was refused (not a network or quota problem). */
const TOOL_SETUP_ERROR = /tool|function|search|ground|server.?side|combin|unsupported|not supported|INVALID_ARGUMENT|400/i;

/**
 * Streams one model round. Text is forwarded through onText as it arrives.
 * Returns the full model content (with thought signatures intact, which
 * Gemini 3 requires when function calls are sent back) plus any calls.
 *
 * If the model refuses the tool setup (for example Google Search combined with function tools), the round is
 * retried with a simpler setup instead of failing: first allowing built-in and function tools together, then
 * function tools only (`fallbackTools`, which carries a search function), then no tools. `degraded` says which.
 */
export async function streamRound({ model, contents, systemInstruction, tools, fallbackTools = null, config = {}, signal, onText, onThought = null, client: injectedClient = null }) {
  const client = injectedClient || await getVertexClient();
  const request = { ...config };
  if (request.thinkingConfig) request.thinkingConfig = { ...request.thinkingConfig };
  if (systemInstruction) request.systemInstruction = systemInstruction;
  if (tools?.length) request.tools = tools;
  if (signal) request.abortSignal = signal;

  const parts = [];
  const functionCalls = [];
  let text = '';
  let grounding = null;
  let finishReason = '';
  let usage = null;
  let degraded = '';

  const open = () => client.models.generateContentStream({ model, contents, config: request });
  const hasBuiltIn = !!tools?.some(t => t.googleSearch);
  const hasFunctions = !!tools?.some(t => t.functionDeclarations);
  const fallbacks = [];
  if (hasBuiltIn && hasFunctions) fallbacks.push(() => { request.toolConfig = { includeServerSideToolInvocations: true }; });
  if (hasFunctions) fallbacks.push(() => { delete request.toolConfig; request.tools = fallbackTools || tools.filter(t => !t.googleSearch); degraded = 'functions-only'; });
  if (tools?.length) fallbacks.push(() => { delete request.toolConfig; delete request.tools; degraded = 'no-tools'; });

  let stream;
  let thinkingTried = false;
  let thoughtsDropped = false;
  for (;;) {
    try {
      stream = await open();
      break;
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = String(error?.message || '');
      /* Thought summaries are a nice extra, never a reason to fail: if the model refuses them, ask again without. */
      if (request.thinkingConfig?.includeThoughts && !thoughtsDropped && /thought|INVALID_ARGUMENT|\b400\b/i.test(message)) {
        delete request.thinkingConfig.includeThoughts;
        thoughtsDropped = true;
        continue;
      }
      /* A model that does not know the XHIGH level steps down to HIGH, then to the model's own default. */
      if (request.thinkingConfig?.thinkingLevel === 'XHIGH' && /thinking|level|xhigh|INVALID_ARGUMENT/i.test(message)) {
        request.thinkingConfig = { thinkingLevel: 'HIGH', ...(thoughtsDropped ? {} : { includeThoughts: true }) };
        thinkingTried = true;
        continue;
      }
      if (thinkingTried && request.thinkingConfig && /thinking|level/i.test(message)) { delete request.thinkingConfig; thinkingTried = false; continue; }
      const step = Number(error?.status) >= 500 || Number(error?.status) === 429 ? null : (TOOL_SETUP_ERROR.test(message) ? fallbacks.shift() : null);
      if (!step) throw error;
      console.warn('[vertex] tool setup refused by', model, '-', message.slice(0, 200), '- retrying with a simpler tool setup');
      step();
    }
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
        /* Thinking summaries are reported through onThought and kept OUT of the answer text. */
        if (part.thought) {
          if (part.text && onThought) await onThought(part.text);
          if (part.thoughtSignature) parts.push(part);
          continue;
        }
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
    usage,
    degraded
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

/** Lightest thinking, for small helper calls (titles, home-screen copy). */
export const QUICK_THINKING = Object.freeze({ thinkingConfig: { thinkingLevel: 'LOW' } });

/** Vertex names for the app's levels; 'max' is the Gemini 4 XHIGH level. */
const LEVEL_NAMES = Object.freeze({ low: 'LOW', medium: 'MEDIUM', high: 'HIGH', max: 'XHIGH' });

export function thinkingConfig(level) {
  /* Gemini 3.5/3.8/4 models reject thinkingBudget ("use thinking level instead"), so only thinkingLevel is ever sent. */
  return { thinkingConfig: { thinkingLevel: LEVEL_NAMES[level] || 'MEDIUM', includeThoughts: true } };
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
/** Gemini TTS can answer with a WAV file instead of bare PCM; the player wants raw 24 kHz PCM16, so drop a RIFF header. */
function stripWavHeader(buffer) {
  if (buffer.length > 44 && buffer.toString('ascii', 0, 4) === 'RIFF') {
    const at = buffer.indexOf('data', 12, 'ascii');
    return buffer.subarray(at >= 0 ? at + 8 : 44);
  }
  return buffer;
}

/** One speech request against one model: yields PCM chunks. Errors carry the real reason from Google. */
async function* speechChunks(model, { text, voice, style, signal }) {
  const project = await getProjectId();
  const url = `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${VERTEX_LOCATION}/publishers/google/models/${model}:streamGenerateContent?alt=sse`;
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
    let reason = detail.slice(0, 300);
    try { reason = JSON.parse(detail)?.error?.message || reason; } catch {}
    throw Object.assign(new Error(`Speech generation failed on ${model} (HTTP ${response.status}). ${reason}`.trim()), { status: response.status });
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let first = true;
  const read = function* (event) {
    const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
    if (!data) return;
    let payload;
    try { payload = JSON.parse(data); } catch { return; }
    for (const p of payload?.candidates?.[0]?.content?.parts || []) {
      if (!p.inlineData?.data) continue;
      let chunk = Buffer.from(p.inlineData.data, 'base64');
      if (first) { chunk = stripWavHeader(chunk); first = false; }
      if (chunk.length) yield chunk;
    }
  };
  for await (const piece of response.body) {
    buffer += decoder.decode(piece, { stream: true }).replace(/\r\n/g, '\n');
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      yield* read(event);
    }
  }
  if (buffer.trim()) yield* read(buffer);
}

/**
 * Streams read-aloud audio (raw PCM16, 24 kHz, mono). Tries the main TTS model and, if Google says it is not available
 * (404, 400 or 403 before any audio was produced), the lite one. Only the failure before the first chunk is retried.
 */
export async function* streamSpeech({ text, voice = 'Kore', style = '', signal }) {
  const models = [MODELS.tts, MODELS.ttsLite];
  let lastError = null;
  for (const model of models) {
    let produced = false;
    try {
      for await (const chunk of speechChunks(model, { text, voice, style, signal })) { produced = true; yield chunk; }
      if (produced) return;
      lastError = new Error(`Speech generation returned no audio on ${model}.`);
    } catch (error) {
      if (signal?.aborted || produced) throw error;
      lastError = error;
      console.warn('[tts]', String(error?.message || error).slice(0, 300));
      if (![400, 403, 404, 429, 500, 503, undefined].includes(error?.status)) break;
    }
  }
  throw lastError || new Error('Speech generation failed.');
}
