import { requireUser } from '../lib/firebase.js';
import { json, readJson } from '../lib/http.js';
import { registerPushToken, unregisterPushToken } from '../lib/push.js';

const LIMIT = { name: 'push', capacity: 10, refillPerSecond: 0.1 };

export const routes = {
  'GET /api/push/config': async (_request, { env }) => json({ vapidKey: env.FCM_VAPID_PUBLIC_KEY || '' }, 200, { 'Cache-Control': 'public, max-age=600' }),
  'POST /api/push/register': async request => {
    const user = await requireUser(request, { limit: LIMIT });
    const body = await readJson(request, 8192);
    return json({ ok: await registerPushToken(user.uid, body?.token) });
  },
  'POST /api/push/unregister': async request => {
    const user = await requireUser(request, { limit: LIMIT });
    const body = await readJson(request, 8192);
    await unregisterPushToken(user.uid, body?.token);
    return json({ ok: true });
  }
};
