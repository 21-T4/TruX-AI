import { getCloudRunKv } from '../../cloud-run-store.js';

function getKv(env) {
  return getCloudRunKv(env);
}

export async function onRequestPost({ request, env }) {
  try {
    const { userId, token } = await request.json();
    if (!userId || typeof token !== 'string' || token.length < 20 || token.length > 10000) {
      return Response.json({ error: 'Invalid push registration.' }, { status: 400 });
    }

    const kv = getKv(env);
    const key = 'trux_push_tokens_' + String(userId);
    const existing = await kv.get(key, 'json');
    const tokens = Array.isArray(existing) ? existing.filter(x => typeof x === 'string') : [];

    if (!tokens.includes(token)) tokens.push(token);

    await kv.put(key, JSON.stringify(tokens.slice(-10)), { expirationTtl: 180 * 24 * 60 * 60 });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error?.message || 'Push registration failed.' }, { status: 500 });
  }
}
