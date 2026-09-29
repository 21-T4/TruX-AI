import { requireFirebaseUser } from '../firebase-auth.js';
import { saveGzipJson } from '../gcs-store.js';

const MAX_CHAT_PAYLOAD = 10 * 1024 * 1024;

export async function onRequestPost({ request, env }) {
  const user = await requireFirebaseUser(request, env);
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_CHAT_PAYLOAD) {
    return Response.json({ error: 'Chat backup is too large.' }, { status: 413 });
  }

  const body = await request.json();
  const chats = body?.chats;
  if (!chats || typeof chats !== 'object' || Array.isArray(chats)) {
    return Response.json({ error: 'Chat data is invalid.' }, { status: 400 });
  }

  const objectKey = `chat-state/${user.uid}/current.json.gz`;
  const bytes = await saveGzipJson(env, objectKey, {
    schemaVersion: 1,
    userId: user.uid,
    savedAt: new Date().toISOString(),
    chats
  });

  return Response.json({ ok: true, savedAt: new Date().toISOString(), bytes });
}
