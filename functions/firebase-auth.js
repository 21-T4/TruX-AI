import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

let authInstance = null;

function projectId(env = {}) {
  return String(
    env.GCP_PROJECT_ID ||
    env.GOOGLE_CLOUD_PROJECT ||
    env.GCLOUD_PROJECT ||
    env.PROJECT_ID ||
    ''
  ).trim() || undefined;
}

function getAdminAuth(env = {}) {
  if (authInstance) return authInstance;
  const app = getApps()[0] || initializeApp({
    credential: applicationDefault(),
    projectId: projectId(env)
  });
  authInstance = getAuth(app);
  return authInstance;
}

export async function requireFirebaseUser(request, env = {}) {
  const header = request?.headers?.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw Object.assign(new Error('Authentication required.'), { status: 401 });
  }

  try {
    return await getAdminAuth(env).verifyIdToken(match[1], true);
  } catch {
    throw Object.assign(new Error('Invalid or expired authentication token.'), { status: 401 });
  }
}
