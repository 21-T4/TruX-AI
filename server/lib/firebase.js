/*
 * Firebase Admin: one default app for the whole server, built from the
 * project's own credentials. Auth verification is local (cached Google
 * public keys) plus a short in-memory cache, so it adds ~0 ms per request.
 */
import crypto from 'node:crypto';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';
import { getMessaging } from 'firebase-admin/messaging';
import { getProjectId, getDatabaseUrl, OWNER_EMAIL } from './config.js';
import { HttpError } from './http.js';
import { rateLimit } from './ratelimit.js';

let appPromise = null;
export function getAdminApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const existing = getApps().find(app => app.name === '[DEFAULT]');
      if (existing) return existing;
      const [projectId, databaseURL] = await Promise.all([getProjectId(), getDatabaseUrl()]);
      return initializeApp({ credential: applicationDefault(), projectId, databaseURL });
    })().catch(error => { appPromise = null; throw error; });
  }
  return appPromise;
}

export async function getDb() { return getDatabase(await getAdminApp()); }
export async function getAdminMessaging() { return getMessaging(await getAdminApp()); }

/* ---------- ID token verification ---------- */
const tokenCache = new Map(); // sha256(token) -> { user, expiresAt }
const MAX_CACHE = 5000;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('base64url');
}

function toIdentity(decoded) {
  const provider = String(decoded?.firebase?.sign_in_provider || '');
  const email = String(decoded?.email || '').toLowerCase();
  return {
    uid: String(decoded.uid),
    email,
    emailVerified: decoded.email_verified === true,
    name: String(decoded.name || ''),
    provider,
    owner: !!email && email === OWNER_EMAIL && decoded.email_verified === true,
    tier: String(decoded.truxTier || '').toLowerCase() === 'pro' ? 'pro' : 'base',
    authTime: Number(decoded.auth_time || 0),
    exp: Number(decoded.exp || 0)
  };
}

/**
 * Verifies a Firebase ID token.
 * checkRevoked=true makes a network call; use it only for sensitive actions.
 */
export async function verifyToken(token, { checkRevoked = false } = {}) {
  if (typeof token !== 'string' || token.length < 100 || token.length > 4096) {
    throw new HttpError(401, 'Authentication required.');
  }
  const key = hashToken(token);
  const cached = tokenCache.get(key);
  if (!checkRevoked && cached && cached.expiresAt > Date.now()) return cached.user;

  let decoded;
  try {
    decoded = await getAuth(await getAdminApp()).verifyIdToken(token, checkRevoked);
  } catch (error) {
    tokenCache.delete(key);
    const revoked = /revoked|disabled/i.test(String(error?.code || error?.message));
    throw new HttpError(401, revoked ? 'Your session was signed out. Please sign in again.' : 'Your session expired. Please sign in again.', { code: 'auth/invalid-token' });
  }
  const user = toIdentity(decoded);
  // Password accounts must verify their email before using the app.
  if (user.provider === 'password' && !user.emailVerified) {
    throw new HttpError(403, 'Please verify your email address before continuing.', { code: 'auth/email-not-verified' });
  }
  if (user.provider === 'anonymous' || !user.provider) {
    throw new HttpError(403, 'Sign in with email or Google to continue.');
  }
  if (tokenCache.size >= MAX_CACHE) tokenCache.delete(tokenCache.keys().next().value);
  // Cache at most 5 minutes so a disabled account loses access quickly.
  tokenCache.set(key, { user, expiresAt: Math.min(user.exp * 1000, Date.now() + 5 * 60 * 1000) });
  return user;
}

export function bearerToken(request) {
  const header = String(request.headers.get('authorization') || '');
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : '';
}

/** Verifies the request and applies a per-user rate limit. */
export async function requireUser(request, { checkRevoked = false, limit = null } = {}) {
  const user = await verifyToken(bearerToken(request), { checkRevoked });
  if (limit && !rateLimit(user.uid + ':' + limit.name, limit)) {
    throw new HttpError(429, 'You are sending requests too quickly. Please wait a moment.');
  }
  return user;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of tokenCache) if (entry.expiresAt <= now) tokenCache.delete(key);
}, 60 * 1000).unref();
