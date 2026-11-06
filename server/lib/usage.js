/* Monthly usage counters in RTDB at _server/usage/{uid}/{yyyy-mm}.
   _server is never readable or writable by clients. */
import { getDb } from './firebase.js';

export const LIMITS = Object.freeze({ images: 15, deepResearch: 3, videos: 0 });

function monthKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function ref(uid, field) {
  return (await getDb()).ref(`_server/usage/${uid}/${monthKey()}/${field}`);
}

/** Owners and pro-tier users are unlimited; videos need pro or owner. */
export function limitFor(user, field) {
  if (user.owner || user.tier === 'pro' || user.tier === 'ultra') return Infinity;
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
