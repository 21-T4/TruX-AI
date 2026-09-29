import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getBucket, userFileKey } from '../../gcs-store.js';
import { requireFirebaseUser } from '../../firebase-auth.js';

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export async function onRequestPost({ request, env }) {
  const user = await requireFirebaseUser(request, env);
  const name = decodeURIComponent(String(request.headers.get('x-trux-file-name') || 'upload.bin')).slice(0, 200);
  const mimeType = String(request.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
  const declaredSize = Number(request.headers.get('content-length') || 0);

  if (!request.body) {
    return Response.json({ error: 'File body is missing.' }, { status: 400 });
  }
  if (declaredSize > MAX_UPLOAD_BYTES) {
    return Response.json({ error: 'Files are limited to 100 MB.' }, { status: 413 });
  }

  const objectKey = userFileKey(user.uid, name);
  const target = getBucket(env).file(objectKey);
  let total = 0;

  const limiter = new Transform({
    transform(chunk, enc, callback) {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES) {
        callback(new Error('Files are limited to 100 MB.'));
        return;
      }
      callback(null, chunk);
    }
  });

  try {
    await pipeline(
      Readable.fromWeb(request.body),
      limiter,
      target.createWriteStream({
        resumable: false,
        validation: 'crc32c',
        metadata: {
          contentType: mimeType,
          metadata: { ownerUid: user.uid, originalName: name }
        }
      })
    );
  } catch (error) {
    try { await target.delete({ ignoreNotFound: true }); } catch {}
    const status = /limited to 100 MB/i.test(String(error?.message)) ? 413 : 500;
    return Response.json({ error: status === 413 ? error.message : 'Upload failed.' }, { status });
  }

  return Response.json({
    ok: true,
    objectKey,
    name,
    size: total,
    mimeType
  });
}
