/* Cloud Run GitHub OAuth/session cookies.
   Keeps OAuth state and the GitHub token in authenticated, HttpOnly cookies,
   so GitHub connection does not depend on a Cloudflare KV binding. */

const STATE_MAX_AGE = 10 * 60;
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

function bytesToBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function cryptoKey(env) {
  const secret = String(env.GIT_CLIENT_SECRET || '').trim();
  if (!secret) throw new Error('GIT_CLIENT_SECRET is not configured.');

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey(
    'raw',
    digest,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

async function seal(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await cryptoKey(env);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return bytesToBase64Url(iv) + '.' + bytesToBase64Url(new Uint8Array(ciphertext));
}

async function open(env, value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 2) return null;
  try {
    const key = await cryptoKey(env);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlToBytes(parts[0]) },
      key,
      base64UrlToBytes(parts[1])
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
}

function cookieValue(request, name) {
  const prefix = name + '=';
  return (request.headers.get('Cookie') || '')
    .split(';')
    .map(v => v.trim())
    .find(v => v.startsWith(prefix))
    ?.slice(prefix.length) || '';
}

function cookieHeader(name, value, maxAge, request) {
  const forwardedProto = String(request.headers.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  const protocol = forwardedProto || new URL(request.url).protocol;
  const secure = protocol === 'https:' ? '; Secure' : '';
  return name + '=' + value + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAge + secure;
}

export async function createOAuthStateCookie(env, state, returnTo, redirectUri, request) {
  const value = await seal(env, {
    state: String(state),
    returnTo: typeof returnTo === 'string' ? returnTo : '/',
    redirectUri: String(redirectUri || ''),
    exp: Date.now() + STATE_MAX_AGE * 1000
  });
  return cookieHeader('trux_github_oauth', value, STATE_MAX_AGE, request);
}

export async function readOAuthState(request, env) {
  const value = cookieValue(request, 'trux_github_oauth');
  if (!value) return null;
  const data = await open(env, value);
  if (!data || !data.exp || data.exp < Date.now() || !data.state) return null;
  return data;
}

export function clearOAuthStateCookie(request) {
  return cookieHeader('trux_github_oauth', '', 0, request);
}

export async function createGithubSessionCookie(env, session, request) {
  const value = await seal(env, {
    token: String(session?.token || ''),
    login: String(session?.login || ''),
    exp: Date.now() + SESSION_MAX_AGE * 1000
  });
  return cookieHeader('trux_github_session', value, SESSION_MAX_AGE, request);
}

export async function getGithubSession(request, env) {
  const value = cookieValue(request, 'trux_github_session');
  if (!value) return null;
  const data = await open(env, value);
  if (!data || !data.token || !data.exp || data.exp < Date.now()) return null;
  return {
    token: String(data.token),
    login: String(data.login || '')
  };
}

export function clearGithubSessionCookie(request) {
  return cookieHeader('trux_github_session', '', 0, request);
}
