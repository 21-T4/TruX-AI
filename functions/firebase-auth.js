import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const ADMIN_APP_NAME = 'trux-account-data';

export function getFirebaseAdminApp(env = {}) {
  const projectId = String(env.FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || 'trux-ai').trim();
  const existing = getApps().find(app => app.name === ADMIN_APP_NAME);

  if(existing) {
    const existingProjectId = String(existing.options?.projectId || '').trim();
    if(existingProjectId && existingProjectId !== projectId) {
      throw new Error('Firebase Admin was initialized for a different Firebase project.');
    }
    return existing;
  }

  // Auth, chat history, and Firestore-backed app state must use the same
  // explicitly configured Firebase project, independent of import order.
  return initializeApp({
    credential: applicationDefault(),
    projectId
  }, ADMIN_APP_NAME);
}

function getAdminAuth(env = {}) {
  return getAuth(getFirebaseAdminApp(env));
}

export async function requireFirebaseUser(request, env = {}) {
  const header = request?.headers?.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if(!match) throw Object.assign(new Error('Authentication required.'), { status: 401 });
  try {
    return await getAdminAuth(env).verifyIdToken(match[1], true);
  } catch {
    throw Object.assign(new Error('Invalid or expired authentication token.'), { status: 401 });
  }
}
