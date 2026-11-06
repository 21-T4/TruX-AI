/*
 * Client for the trux-sandbox Cloud Run service (bash, curl, Python, Node,
 * headless Chromium). The URL is discovered from the Cloud Run Admin API in
 * the same project and region, and every call carries a Google ID token for
 * this service's account, so no configuration is needed.
 */
import crypto from 'node:crypto';
import { getProjectId, googleApi } from './config.js';

const METADATA = 'http://metadata.google.internal/computeMetadata/v1';
const SERVICE_NAME = 'trux-sandbox';

let urlPromise = null;
let urlCheckedAt = 0;

async function metadataText(path) {
  const response = await fetch(METADATA + path, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error('metadata HTTP ' + response.status);
  return (await response.text()).trim();
}

async function discoverUrl() {
  if (process.env.TRUX_SANDBOX_URL) return process.env.TRUX_SANDBOX_URL.replace(/\/+$/, ''); // local development only
  const [project, regionPath] = await Promise.all([getProjectId(), metadataText('/instance/region')]);
  const region = regionPath.split('/').pop();
  const response = await googleApi(`https://run.googleapis.com/v2/projects/${encodeURIComponent(project)}/locations/${region}/services/${SERVICE_NAME}`, { signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error(response.status === 404 ? 'not deployed' : 'Cloud Run API HTTP ' + response.status);
  const uri = (await response.json())?.uri;
  if (!uri) throw new Error('no URL');
  return uri.replace(/\/+$/, '');
}

export function sandboxUrl() {
  // Re-check every 10 minutes so a newly deployed sandbox is picked up.
  if (!urlPromise || Date.now() - urlCheckedAt > 10 * 60 * 1000) {
    urlCheckedAt = Date.now();
    urlPromise = discoverUrl().catch(error => { console.warn('[sandbox] unavailable:', error?.message || error); return ''; });
  }
  return urlPromise;
}

const tokens = new Map();
async function idToken(audience) {
  const cached = tokens.get(audience);
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  try {
    const value = await metadataText('/instance/service-accounts/default/identity?audience=' + encodeURIComponent(audience) + '&format=full');
    tokens.set(audience, { value, expiresAt: Date.now() + 45 * 60 * 1000 });
    return value;
  } catch { return ''; } // local development: the sandbox runs without a caller check
}

export function sandboxSession(uid, chatId) {
  return crypto.createHash('sha256').update(`${uid}:${chatId || 'incognito'}`).digest('hex').slice(0, 32);
}

export async function callSandbox(route, body, { signal, timeoutMs = 300_000 } = {}) {
  const base = await sandboxUrl();
  if (!base) throw new Error('The sandbox service is not deployed yet. Run the "Google Cloud setup" workflow to deploy it.');
  const token = await idToken(base);
  const response = await fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(data?.error || 'Sandbox HTTP ' + response.status));
  return data;
}
