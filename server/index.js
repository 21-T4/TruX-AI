/*
 * TruX AI — Cloud Run entry point.
 * Bridges node:http to Fetch-style route handlers, serves the static app
 * with security headers, and hosts the Live WebSocket.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { getRuntimeEnv } from './lib/config.js';
import { errorResponse, HttpError } from './lib/http.js';
import { getAdminApp } from './lib/firebase.js';
import { handleLiveUpgrade } from './live.js';
import { routes as chatRoutes } from './routes/chat.js';
import { routes as configRoutes } from './routes/config.js';
import { routes as feedbackRoutes } from './routes/feedback.js';
import { routes as fileRoutes } from './routes/files.js';
import { routes as homeRoutes } from './routes/home.js';
import { routes as mediaRoutes } from './routes/media.js';
import { routes as modelRoutes } from './routes/models.js';
import { routes as nativeAuthRoutes } from './routes/native-auth.js';
import { routes as pluginRoutes } from './routes/plugins.js';
import { routes as pushRoutes } from './routes/push.js';
import { routes as ttsRoutes } from './routes/tts.js';

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ROUTES = {
  ...chatRoutes, ...configRoutes, ...feedbackRoutes, ...fileRoutes, ...homeRoutes,
  ...mediaRoutes, ...modelRoutes, ...pluginRoutes, ...pushRoutes, ...ttsRoutes, ...nativeAuthRoutes
};
const STREAMED_BODY = new Set(['POST /api/files/upload']);
const MAX_BODY = 512 * 1024;

const CSP = [
  "default-src 'self'",
  // Inline handlers in the app markup still need 'unsafe-inline'; sources stay pinned.
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://www.gstatic.com https://apis.google.com https://accounts.google.com https://*.firebaseio.com https://*.firebasedatabase.app",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: data:",
  "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com https://*.firebasedatabase.app wss://*.firebasedatabase.app https://cdn.jsdelivr.net https://www.gstatic.com",
  "frame-src 'self' blob: data: https://*.firebaseapp.com https://*.web.app https://accounts.google.com https://apis.google.com https://backend.composio.dev",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Google sign-in popups need same-origin-allow-popups.
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(self), display-capture=(self)',
  'X-Frame-Options': 'DENY'
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json'
};

function origin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

async function readLimited(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function writeResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) return res.end();
  const reader = response.body.getReader();
  res.on('close', () => { if (!res.writableEnded) reader.cancel().catch(() => {}); });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise(resolve => res.once('drain', resolve).once('close', resolve));
      if (res.destroyed) break;
    }
  } catch {}
  res.end();
}

async function handleApi(req, res, url) {
  const key = `${req.method === 'HEAD' ? 'GET' : req.method} ${url.pathname}`;
  const handler = ROUTES[key];
  if (!handler) {
    const exists = Object.keys(ROUTES).some(k => k.endsWith(' ' + url.pathname));
    return writeResponse(res, errorResponse(new HttpError(exists ? 405 : 404, exists ? 'Method not allowed.' : 'Not found.')));
  }
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    const sameOrigin = !req.headers.origin || req.headers.origin === origin(req);
    if (req.method !== 'GET' && !sameOrigin) throw new HttpError(403, 'Cross-origin requests are not allowed.');
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      body = STREAMED_BODY.has(key) ? Readable.toWeb(req) : await readLimited(req, MAX_BODY);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (value != null) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    const request = new Request(url, { method: req.method, headers, body, signal: controller.signal, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) });
    const env = await getRuntimeEnv();
    const response = await handler(request, { env, url });
    await writeResponse(res, response);
  } catch (error) {
    if (controller.signal.aborted) { try { res.end(); } catch {} return; }
    await writeResponse(res, errorResponse(error));
  }
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { res.statusCode = 400; return res.end('Bad Request'); }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) || relative.split('/').some(p => p.startsWith('.'))) { res.statusCode = 404; return res.end('Not Found'); }
  let stat;
  try { stat = await fs.promises.stat(filePath); if (!stat.isFile()) throw new Error(); }
  catch {
    // Unknown extension-less paths are app routes; missing assets stay 404.
    if (!path.extname(relative)) return serveStatic(req, res, new URL('/', url));
    res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.end('Not Found');
  }
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath);
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('Content-Length', stat.size);
  if (ext === '.html' || ext === '.js' || ext === '.css' || base === 'manifest.json') res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  else res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) { res.statusCode = 304; return res.end(); }
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  let url;
  try { url = new URL(req.url || '/', origin(req)); } catch { res.statusCode = 400; return res.end(); }
  if (url.pathname === '/healthz') { res.statusCode = 200; return res.end('ok'); }
  if (url.pathname === '/download/android') {
    // Latest signed APK built by .github/workflows/android.yml.
    res.statusCode = 302;
    res.setHeader('Location', process.env.TRUX_ANDROID_APK_URL || 'https://github.com/21-T4/TruX-AI/releases/latest/download/TruX-AI.apk');
    res.setHeader('Cache-Control', 'no-store');
    return res.end();
  }
  if (url.pathname === '/.well-known/assetlinks.json' && process.env.TRUX_ANDROID_SHA256) {
    // Lets Android verify https links for the TruX app (optional).
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify([{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: 'ai.trux.assistant', sha256_cert_fingerprints: [process.env.TRUX_ANDROID_SHA256] } }]));
  }
  if (url.pathname.startsWith('/api/')) return void handleApi(req, res, url);
  return void serveStatic(req, res, url);
});

// Long AI streams are bounded by Cloud Run's request timeout, not Node's.
server.requestTimeout = 0;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 620_000;
server.on('upgrade', (req, socket, head) => {
  const pathname = (() => { try { return new URL(req.url || '/', 'http://x').pathname; } catch { return ''; } })();
  if (pathname !== '/api/live') { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
  handleLiveUpgrade(req, socket, head);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`TruX AI listening on ${PORT}`);
  // Warm up credentials, secrets and Firebase Admin so the first user request is fast.
  Promise.all([getRuntimeEnv(), getAdminApp()]).catch(error => console.warn('[startup] warm-up failed:', error?.message));
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { server.close(); setTimeout(() => process.exit(0), 8000).unref(); });
}
