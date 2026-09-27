import crypto from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FIRESTORE_BASE = "https://firestore.googleapis.com/v1";
const tokenCache = new Map();

function projectId(env) {
  return String(
    env.GCP_PROJECT_ID ||
    env.GOOGLE_CLOUD_PROJECT ||
    env.FIREBASE_PROJECT_ID ||
    ""
  ).trim();
}

function serviceAccount(env) {
  const clientEmail = String(env.GCP_CLIENT_EMAIL || "").trim();
  const privateKey = String(env.GCP_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
  if (!clientEmail || !privateKey) {
    throw new Error("Cloud Run storage authentication is not configured. Set GCP_CLIENT_EMAIL and GCP_PRIVATE_KEY.");
  }
  return { clientEmail, privateKey };
}

function base64url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function accessToken(env) {
  const { clientEmail, privateKey } = serviceAccount(env);
  const cached = tokenCache.get(clientEmail);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const assertionHeader = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const assertionPayload = base64url(JSON.stringify({
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));

  const unsigned = assertionHeader + "." + assertionPayload;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(crypto.createPrivateKey(privateKey));
  const assertion = unsigned + "." + base64url(signature);

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    }).toString()
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(
      "Google authentication failed: " +
      String(payload.error_description || payload.error || "unknown error")
    );
  }

  const expiresIn = Number(payload.expires_in || 3600);
  tokenCache.set(clientEmail, {
    token: payload.access_token,
    expiresAt: Date.now() + expiresIn * 1000
  });
  return payload.access_token;
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value));
}

class FirestoreKvNamespace {
  constructor(env, namespace) {
    this.env = env;
    this.namespace = namespace;
  }

  get baseUrl() {
    const project = projectId(this.env);
    if (!project) {
      throw new Error("GCP_PROJECT_ID is missing. Cloud Run Firestore storage needs the GCP project id.");
    }
    return (
      FIRESTORE_BASE +
      "/projects/" + encodePathSegment(project) +
      "/databases/(default)/documents/" +
      encodePathSegment(this.namespace)
    );
  }

  async request(path, options = {}) {
    const token = await accessToken(this.env);
    return fetch(this.baseUrl + "/" + path, {
      ...options,
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
        ...(options.headers || {})
      }
    });
  }

  async get(key, type = "text") {
    const response = await this.request(encodePathSegment(key));
    if (response.status === 404) return null;

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        "Cloud Run storage read failed (" + response.status + "): " +
        String(payload.error?.message || "Firestore error")
      );
    }

    const expiresAt = payload?.fields?.expiresAt?.timestampValue;
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      await this.delete(key);
      return null;
    }

    const value = payload?.fields?.value?.stringValue;
    if (value == null) return null;

    if (type === "json") {
      try {
        return JSON.parse(value);
      } catch {
        throw new Error("Stored Cloud Run value is not valid JSON.");
      }
    }

    return value;
  }

  async put(key, value, options = {}) {
    const fields = {
      value: { stringValue: String(value) }
    };

    const ttl = Number(options?.expirationTtl || 0);
    if (Number.isFinite(ttl) && ttl > 0) {
      fields.expiresAt = {
        timestampValue: new Date(Date.now() + ttl * 1000).toISOString()
      };
    }

    const response = await this.request(encodePathSegment(key), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields })
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(
        "Cloud Run storage write failed (" + response.status + "): " +
        String(payload.error?.message || "Firestore error")
      );
    }
  }

  async delete(key) {
    const response = await this.request(encodePathSegment(key), {
      method: "DELETE"
    });

    if (!response.ok && response.status !== 404) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(
        "Cloud Run storage delete failed (" + response.status + "): " +
        String(payload.error?.message || "Firestore error")
      );
    }
  }
}

export function createCloudRunEnv(baseEnv = process.env) {
  const env = { ...baseEnv };

  // Cloudflare KV bindings are objects in Pages Functions, but Cloud Run
  // environment variables are strings. Provide the same KV interface backed
  // by Firestore, while keeping every existing application variable name.
  env.TRUX_GITHUB_KV = new FirestoreKvNamespace(env, "trux_github_kv");
  env.TRUX_BACKGROUND_KV = new FirestoreKvNamespace(env, "trux_background_kv");
  env["TruX-Images"] = new FirestoreKvNamespace(env, "trux_images_kv");
  env.TruX_Images = env["TruX-Images"];
  env.IMAGE_LIMIT_KV = env["TruX-Images"];

  return env;
}

export { FirestoreKvNamespace };
