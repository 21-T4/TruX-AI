import { getBucket, listObjects, copyObject } from '../gcs-store.js';

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
  const current = sources.filter(file => /\/current\.json\.gz$/.test(file.name));
  let copied = 0;

  for (const file of current) {
    const match = file.name.match(/^chat-state\/([^/]+)\/current\.json\.gz$/);
    if (!match) continue;
    await copyObject(env, file.name, `chat-backups/${date}/${match[1]}.json.gz`);
    copied++;
  }

  return Response.json({
    ok: true,
    date,
    accountsBackedUp: copied,
    ranAt: new Date().toISOString()
  });
}
