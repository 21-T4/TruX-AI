/* Cloud Run state adapter: replaces Cloudflare KV for this Node/Cloud Run runtime. */
let cachedAccessToken = null;
let cachedTokenExpiry = 0;
const memory = new Map();
let firestoreRetryAfter = 0;

function base64UrlEncode(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function pemToArrayBuffer(pem) {
  const clean = String(pem || '')
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function cloudProjectId(env) {
  const configured = String(
    env.GCP_PROJECT_ID ||
    env.GOOGLE_CLOUD_PROJECT ||
    env.GCLOUD_PROJECT ||
    env.PROJECT_ID ||
    ''
  ).trim();

  if (configured) return configured;

  if (env.K_SERVICE || env.K_REVISION || env.K_CONFIGURATION) {
    const metadataUrls = [
      'http://metadata.google.internal/computeMetadata/v1/project/project-id',
      'http://169.254.169.254/computeMetadata/v1/project/project-id'
    ];

    for (const url of metadataUrls) {
      try {
        const response = await fetch(url, {
          headers: { 'Metadata-Flavor': 'Google' }
        });

        if (response.ok) {
          const value = (await response.text()).trim();
          if (value) return value;
        }
      } catch {
        // Try the next metadata endpoint.
      }
    }
  }

  return '';
}

async function googleAccessToken(env) {
  if (cachedAccessToken && Date.now() < cachedTokenExpiry - 60000) return cachedAccessToken;

  // On Cloud Run, use the attached service account through the metadata
  // server first. The explicit JWT credentials remain as a fallback.
  const metadataUrls = [
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token'
  ];

  if (env.K_SERVICE || env.K_REVISION || env.K_CONFIGURATION) {
    for (const url of metadataUrls) {
      try {
        const response = await fetch(url, {
          headers: { 'Metadata-Flavor': 'Google' }
        });
        if (response.ok) {
          const data = await response.json();
          if (data?.access_token) {
            cachedAccessToken = data.access_token;
            cachedTokenExpiry = Date.now() + ((Number(data.expires_in) || 3600) * 1000);
            return cachedAccessToken;
          }
        }
      } catch {
        // Fall through to the explicit service-account credentials.
      }
    }
  }

  const clientEmail = String(env.GCP_CLIENT_EMAIL || env.GOOGLE_CLIENT_EMAIL || '').trim();
  const privateKey = String(env.GCP_PRIVATE_KEY || env.GOOGLE_PRIVATE_KEY || '');
  if (!clientEmail || !privateKey) throw new Error('Google credentials are unavailable for Cloud Run state storage.');

  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64UrlEncode(JSON.stringify({
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const unsigned = header + '.' + claims;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    await pemToArrayBuffer(privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned)
  );

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + base64UrlEncode(signature)
    }).toString()
  });
  if (!response.ok) throw new Error('Google authentication failed while opening Cloud Run state storage.');
  const data = await response.json();
  cachedAccessToken = data.access_token;
  cachedTokenExpiry = Date.now() + ((data.expires_in || 3600) * 1000);
  return cachedAccessToken;
}

async function docId(key) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(key)));
  return base64UrlEncode(new Uint8Array(digest)).slice(0, 48);
}

function memoryGet(key) {
  const entry = memory.get(key);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt <= Date.now()) {
    memory.delete(key);
    return null;
  }
  return entry.value;
}

function memoryPut(key, value, options = {}) {
  const ttl = Number(options?.expirationTtl || 0);
  memory.set(key, {
    value: String(value),
    expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : 0
  });
}

async function firestoreGet(env, key) {
  const projectId = await cloudProjectId(env);
  if (!projectId || Date.now() < firestoreRetryAfter) return null;
  const token = await googleAccessToken(env);
  const id = await docId(key);
  const url = 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(projectId) +
    '/databases/(default)/documents/trux_kv/' + encodeURIComponent(id);
  const response = await fetch(url, {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Cloud Run state storage returned HTTP ' + response.status + '.');
  const document = await response.json();
  const fields = document?.fields || {};
  const expiresAt = fields.expiresAt?.timestampValue ? Date.parse(fields.expiresAt.timestampValue) : 0;
  if (expiresAt && expiresAt <= Date.now()) {
    await firestoreDelete(env, key);
    return null;
  }
  return fields.value?.stringValue ?? null;
}

async function firestorePut(env, key, value, options = {}) {
  const projectId = await cloudProjectId(env);
  if (!projectId || Date.now() < firestoreRetryAfter) return false;
  const token = await googleAccessToken(env);
  const id = await docId(key);
  const ttl = Number(options?.expirationTtl || 0);
  const fields = {
    value: { stringValue: String(value) }
  };
  if (ttl > 0) fields.expiresAt = { timestampValue: new Date(Date.now() + ttl * 1000).toISOString() };

  const url = 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(projectId) +
    '/databases/(default)/documents/trux_kv/' + encodeURIComponent(id);
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });
  if (!response.ok) throw new Error('Cloud Run state storage returned HTTP ' + response.status + '.');
  return true;
}

async function firestoreDelete(env, key) {
  const projectId = await cloudProjectId(env);
  if (!projectId || firestoreDisabled) return false;
  const token = await googleAccessToken(env);
  const id = await docId(key);
  const url = 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(projectId) +
    '/databases/(default)/documents/trux_kv/' + encodeURIComponent(id);
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!response.ok && response.status !== 404) {
    throw new Error('Cloud Run state storage returned HTTP ' + response.status + '.');
  }
  return true;
}

function markFirestoreUnavailable(error) {
  // Keep the in-memory copy as a short-lived fallback, but retry Firestore
  // after a brief backoff instead of permanently switching the whole instance
  // to isolated memory. Background jobs may span multiple Cloud Run instances.
  firestoreRetryAfter = Date.now() + 5000;
  console.warn(
    'Cloud Run Firestore state temporarily unavailable; using memory fallback until retry:',
    error?.message || error
  );
}

export function getCloudRunKv(env) {
  return {
    async get(key, type) {
      const memoryValue = memoryGet(key);
      if (firestoreDisabled) {
        if (memoryValue == null) return null;
        return type === 'json' ? JSON.parse(memoryValue) : memoryValue;
      }

      try {
        const value = await firestoreGet(env, key);
        if (value == null) return null;
        memoryPut(key, value);
        return type === 'json' ? JSON.parse(value) : value;
      } catch (error) {
        markFirestoreUnavailable(error);
        if (memoryValue == null) return null;
        return type === 'json' ? JSON.parse(memoryValue) : memoryValue;
      }
    },

    async put(key, value, options) {
      memoryPut(key, value, options);
      if (firestoreDisabled) return;
      try {
        await firestorePut(env, key, value, options);
      } catch (error) {
        markFirestoreUnavailable(error);
      }
    },

    async delete(key) {
      memory.delete(key);
      if (firestoreDisabled) return;
      try {
        await firestoreDelete(env, key);
      } catch (error) {
        markFirestoreUnavailable(error);
      }
    }
  };
}
