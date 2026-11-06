/* Vertex AI access: one cached client on the global endpoint, streaming
   helpers, model routing, and media generation (image, video, speech). */
import { GoogleGenAI } from '@google/genai';
import { getProjectId, googleApi, VERTEX_LOCATION } from './config.js';
import { VOICE_IDS } from './personalization.js';

export const MODELS = Object.freeze({
  fast: 'gemini-3.5-flash-lite',
  balanced: 'gemini-3.6-flash',
  smart: 'gemini-3.8-flash',
  research: 'gemini-3.1-pro-preview',
  image: 'gemini-3-pro-image',       // Nano Banana Pro
  video: 'veo-3.1-generate-001',      // Veo 3.1 (full quality)
  omni: 'gemini-omni-1.2-flash',      // Gemini Omni: video extension and editing
  director: 'gemini-4-argon',         // shot planning / prompt design
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

/* ---------- Model routing ---------- */
const CODE_RE = /\b(code|coding|program|script|function|class|bug|debug|refactor|implement|compile|api|endpoint|javascript|typescript|python|java|html|css|react|node|sql|regex|github|repo|codebase|stack trace|exception|dependency)\b/i;
const HARD_RE = /\b(debug|refactor|architect|architecture|root cause|race condition|security|migrat|integrat|optimi[sz]|performance|multi[- ]file|end[- ]to[- ]end|unit tests?|full[- ]stack|step[- ]by[- ]step|multi[- ]step|in[- ]depth|prove|proof|derive|trade[- ]offs?|system design|theorem|calculus|differential)\b/i;
const REASON_RE = /\b(reason|analy[sz]e|analysis|evaluate|compare|contrast|justify|strategy|solve|calculate)\b/i;

/** Picks the fastest model that can handle the request well. */
export function pickModel({ message = '', hasMedia = false, thinking = 'low', mode = 'chat' }) {
  if (mode === 'deep-research') return MODELS.research;
  const text = String(message || '');
  const words = text.split(/\s+/).filter(Boolean).length;
  if (thinking === 'high' || HARD_RE.test(text) || (CODE_RE.test(text) && words > 30)) return MODELS.smart;
  if (CODE_RE.test(text) || REASON_RE.test(text) || words > 60 || thinking === 'medium') return MODELS.balanced;
  if (hasMedia) return MODELS.balanced;
  return MODELS.fast;
}

export function thinkingConfig(model, level) {
  if (model === MODELS.research) return {};
  const normalized = { high: 'HIGH', medium: 'MEDIUM' }[level] || 'LOW';
  if (model === MODELS.fast && normalized === 'LOW') return { thinkingConfig: { thinkingBudget: 0 } };
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
