/*
 * Runtime configuration discovered from the Google Cloud project.
 *
 * Nothing here needs an .env file. On Cloud Run the project ID, access token
 * and Firebase web config all come from the metadata server and Google APIs.
 * Secrets are read from Secret Manager. Plain environment variables still win
 * when set, so local development and overrides keep working.
 */
const METADATA_BASE = 'http://metadata.google.internal/computeMetadata/v1';
const METADATA_HEADERS = { 'Metadata-Flavor': 'Google' };

/* Vertex AI location. Everything runs on the global endpoint except Live,
   because the Live model is only served from regional endpoints. */
export const VERTEX_LOCATION = 'global';
export const LIVE_LOCATION = 'us-central1';

/* Fixed app settings (no environment variables needed). */
export const OWNER_EMAIL = 'ekagraavn2003@gmail.com';
/* Resend's shared sender works without verifying a domain; mail goes to the
   Resend account owner, which is the owner address above. */
export const FEEDBACK_FROM = 'TruX Feedback <onboarding@resend.dev>';

/* The only values TruX reads from Secret Manager (all optional).
   TRUX_SESSION_KEY encrypts the stored sign-in tokens (see lib/session-vault.js). */
export const SECRET_NAMES = ['COMPOSIO_API_KEY', 'RESEND_API_KEY', 'FCM_VAPID_PUBLIC_KEY', 'TRUX_SESSION_KEY'];

/* Firebase web config of project `trux-ai`, the same project TruX Code uses (see its .env.example), so both apps
   share one account. These are public web-app identifiers, not secrets. They are the fallback when the Firebase
   Management API cannot be reached, so sign-in and the Realtime Database no longer depend on that lookup.
   Any FIREBASE_* environment variable overrides the matching value. */
const SHARED_FIREBASE_CONFIG = Object.freeze({
  apiKey: 'AIzaSyAs_GDrzlBaucHfiff0Y6cA8GVHjFTA62Q',
  authDomain: 'trux-ai.firebaseapp.com',
  projectId: 'trux-ai',
  storageBucket: 'trux-ai.firebasestorage.app',
  messagingSenderId: '59313097411',
  appId: '1:59313097411:web:32e4158bfb733fa7cfb076',
  measurementId: 'G-C32LC29QHC'
});

