/* Google sign-in for the TruX Android app.
 *
 * Google blocks its sign-in page inside embedded WebViews, so the app opens
 * /native-auth.html in a Chrome Custom Tab. That page signs in normally and
 * hands the Google ID token to the server under a one-time `state`, then
 * returns to the app via truxai://auth?state=…  The app redeems the state
 * with the PKCE verifier only it knows (sha256(verifier) must equal the
 * challenge it put in the URL), so an app that intercepts the redirect can't
 * use it. Entries live for 3 minutes in _server/nativeAuth (no client access). */
import crypto from 'node:crypto';
import { getDb, requireUser } from '../lib/firebase.js';
import { HttpError, json, NO_STORE, readJson } from '../lib/http.js';
import { rateLimit } from '../lib/ratelimit.js';

const TTL_MS = 3 * 60 * 1000;
const STATE_RE = /^[A-Za-z0-9_-]{32,96}$/;

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function handoff(request) {
  const user = await requireUser(request, { limit: { name: 'native-auth', capacity: 10, refillPerSecond: 0.1 } });
  const body = await readJson(request, 16 * 1024);
  const state = String(body?.state || '');
  const challenge = String(body?.challenge || '');
  const googleIdToken = String(body?.googleIdToken || '');
  if (!STATE_RE.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new HttpError(400, 'Invalid sign-in request.');
  if (!googleIdToken || googleIdToken.length > 4096 || googleIdToken.split('.').length !== 3) throw new HttpError(400, 'Google did not return a sign-in token.');
  const db = await getDb();
  const ref = db.ref('_server/nativeAuth/' + state);
  const existing = await ref.get();
  if (existing.exists()) throw new HttpError(409, 'This sign-in link was already used.');
  await ref.set({ challenge, googleIdToken, uid: user.uid, expiresAt: Date.now() + TTL_MS });
  return json({ ok: true }, 200, NO_STORE);
}

async function redeem(request) {
  const ip = String(request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'anon';
  if (!rateLimit('native-redeem:' + ip, { capacity: 10, refillPerSecond: 0.2 })) throw new HttpError(429, 'Too many attempts. Wait a moment.');
  const body = await readJson(request, 8 * 1024);
  const state = String(body?.state || '');
  const verifier = String(body?.verifier || '');
  if (!STATE_RE.test(state) || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) throw new HttpError(400, 'Invalid sign-in request.');
  const db = await getDb();
  const ref = db.ref('_server/nativeAuth/' + state);
  let entry = null;
  // Read-and-delete atomically so a state can be redeemed once.
  await ref.transaction(current => { entry = current; return null; });
  if (!entry) throw new HttpError(404, 'Sign-in expired. Please try again.');
  const expected = b64url(crypto.createHash('sha256').update(verifier).digest());
  const a = Buffer.from(expected), b = Buffer.from(String(entry.challenge || ''));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(403, 'Sign-in could not be verified.');
  if (Date.now() > Number(entry.expiresAt || 0)) throw new HttpError(410, 'Sign-in expired. Please try again.');
  return json({ googleIdToken: entry.googleIdToken }, 200, NO_STORE);
}

export const routes = {
  'POST /api/native-auth/handoff': handoff,
  'POST /api/native-auth/redeem': redeem
};
