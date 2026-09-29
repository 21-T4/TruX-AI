import { GoogleAuth } from 'google-auth-library';
import { requireFirebaseUser } from '../firebase-auth.js';

const MAX_CODE_CHARS = 100_000;
const MAX_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_CHARS = 200_000;

let authClient = null;

function cleanLanguage(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['py', 'python', 'python3'].includes(v)) return 'python';
  if (['js', 'javascript', 'node', 'nodejs'].includes(v)) return 'node';
  throw Object.assign(new Error('Only Python and Node.js execution are available.'), { status: 400 });
}

async function runnerRequest(env, payload) {
  const runnerUrl = String(env.TRUX_SANDBOX_URL || '').trim().replace(/\/$/, '');
  if (!runnerUrl) throw Object.assign(new Error('Sandbox runner is not configured yet.'), { status: 503 });

  if (!authClient) authClient = new GoogleAuth();
  const client = await authClient.getIdTokenClient(runnerUrl);
  const response = await client.request({
    url: runnerUrl + '/execute',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: payload,
    timeout: MAX_TIMEOUT_MS + 3000
  });

  return response.data;
}

export async function onRequestPost({ request, env }) {
  const user = await requireFirebaseUser(request, env);
  const body = await request.json();
  const language = cleanLanguage(body?.language);
  const code = String(body?.code || '');

  if (!code.trim()) return Response.json({ error: 'Code is empty.' }, { status: 400 });
  if (code.length > MAX_CODE_CHARS) return Response.json({ error: 'Code is limited to 100,000 characters.' }, { status: 413 });

  const result = await runnerRequest(env, {
    language,
    code,
    userId: user.uid,
    timeoutMs: MAX_TIMEOUT_MS,
    maxOutputChars: MAX_OUTPUT_CHARS
  });

  return Response.json(result);
}
