/*
 * Encrypted sign-in tokens.
 *
 * After every new sign-in the browser sends its fresh Firebase ID token to POST /api/session/login. The server
 * verifies it, seals it with AES-256-GCM and stores only the sealed text at _server/sessions/{uid}/{sessionId}
 * (a path the database rules keep closed to every client). The token is opened again, in memory only, when the
 * server needs to check it (see POST /api/session/verify); the plain token is never written anywhere.
 *
 * Key: TRUX_SESSION_KEY (Secret Manager or environment, at least 32 characters) is the master key. Each user and
 * each sign-in gets its own key derived from it with HKDF, and the user id and session id are bound into the
 * ciphertext, so a sealed token copied to another user's record or another sign-in does not open.
 *   openssl rand -base64 32 | gcloud secrets create TRUX_SESSION_KEY --data-file=-
 * Without it the server creates one random key on first use and keeps it at _server/vault/sessionKey. That still
 * encrypts every token, but the key then sits in the same database as the data, so the Secret Manager key is the
 * stronger setup and always wins when present.
 */
import crypto from 'node:crypto';
import { getRuntimeEnv } from './config.js';
import { getDb } from './firebase.js';

const SEALED_VERSION = 'v1';
const KEEP_SESSIONS = 5;
const RETAIN_MS = 24 * 60 * 60 * 1000;

let fallbackKey = '';
let fallbackPromise = null;

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function loadFallbackKey() {
  const ref = (await getDb()).ref('_server/vault/sessionKey');
  const result = await ref.transaction(current => (typeof current === 'string' && current.length >= 32 ? undefined : crypto.randomBytes(48).toString('base64url')));
  const value = result.snapshot.val();
  if (typeof value !== 'string' || value.length < 32) throw new Error('Could not create the session encryption key.');
  console.warn('[session] TRUX_SESSION_KEY is not set: using a server-generated key stored in the database. Set it from Secret Manager for stronger protection.');
  return value;
}

async function masterKey() {
  const env = await getRuntimeEnv();
  const configured = String(env.TRUX_SESSION_KEY || '').trim();
  if (configured.length >= 32) return configured;
  if (fallbackKey) return fallbackKey;
  if (!fallbackPromise) fallbackPromise = loadFallbackKey().then(key => (fallbackKey = key)).catch(error => { fallbackPromise = null; throw error; });
  return fallbackPromise;
}

async function keyFor(uid, sessionId) {
  const master = Buffer.from(await masterKey(), 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from(String(uid)), Buffer.from('trux-session:' + sessionId), 32));
}

/* One id per sign-in: the same sign-in always maps to the same id, a new sign-in to a new one. */
export function sessionIdFor(uid, authTime) {
  return crypto.createHash('sha256').update(`${uid}:${Number(authTime) || 0}`).digest('hex').slice(0, 24);
}

export async function encryptToken(uid, sessionId, token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', await keyFor(uid, sessionId), iv);
  cipher.setAAD(Buffer.from(`${uid}:${sessionId}`));
  const body = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  return [SEALED_VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export async function decryptToken(uid, sessionId, sealed) {
  const parts = String(sealed || '').split('.');
  if (parts.length !== 4 || parts[0] !== SEALED_VERSION) throw codedError('session/unreadable', 'The saved sign-in could not be read.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', await keyFor(uid, sessionId), Buffer.from(parts[1], 'base64url'));
    decipher.setAAD(Buffer.from(`${uid}:${sessionId}`));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw codedError('session/unreadable', 'The saved sign-in could not be decrypted.');
  }
}

/* Seals and stores the token for this sign-in, drops older records, and reads it back to prove it round-trips. */
export async function storeSignIn(user, token) {
  const sessionId = sessionIdFor(user.uid, user.authTime);
  const sealed = await encryptToken(user.uid, sessionId, token);
  const now = Date.now();
  const db = await getDb();
  const base = db.ref(`_server/sessions/${user.uid}`);
  await base.child(sessionId).set({
    sealed,
    provider: user.provider || '',
    authTime: user.authTime || 0,
    tokenExp: user.exp || 0,
    createdAt: now,
    expiresAt: now + RETAIN_MS
  });

  const all = (await base.get()).val() || {};
  const stale = Object.entries(all)
    .filter(([id, record]) => id !== sessionId && (Number(record?.expiresAt) <= now))
    .map(([id]) => id);
  const live = Object.entries(all).filter(([id]) => id !== sessionId && !stale.includes(id))
    .sort((a, b) => (Number(b[1]?.createdAt) || 0) - (Number(a[1]?.createdAt) || 0));
  for (const [id] of live.slice(KEEP_SESSIONS - 1)) stale.push(id);
  if (stale.length) await base.update(Object.fromEntries(stale.map(id => [id, null])));

  const roundTrip = await decryptToken(user.uid, sessionId, sealed);
  return { sessionId, roundTrip: roundTrip === String(token), expiresAt: now + RETAIN_MS };
}

/* Opens the sealed token of one sign-in. Returns null when there is no such record. */
export async function openSignIn(uid, sessionId) {
  if (!/^[a-f0-9]{24}$/.test(String(sessionId || ''))) return null;
  const record = (await (await getDb()).ref(`_server/sessions/${uid}/${sessionId}`).get()).val();
  if (!record?.sealed) return null;
  if (Number(record.expiresAt) <= Date.now()) return null;
  return { token: await decryptToken(uid, sessionId, record.sealed), record };
}

export async function clearSignIns(uid) {
  await (await getDb()).ref(`_server/sessions/${uid}`).remove();
}
