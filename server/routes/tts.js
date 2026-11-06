/* Read aloud: streams raw 24 kHz mono PCM16 from Gemini TTS. */
import { requireUser } from '../lib/firebase.js';
import { HttpError, readJson } from '../lib/http.js';
import { streamSpeech } from '../lib/vertex.js';

function speakable(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$/g, ' (equation) ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`>#|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function speak(request) {
  const user = await requireUser(request, { limit: { name: 'tts', capacity: 20, refillPerSecond: 0.2 } });
  const body = await readJson(request, 64 * 1024);
  const text = speakable(body?.text).slice(0, 6000);
  if (!text) throw new HttpError(400, 'Nothing to read.');
  const controller = new AbortController();
  request.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  const iterator = streamSpeech({ text, voice: body?.voice, style: body?.style || 'Read this naturally and warmly, at a comfortable pace.', signal: controller.signal });
  // Pull the first chunk before responding so errors become proper HTTP errors.
  const first = await iterator.next();
  void user;
  const stream = new ReadableStream({
    start(c) { if (!first.done) c.enqueue(new Uint8Array(first.value)); },
    async pull(c) {
      try {
        const { value, done } = await iterator.next();
        if (done) c.close(); else c.enqueue(new Uint8Array(value));
      } catch (error) { c.error(error); }
    },
    cancel() { controller.abort(); }
  });
  return new Response(stream, { headers: { 'Content-Type': 'audio/L16; rate=24000; channels=1', 'Cache-Control': 'no-store', 'X-Sample-Rate': '24000' } });
}

export const routes = { 'POST /api/tts': speak };
