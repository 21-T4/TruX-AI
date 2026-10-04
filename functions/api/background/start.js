import { getCloudRunKv } from '../../cloud-run-store.js';
import { requireFirebaseUser } from '../../firebase-auth.js';


function getKv(env) {
  return getCloudRunKv(env, { strict: true });
}

function randomId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : [...crypto.getRandomValues(new Uint8Array(24))].map(x => x.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost({ request, env }) {
  try {
    const queue = env.TRUX_BACKGROUND_QUEUE;
    if (!queue?.send) {
      return Response.json({
        error: 'Background processing is not configured yet.',
        backgroundUnavailable: true
      }, { status: 503 });
    }

    const verified = await requireFirebaseUser(request, env);
    const body = await request.json();
    if (body?.mode !== 'coding') {
      return Response.json({ error: 'Background jobs are currently available for TruX-Code only.' }, { status: 400 });
    }

    const requestedUserId = body?.userId ? String(body.userId) : '';
    const verifiedUserId = String(verified.uid || '');
    if (requestedUserId && requestedUserId !== verifiedUserId) {
      return Response.json({ error: 'Authenticated account does not match the requested user.' }, { status: 403 });
    }

    const userId = verifiedUserId;
    const userEmail = String(verified.email || '');

    const cookie = request.headers.get('Cookie') || '';
    const payload = {
      jobId: randomId(),
      jobSecret: randomId(),
      body: { ...body, userId, userEmail, notifyOnComplete: true },
      cookie,
      // Prefer the Cloud Run loopback origin for the background worker.
      origin: String(env.TRUX_BACKGROUND_ORIGIN || new URL(request.url).origin).replace(/\/$/, ''),
      createdAt: Date.now()
    };

    const kv = getKv(env);
    await kv.put(
      'trux_background_job_' + payload.jobId,
      JSON.stringify({
        jobId: payload.jobId,
        status: 'queued',
        events: [{
          id: 1,
          type: 'status',
          tool: 'TruX-Code',
          status: 'Thinking…'
        }],
        final: null,
        liveText: '',
        error: null,
        proposal: null,
        jobSecret: payload.jobSecret,
        createdAt: payload.createdAt
      }),
      { expirationTtl: 24 * 60 * 60 }
    );

    await queue.send(payload);
    return Response.json({
      ok: true,
      jobId: payload.jobId,
      jobSecret: payload.jobSecret,
      background: true
    }, { status: 202 });
  } catch (error) {
    return Response.json({
      error: error?.message || 'Background job could not be started.',
      backgroundUnavailable: true
    }, { status: 503 });
  }
}
