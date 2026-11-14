/* Fresh home-screen greetings and prompt ideas (cached for 10 minutes). */
import { json } from '../lib/http.js';
import { generateOnce, MODELS, QUICK_THINKING } from '../lib/vertex.js';
import { rateLimit } from '../lib/ratelimit.js';

let cache = { value: null, at: 0, ttl: 0 };
const FALLBACK = {
  greetings: ['What are we building today?', 'Ready when you are.', 'Got a question? Let\'s dig in.', 'Let\'s make something great.', 'Where should we start?'],
  prompts: ['Plan a weekend trip', 'Explain a tricky concept', 'Review my code']
};

function cleanList(values, min, max, limit) {
  return [...new Set((Array.isArray(values) ? values : []).map(v => String(v || '').replace(/\s+/g, ' ').trim()))]
    .filter(v => v.length >= min && v.length <= max).slice(0, limit);
}

/* Same limits the app applies, so whatever we return is always displayable. */
function cleanGreetings(values) {
  return cleanList(values, 10, 100, 8).filter(v => { const w = v.split(' ').length; return w >= 3 && w <= 14; }).slice(0, 5);
}
function cleanPrompts(values) {
  return cleanList(values, 6, 100, 8).filter(v => { const w = v.split(' ').length; return w >= 2 && w <= 10; }).slice(0, 3);
}
function parseJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/gi, '');
  try { return JSON.parse(raw); } catch {}
  const match = raw.match(/\{[\s\S]*\}/);
  return match ? JSON.parse(match[0]) : {};
}

async function home(request) {
  if (cache.value && Date.now() - cache.at < cache.ttl) return json(cache.value);
  const ip = String(request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'anon';
  if (!rateLimit('home:' + ip, { capacity: 5, refillPerSecond: 0.05 })) return json(cache.value || FALLBACK);
  try {
    const { text } = await generateOnce({
      model: MODELS.hydrogen,
      contents: [{ role: 'user', parts: [{ text: 'Generate home-screen copy for an AI assistant. JSON: {"greetings": five distinct welcoming headlines of 4-10 words, "prompts": three short example requests of 3-7 words}. No emojis, no "Ask anything". Nonce ' + Date.now() }] }],
      config: { temperature: 1, maxOutputTokens: 1500, responseMimeType: 'application/json', ...QUICK_THINKING },
      signal: AbortSignal.timeout(8000)          // never leave the home screen waiting on the model
    });
    const parsed = parseJson(text);
    const greetings = cleanGreetings(parsed.greetings);
    const prompts = cleanPrompts(parsed.prompts);
    if (greetings.length >= 3 && prompts.length === 3) { cache = { value: { greetings, prompts }, at: Date.now(), ttl: 10 * 60 * 1000 }; return json(cache.value); }
    console.warn('[home] model copy unusable, using built-in copy');
  } catch (error) {
    console.warn('[home] generation failed:', error?.message);
  }
  // Built-in copy is cached briefly so a model outage does not make every visit wait for a failing call.
  cache = { value: FALLBACK, at: Date.now(), ttl: 30 * 1000 };
  return json(FALLBACK);
}

export const routes = { 'GET /api/home': home };
