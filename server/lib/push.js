/* Web push via FCM. Tokens live at _server/push/{uid}/{sha} (server-only). */
import crypto from 'node:crypto';
import { getDb, getAdminMessaging } from './firebase.js';

function tokenKey(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32);
}

export async function registerPushToken(uid, token) {
  const value = String(token || '').trim();
  if (value.length < 20 || value.length > 4096) return false;
  await (await getDb()).ref(`_server/push/${uid}/${tokenKey(value)}`).set({ token: value, updatedAt: Date.now() });
  return true;
}

export async function unregisterPushToken(uid, token) {
  await (await getDb()).ref(`_server/push/${uid}/${tokenKey(token)}`).remove();
}

export async function notifyUser(uid, title, body, data = {}) {
  try {
    const db = await getDb();
    const snapshot = await db.ref(`_server/push/${uid}`).get();
    const entries = Object.entries(snapshot.val() || {}).filter(([, v]) => v?.token);
    if (!entries.length) return;
    const messaging = await getAdminMessaging();
    const result = await messaging.sendEachForMulticast({
      tokens: entries.map(([, v]) => v.token),
      notification: { title: String(title).slice(0, 80), body: String(body).slice(0, 180) },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      webpush: { fcmOptions: { link: '/' } }
    });
    await Promise.all(result.responses.map((r, i) => {
      const code = r.error?.code || '';
      if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
        return db.ref(`_server/push/${uid}/${entries[i][0]}`).remove();
      }
      return null;
    }));
  } catch (error) {
    console.warn('[push] notify failed:', error?.message || error);
  }
}