async function metadata(path, timeoutMs = 3000) {
  const response = await fetch(METADATA_BASE + path, {
    headers: METADATA_HEADERS,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error('Metadata server returned HTTP ' + response.status + ' for ' + path);
  return response;
}

let projectPromise = null;
export function getProjectId() {
  const fromEnv = String(process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || '').trim();
  if (fromEnv) return Promise.resolve(fromEnv);
  if (!projectPromise) {
    projectPromise = metadata('/project/project-id')
      .then(r => r.text())
      .then(text => {
        const id = String(text || '').trim();
        if (!id) throw new Error('The metadata server returned an empty project ID.');
        return id;
      })
      .catch(error => { projectPromise = null; throw error; });
  }
  return projectPromise;
}

/* OAuth access token for the Cloud Run service account, cached until shortly
   before it expires. Used for REST calls the SDKs don't cover. */
let tokenCache = { value: '', expiresAt: 0 };
let tokenPromise = null;
export async function getAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  if (!tokenPromise) {
    tokenPromise = (async () => {
      try {
        const response = await metadata('/instance/service-accounts/default/token');
        const data = await response.json();
        if (!data?.access_token) throw new Error('No access token returned.');
        tokenCache = { value: data.access_token, expiresAt: Date.now() + Math.max(60, Number(data.expires_in || 300) - 120) * 1000 };
        return tokenCache.value;
      } catch (metadataError) {
        // Local development fallback: Application Default Credentials.
        const { GoogleAuth } = await import('google-auth-library');
        const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
        const token = await auth.getAccessToken();
        if (!token) throw metadataError;
        tokenCache = { value: token, expiresAt: Date.now() + 30 * 60 * 1000 };
        return token;
      }
    })().finally(() => { tokenPromise = null; });
  }
  return tokenPromise;
}

export async function googleApi(url, init = {}) {
  const token = await getAccessToken();
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', 'Bearer ' + token);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(url, { ...init, headers });
}

/* ---------- Secret Manager ---------- */
const secretCache = new Map();
const SECRET_TTL_MS = 10 * 60 * 1000;

async function readSecret(name) {
  const fromEnv = String(process.env[name] || '').trim();
  if (fromEnv) return fromEnv;
  const cached = secretCache.get(name);
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  let value = '';
  try {
    const project = await getProjectId();
    const response = await googleApi(
      `https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(project)}/secrets/${encodeURIComponent(name)}/versions/latest:access`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (response.ok) {
      const data = await response.json();
      value = Buffer.from(String(data?.payload?.data || ''), 'base64').toString('utf8').trim();
    } else if (response.status !== 404) {
      console.warn('[config] Secret Manager returned HTTP ' + response.status + ' for ' + name);
    }
  } catch (error) {
    console.warn('[config] Could not read secret ' + name + ':', error?.message || error);
  }
  // Cache misses briefly so a newly created secret is picked up quickly.
  secretCache.set(name, { value, expiresAt: Date.now() + (value ? SECRET_TTL_MS : 60 * 1000) });
  return value;
}

/* ---------- Firebase web config (Firebase Management API) ---------- */
let firebaseConfigPromise = null;
let firebaseConfigValue = null;

async function discoverFirebaseWebConfig() {
  const project = await getProjectId();
  const base = 'https://firebase.googleapis.com/v1beta1/projects/' + encodeURIComponent(project);
  let config = {};
  try {
    const appsResponse = await googleApi(base + '/webApps?pageSize=20', { signal: AbortSignal.timeout(6000) });
    if (!appsResponse.ok) throw new Error('webApps HTTP ' + appsResponse.status);
    const apps = (await appsResponse.json())?.apps || [];
    const app = apps.find(a => a.state === 'ACTIVE') || apps[0];
    if (!app) throw new Error('No Firebase web app is registered in this project.');
    const configResponse = await googleApi(base + '/webApps/' + encodeURIComponent(app.appId) + '/config', { signal: AbortSignal.timeout(6000) });
    if (!configResponse.ok) throw new Error('webApp config HTTP ' + configResponse.status);
    config = await configResponse.json();
  } catch (error) {
    console.warn('[config] Firebase web config discovery failed:', error?.message || error);
  }
  // Order of precedence: FIREBASE_* environment variable, then what the project reports, then the shared TruX
  // project config (only when this really is that project).
  const shared = project === SHARED_FIREBASE_CONFIG.projectId ? SHARED_FIREBASE_CONFIG : {};
  const pick = (envName, discovered, fallback) => String(process.env[envName] || '').trim() || discovered || fallback || '';
  const merged = {
    apiKey: pick('FIREBASE_API_KEY', config.apiKey, shared.apiKey),
    authDomain: pick('FIREBASE_AUTH_DOMAIN', config.authDomain, shared.authDomain || `${project}.firebaseapp.com`),
    projectId: project,
    storageBucket: pick('FIREBASE_STORAGE_BUCKET', config.storageBucket, shared.storageBucket || `${project}.firebasestorage.app`),
    messagingSenderId: pick('FIREBASE_MESSAGING_SENDER_ID', config.messagingSenderId, shared.messagingSenderId),
    appId: pick('FIREBASE_APP_ID', config.appId, shared.appId),
    measurementId: pick('FIREBASE_MEASUREMENT_ID', config.measurementId, shared.measurementId),
    // A database created outside us-central1 has a regional URL, so the project's own answer wins over the guess.
    databaseURL: pick('FIREBASE_DATABASE_URL', config.databaseURL, `https://${project}-default-rtdb.firebaseio.com`)
  };
  if (!merged.apiKey) throw new Error('Firebase web config is unavailable. Set FIREBASE_API_KEY, or grant the Cloud Run service account the Firebase Viewer role.');
  return merged;
}

export function getFirebaseWebConfig() {
  if (firebaseConfigValue) return Promise.resolve(firebaseConfigValue);
  if (!firebaseConfigPromise) {
    firebaseConfigPromise = discoverFirebaseWebConfig()
      .then(value => (firebaseConfigValue = value))
      .catch(error => { firebaseConfigPromise = null; throw error; });
  }
  return firebaseConfigPromise;
}

/* The database URL is needed by firebase-admin before the web config is ready. */
export async function getDatabaseUrl() {
  try { return (await getFirebaseWebConfig()).databaseURL; }
  catch { return `https://${await getProjectId()}-default-rtdb.firebaseio.com`; }
}

export async function getBucketName() {
  return `${await getProjectId()}-bucket`;
}

/*
 * The env object handed to every route. It mirrors process.env and adds
 * secrets from Secret Manager, so handlers read env.COMPOSIO_API_KEY etc.
 */
let envPromise = null;
let envBuiltAt = 0;
export async function getRuntimeEnv() {
  if (!envPromise || Date.now() - envBuiltAt > SECRET_TTL_MS) {
    envBuiltAt = Date.now();
    envPromise = (async () => {
      const [project, bucket, ...secrets] = await Promise.all([
        getProjectId(),
        getBucketName(),
        ...SECRET_NAMES.map(readSecret)
      ]);
      const env = { ...process.env, GOOGLE_CLOUD_PROJECT: project, TRUX_BUCKET_NAME: bucket };
      SECRET_NAMES.forEach((name, i) => { if (secrets[i]) env[name] = secrets[i]; });
      return Object.freeze(env);
    })().catch(error => { envPromise = null; throw error; });
  }
  return envPromise;
}
