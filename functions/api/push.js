import { getCloudRunKv } from '../cloud-run-store.js';
import { requireFirebaseUser } from '../firebase-auth.js';

const PUSH_TOKEN_TTL_SECONDS = 180 * 24 * 60 * 60;

export async function onRequestGet({ request, env }) {
  if (new URL(request.url).pathname !== '/api/push/config') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  const vapidKey = String(env?.FCM_VAPID_PUBLIC_KEY || '').trim();
  return Response.json({ configured: !!vapidKey, vapidKey: vapidKey || null });
}

export async function onRequestPost({ request, env }) {
  const pathname = new URL(request.url).pathname;
  if (pathname !== '/api/push/register' && pathname !== '/api/push/unregister') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let user;
  try {
    user = await requireFirebaseUser(request, env);
  } catch {
    return Response.json({ error: 'Authentication required.' }, { status: 401 });
  }

  const uid = String(user?.uid || '').trim();
  if (!uid) return Response.json({ error: 'Authenticated user required.' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  if (String(body?.userId || '').trim() !== uid) {
    return Response.json({ error: 'User identity mismatch.' }, { status: 403 });
  }

  const token = body?.token;
  const kv = getCloudRunKv(env);
  const key = 'trux_push_tokens_' + uid;

  try {
    if (pathname === '/api/push/register') {
      if (typeof token !== 'string' || token.length < 20 || token.length > 10000) {
        return Response.json({ error: 'Invalid push registration.' }, { status: 400 });
      }
      const existing = await kv.get(key, 'json');
      const tokens = Array.isArray(existing) ? existing.filter(x => typeof x === 'string') : [];
      if (!tokens.includes(token)) tokens.push(token);
      await kv.put(key, JSON.stringify(tokens.slice(-10)), { expirationTtl: PUSH_TOKEN_TTL_SECONDS });
      return Response.json({ ok: true });
    }

    if (typeof token !== 'string') return Response.json({ ok: true });
    const existing = await kv.get(key, 'json');
    const tokens = Array.isArray(existing) ? existing.filter(x => x !== token) : [];
    await kv.put(key, JSON.stringify(tokens), { expirationTtl: PUSH_TOKEN_TTL_SECONDS });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({
      error: error?.message || (pathname === '/api/push/register' ? 'Push registration failed.' : 'Push unregistration failed.')
    }, { status: 500 });
  }
}
