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
    const mode = String(body?.mode || '');
    if (!['chat', 'coding', 'deep-research'].includes(mode)) {
      return Response.json({ error: 'Background jobs are available for Chat, TruX-Code, and deep research.' }, { status: 400 });
    }
    const clientJobId = String(body?.clientJobId || '').trim();
    if (clientJobId && !/^[a-zA-Z0-9_-]{20,100}$/.test(clientJobId)) {
      return Response.json({ error: 'Invalid client job id.' }, { status: 400 });
    }

    const requestedUserId = body?.userId ? String(body.userId) : '';
    const verifiedUserId = String(verified.uid || '');
    if (requestedUserId && requestedUserId !== verifiedUserId) {
      return Response.json({ error: 'Authenticated account does not match the requested user.' }, { status: 403 });
    }

    const userId = verifiedUserId;
    const userEmail = String(verified.email || '');

    const kv = getKv(env);
    const jobId = clientJobId || randomId();
    const jobKey = 'trux_background_job_' + jobId;
    const existing = clientJobId ? await kv.get(jobKey, 'json') : null;
    if (existing) {
      if (String(existing.userId || existing.body?.userId || '') !== verifiedUserId) {
        return Response.json({ error: 'That background job id is already in use.' }, { status: 409 });
      }
      return Response.json({ ok: true, jobId, jobSecret: String(existing.jobSecret || ''), background: true, resumed: true }, {
        status: 200,
        headers: { 'Cache-Control': 'no-store' }
      });
    }

    const cookie = request.headers.get('Cookie') || '';
    const createdAt = Date.now();
    const payload = {
      jobId,
      jobSecret: randomId(),
      body: { ...body, mode, userId, userEmail, notifyOnComplete: true },
      cookie,
      // Prefer the Cloud Run loopback origin for the background worker.
      origin: String(env.TRUX_BACKGROUND_ORIGIN || new URL(request.url).origin).replace(/\/$/, ''),
      createdAt
    };

    const label = mode === 'coding' ? 'TruX-Code' : 'TruX-AI';
    const initialState = {
      jobId: payload.jobId,
      userId,
      userEmail,
      mode,
      status: 'queued',
      events: [{ id: 1, type: 'status', tool: label, status: 'Thinking…' }],
      final: null,
      liveText: '',
      error: null,
      proposal: null,
      jobSecret: payload.jobSecret,
      createdAt: payload.createdAt,
      updatedAt: payload.createdAt
    };
    await kv.put(jobKey, JSON.stringify(initialState), { expirationTtl: 24 * 60 * 60 });

    try {
      await queue.send(payload);
    } catch (error) {
      const message = String(error?.message || 'Background worker could not be started.');
      await kv.put(jobKey, JSON.stringify({
        ...initialState,
        status: 'error',
        error: message,
        events: [...initialState.events, {
          id: 2,
          type: 'status',
          tool: label,
          status: 'Background worker could not be started: ' + message
        }],
        updatedAt: Date.now()
      }), { expirationTtl: 24 * 60 * 60 });
      return Response.json({ error: message, backgroundUnavailable: true }, { status: 503 });
    }
    return Response.json({
      ok: true,
      jobId: payload.jobId,
      jobSecret: payload.jobSecret,
      background: true
    }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({
      error: error?.message || 'Background job could not be started.',
      backgroundUnavailable: true
    }, { status: 503 });
  }
}
