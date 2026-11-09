/* Encrypted sign-in tokens (see lib/session-vault.js).
 *   POST /api/session/login   seal and store the token of a fresh sign-in
 *   POST /api/session/verify  open the stored token of this sign-in and check it still belongs to the caller
 *   POST /api/session/logout  forget every stored sign-in of the caller
 */
import { bearerToken, requireUser, verifyToken } from '../lib/firebase.js';
import { HttpError, json, readJson } from '../lib/http.js';
import { clearSignIns, openSignIn, sessionIdFor, storeSignIn } from '../lib/session-vault.js';

// A sign-in counts as new for this long after Firebase issued it.
const FRESH_SECONDS = 10 * 60;

async function login(request) {
  const user = await requireUser(request, { checkRevoked: true, limit: { name: 'session-login', capacity: 10, refillPerSecond: 0.1 } });
  const age = Math.floor(Date.now() / 1000) - user.authTime;
  if (!user.authTime || age > FRESH_SECONDS || age < -60) {
    throw new HttpError(401, 'Sign in again so this device can be remembered securely.', { code: 'auth/recent-login-required' });
  }
  const result = await storeSignIn(user, bearerToken(request));
  if (!result.roundTrip) throw new HttpError(500, 'The sign-in could not be stored securely.');
  return json({ stored: true, sessionId: result.sessionId, expiresAt: result.expiresAt });
}

async function verify(request) {
  const user = await requireUser(request);
  const body = await readJson(request, 4096);
  const sessionId = String(body.sessionId || sessionIdFor(user.uid, user.authTime));
  const opened = await openSignIn(user.uid, sessionId).catch(() => null);
  if (!opened) return json({ valid: false, reason: 'not-found' });
  // The stored token must still be a genuine token of the same account.
  const stored = await verifyToken(opened.token).catch(() => null);
  if (!stored) return json({ valid: false, reason: 'token-expired' });
  if (stored.uid !== user.uid) return json({ valid: false, reason: 'account-mismatch' });
  return json({ valid: true, sessionId, authTime: stored.authTime });
}

async function logout(request) {
  const user = await requireUser(request);
  await clearSignIns(user.uid);
  return json({ cleared: true });
}

export const routes = {
  'POST /api/session/login': login,
  'POST /api/session/verify': verify,
  'POST /api/session/logout': logout
};
