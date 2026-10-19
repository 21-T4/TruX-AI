import { listObjects, copyObject } from '../gcs-store.js';

function istDateStamp() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const get = key => parts.find(x => x.type === key)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function safeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || !right || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

export async function onRequestPost({ request, env }) {
  const supplied = request.headers.get('x-trux-backup-secret') || '';
  const expected = env.TRUX_BACKUP_SECRET || '';
  if (!expected || !safeEqual(supplied, expected)) {
    return Response.json({ error: 'Not authorized.' }, { status: 401 });
  }

  const date = istDateStamp();
  const sources = await listObjects(env, 'chat-state/');
  const accounts = new Set();
  let objectsBackedUp = 0;

  for (const file of sources) {
    const match = file.name.match(/^chat-state\/([^/]+)\/(.+)$/);
    if (!match) continue;
    const [, uid, relativePath] = match;

    // Back up the new account manifest and per-chat records, while retaining
    // compatibility with accounts that have not migrated the legacy snapshot.
    const supported =
      relativePath === 'manifest.json.gz' ||
      relativePath === 'current.json.gz' ||
      /^chats\/[a-f0-9]{64}\.json\.gz$/.test(relativePath);
    if (!supported) continue;

    const destination = relativePath === 'current.json.gz'
      ? `chat-backups/${date}/${uid}.json.gz`
      : `chat-backups/${date}/${uid}/${relativePath}`;
    await copyObject(env, file.name, destination);
    accounts.add(uid);
    objectsBackedUp++;
  }

  return Response.json({
    ok: true,
    date,
    accountsBackedUp: accounts.size,
    objectsBackedUp,
    ranAt: new Date().toISOString()
  });
}
