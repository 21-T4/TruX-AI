/* Fresh home-screen greetings and prompt ideas (cached for 10 minutes). */
import { json } from '../lib/http.js';
import { generateOnce, MODELS } from '../lib/vertex.js';
import { rateLimit } from '../lib/ratelimit.js';

let cache = { value: null, at: 0 };
const FALLBACK = {
  greetings: ['What are we building today?', 'Ready when you are.', 'Got a question? Let\'s dig in.', 'Let\'s make something great.', 'Where should we start?'],
  prompts: ['Plan a weekend trip', 'Explain a tricky concept', 'Review my code']
};

function cleanList(values, min, max, limit) {
  return [...new Set((Array.isArray(values) ? values : []).map(v => String(v || '').replace(/\s+/g, ' ').trim()))]
    .filter(v => v.length >= min && v.length <= max).slice(0, limit);
}

async function home(request) {
  if (cache.value && Date.now() - cache.at < 10 * 60 * 1000) return json(cache.value);
  const ip = String(request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'anon';
  if (!rateLimit('home:' + ip, { capacity: 5, refillPerSecond: 0.05 })) return json(cache.value || FALLBACK);
  try {
    const { text } = await generateOnce({
      model: MODELS.hydrogen,
      contents: [{ role: 'user', parts: [{ text: 'Generate home-screen copy for an AI assistant. JSON: {"greetings": five distinct welcoming headlines of 4-10 words, "prompts": three short example requests of 3-7 words}. No emojis, no "Ask anything". Nonce ' + Date.now() }] }],
      config: { temperature: 1, maxOutputTokens: 300, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } }
    });
    const parsed = JSON.parse(text);
    const value = { greetings: cleanList(parsed.greetings, 12, 90, 5), prompts: cleanList(parsed.prompts, 6, 54, 3) };
    if (value.greetings.length >= 3 && value.prompts.length === 3) cache = { value, at: Date.now() };
  } catch (error) {
    console.warn('[home] generation failed:', error?.message);
  }
  return json(cache.value || FALLBACK);
}

export const routes = { 'GET /api/home': home };
