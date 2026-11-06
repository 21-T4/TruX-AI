/* Authenticated media download for generated images/videos and uploads.
   The client fetches with its ID token and shows a blob URL. */
import { requireUser } from '../lib/firebase.js';
import { HttpError } from '../lib/http.js';
import { assertOwnedKey, getBucket } from '../lib/storage.js';
import { Readable } from 'node:stream';

async function download(request, { url }) {
  const user = await requireUser(request, { limit: { name: 'media', capacity: 120, refillPerSecond: 2 } });
  const key = assertOwnedKey(user.uid, url.searchParams.get('key'));
  const file = (await getBucket()).file(key);
  const [metadata] = await file.getMetadata().catch(() => { throw new HttpError(404, 'File not found.'); });
  const size = Number(metadata.size || 0);
  const headers = {
    'Content-Type': String(metadata.contentType || 'application/octet-stream'),
    'Cache-Control': 'private, max-age=86400',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    // Files can come from the AI sandbox: never let them run as a page.
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
    'Content-Disposition': /^(image\/(png|jpeg|webp|gif)|video\/|audio\/|application\/pdf)/.test(String(metadata.contentType)) ? 'inline' : 'attachment'
  };
  const range = String(request.headers.get('range') || '').match(/^bytes=(\d*)-(\d*)$/);
  if (range && size) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    return new Response(Readable.toWeb(file.createReadStream({ start, end })), {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) }
    });
  }
  return new Response(Readable.toWeb(file.createReadStream()), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
}

export const routes = { 'GET /api/media': download };
