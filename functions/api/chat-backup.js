// Chat history now lives in account-scoped Firestore documents.
// This route remains as a compatibility no-op for any older scheduled caller.
export async function onRequestPost() {
  return Response.json({
    ok: true,
    skipped: true,
    storage: 'firestore',
    message: 'Cloud Storage chat backups are disabled.'
  }, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store, no-cache, max-age=0',
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}
