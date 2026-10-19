import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

let authInstance = null;

function getAdminAuth(env = {}) {
  if(authInstance) return authInstance;
  // Match the Firebase project used by the browser config rather than relying
  // on whichever Google Cloud project happens to host the Cloud Run service.
  const projectId = String(env.FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || 'trux-ai').trim();
  const app = getApps()[0] || initializeApp({ credential: applicationDefault(), projectId });
  authInstance = getAuth(app);
  return authInstance;
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
