import { migrateAllBucketChats } from './chat-sync.js';

function safeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

// Compatibility route for an existing scheduled caller. It no longer writes
// backups to Cloud Storage; it performs a one-time, account-scoped migration.
export async function onRequestPost({ request, env }) {
  const supplied = request.headers.get('x-trux-backup-secret') || '';
  const expected = env.TRUX_BACKUP_SECRET || '';
  if (!expected || !safeEqual(supplied, expected)) {
    return Response.json({ error: 'Not authorized.' }, {
      status: 401,
      headers: { 'Cache-Control': 'no-store' }
    });
  }

  try {
    const result = await migrateAllBucketChats(env);
    return Response.json({
      ok: true,
      storage: 'firestore',
      cloudStorageChatBackups: 'disabled',
      ...result
    }, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store, no-cache, max-age=0',
        'Content-Type': 'application/json; charset=utf-8'
      }
    });
  } catch (error) {
    console.warn('[chat-backup] Account chat migration did not finish:', String(error?.message || error));
    return Response.json({
      ok: false,
      storage: 'firestore',
      error: 'Legacy chat migration is incomplete. Records that could not be verified were preserved for recovery.'
    }, {
      status: 503,
      headers: {
        'Cache-Control': 'no-store, no-cache, max-age=0',
        'Content-Type': 'application/json; charset=utf-8'
      }
    });
  }
}
