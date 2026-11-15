/* Usage counters in RTDB under _server/usage/{uid} (never readable or writable by clients).
 *
 *   {yyyy-mm}/{field}                 monthly counters: images, deepResearch, tokens ...
 *   daily/{yyyy-mm-dd}/{modelId}      tokens generated per model today (UTC day), thinking tokens included
 *
 * Daily token checks run on every chat turn, so they must cost nothing: the day's counters are cached in memory
 * and increments are written to the database without waiting (atomic server-side increment).
 */
import { ServerValue } from 'firebase-admin/database';
import { getDb } from './firebase.js';
import { MODEL_ORDER, TRUX_MODELS, dailyLimitFor } from './models.js';

export const LIMITS = Object.freeze({ images: 15, deepResearch: 3, videos: 0 });

function monthKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function ref(uid, field) {
  return (await getDb()).ref(`_server/usage/${uid}/${monthKey()}/${field}`);
}

/** Owners, Pro and Edge users are unlimited for images and videos. */
export function limitFor(user, field) {
  if (user.owner || user.tier === 'pro' || user.tier === 'edge' || user.tier === 'ultra') return Infinity;
  return LIMITS[field] ?? Infinity;
}

export async function checkQuota(user, field) {
  const limit = limitFor(user, field);
  if (limit === Infinity) return { ok: true, used: 0, limit };
  const used = Number((await (await ref(user.uid, field)).get()).val()) || 0;
  return { ok: used < limit, used, limit };
}

export async function addUsage(uid, field, delta = 1) {
  const r = await ref(uid, field);
  await r.transaction(current => (Number(current) || 0) + delta);
}

/* ---------- daily tokens per model ---------- */
const CACHE_MS = 30_000;
const dailyCache = new Map(); // uid -> { day, at, tokens: { modelId: n } }

export const dayKey = (date = new Date()) => date.toISOString().slice(0, 10);
export const nextResetAt = (date = new Date()) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);

async function loadDaily(uid) {
  const day = dayKey();
  const cached = dailyCache.get(uid);
  if (cached && cached.day === day && Date.now() - cached.at < CACHE_MS) return cached;
  const snapshot = await (await getDb()).ref(`_server/usage/${uid}/daily/${day}`).get();
  const raw = snapshot.val() || {};
  const tokens = {};
  for (const id of MODEL_ORDER) tokens[id] = Math.max(0, Number(raw[id]) || 0);
  const entry = { day, at: Date.now(), tokens };
  if (dailyCache.size > 5000) dailyCache.delete(dailyCache.keys().next().value);
  dailyCache.set(uid, entry);
  return entry;
}

/** Tokens used today on one model against its limit. */
export async function checkDailyTokens(user, model) {
  const limit = dailyLimitFor(user, model);
  if (limit === Infinity) return { used: 0, limit, ok: true, resetsAt: nextResetAt() };   // nothing to look up: no added latency
  const { tokens } = await loadDaily(user.uid);
  const used = tokens[model.id] || 0;
  return { used, limit, ok: used < limit, resetsAt: nextResetAt() };
}

/** Adds generated tokens to today's count. Updates the cache at once; the database write is not awaited. */
export function addDailyTokens(uid, modelId, tokens) {
  const amount = Math.max(0, Math.round(Number(tokens) || 0));
  if (!amount || !Object.hasOwn(TRUX_MODELS, modelId)) return null;
  const day = dayKey();
  const cached = dailyCache.get(uid);
  if (cached && cached.day === day) cached.tokens[modelId] = (cached.tokens[modelId] || 0) + amount;
  getDb()
    .then(db => db.ref(`_server/usage/${uid}/daily/${day}/${modelId}`).set(ServerValue.increment(amount)))
    .catch(error => console.warn('[usage] daily token write failed:', error?.message || error));
  return cached?.tokens[modelId] ?? null;
}

/** Everything the Usage & limits screen shows. */
export async function usageSummary(user) {
  const [daily, images, deepResearch] = await Promise.all([
    loadDaily(user.uid),
    checkQuota(user, 'images'),
    checkQuota(user, 'deepResearch')
  ]);
  const models = {};
  for (const id of MODEL_ORDER) {
    const limit = dailyLimitFor(user, TRUX_MODELS[id]);
    const used = daily.tokens[id] || 0;
    models[id] = { used, limit: Number.isFinite(limit) ? limit : null, remaining: Number.isFinite(limit) ? Math.max(0, limit - used) : null };
  }
  const finite = value => (Number.isFinite(value) ? value : null);
  return {
    day: daily.day,
    resetsAt: nextResetAt(),
    models,
    monthly: {
      images: { used: images.used, limit: finite(images.limit) },
      deepResearch: { used: deepResearch.used, limit: finite(deepResearch.limit) }
    }
  };
}
