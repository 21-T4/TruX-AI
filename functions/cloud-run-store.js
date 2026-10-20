import { getFirebaseAdminApp } from './firebase-auth.js';
import { getFirestore } from 'firebase-admin/firestore';

/* Cloud Run state adapter: Firestore + short-lived in-memory fallback. */
let firestoreInstance = null;
const memory = new Map();
let firestoreRetryAfter = 0;

function getFirestoreInstance() {
  if (firestoreInstance) return firestoreInstance;
  firestoreInstance = getFirestore(getFirebaseAdminApp());
  return firestoreInstance;
}

function base64UrlEncode(data) {
  const bytes =
    typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + 0x8000, bytes.length))
    );
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function docId(key) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(String(key))
  );
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

async function firestoreGet(key) {
  if (Date.now() < firestoreRetryAfter) return null;

  const id = await docId(key);
  const snapshot = await getFirestoreInstance()
    .collection('trux_kv')
    .doc(id)
    .get();

  if (!snapshot.exists) return null;

  const data = snapshot.data() || {};
  const expiresAt =
    data.expiresAt instanceof Date
      ? data.expiresAt.getTime()
      : data.expiresAt?.toMillis?.() || 0;

  if (expiresAt && expiresAt <= Date.now()) {
    await firestoreDelete(key);
    return null;
  }

  return data.value == null ? null : String(data.value);
}

async function firestorePut(key, value, options = {}) {
  if (Date.now() < firestoreRetryAfter) return false;

  const id = await docId(key);
  const data = { value: String(value) };
  const ttl = Number(options?.expirationTtl || 0);

  if (ttl > 0) {
    data.expiresAt = new Date(Date.now() + ttl * 1000);
  }

  await getFirestoreInstance()
    .collection('trux_kv')
    .doc(id)
    .set(data, { merge: true });

  return true;
}

async function firestoreDelete(key) {
  if (Date.now() < firestoreRetryAfter) return false;

  const id = await docId(key);
  await getFirestoreInstance()
    .collection('trux_kv')
    .doc(id)
    .delete();

  return true;
}

function markFirestoreUnavailable(error) {
  firestoreRetryAfter = Date.now() + 5000;
  console.warn(
    'Cloud Run state storage temporarily unavailable; using memory fallback until retry:',
    error?.message || error
  );
}

export function getCloudRunKv(env = {}, options = {}) {
  void env;
  const strict = !!options?.strict;

  return {
    async get(key, type) {
      const memoryValue = memoryGet(key);

      if (strict && Date.now() < firestoreRetryAfter) {
        throw new Error('Cloud Run state storage is temporarily unavailable.');
      }

      if (!strict && Date.now() < firestoreRetryAfter) {
        if (memoryValue == null) return null;
        return type === 'json' ? JSON.parse(memoryValue) : memoryValue;
      }

      try {
        const value = await firestoreGet(key);

        if (value == null) {
          memory.delete(key);
          return null;
        }

        memoryPut(key, value);
        return type === 'json' ? JSON.parse(value) : value;
      } catch (error) {
        markFirestoreUnavailable(error);
        if (strict) throw error;
        if (memoryValue == null) return null;
        return type === 'json' ? JSON.parse(memoryValue) : memoryValue;
      }
    },

    async put(key, value, options) {
      memoryPut(key, value, options);

      if (Date.now() < firestoreRetryAfter) {
        if (strict) {
          throw new Error('Cloud Run state storage is temporarily unavailable.');
        }
        return;
      }

      try {
        await firestorePut(key, value, options);
      } catch (error) {
        markFirestoreUnavailable(error);
        if (strict) throw error;
      }
    },

    async delete(key) {
      memory.delete(key);

      if (Date.now() < firestoreRetryAfter) {
        if (strict) {
          throw new Error('Cloud Run state storage is temporarily unavailable.');
        }
        return;
      }

      try {
        await firestoreDelete(key);
      } catch (error) {
        markFirestoreUnavailable(error);
        if (strict) throw error;
      }
    }
  };
}
