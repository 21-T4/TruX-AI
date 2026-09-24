const MAX_QUEUE_PAYLOAD = 100 * 1000;

function getKv(env) {
  const kv = env.TRUX_BACKGROUND_KV || env.TRUX_GITHUB_KV || env['TruX-Images'] || env.TruX_Images || env.IMAGE_LIMIT_KV;
  if (!kv) throw new Error('Background job KV binding is missing.');
  return kv;
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

    const body = await request.json();
    if (body?.mode !== 'coding') {
      return Response.json({ error: 'Background jobs are currently available for TruX-Code only.' }, { status: 400 });
    }

    const userId = body?.userId ? String(body.userId) : '';
    if (!userId) return Response.json({ error: 'Sign in before starting a background coding job.' }, { status: 401 });

    const cookie = request.headers.get('Cookie') || '';
    const payload = {
      jobId: randomId(),
      body: { ...body, notifyOnComplete: true },
      cookie,
      createdAt: Date.now()
    };

    const encoded = JSON.stringify(payload);
    if (encoded.length > MAX_QUEUE_PAYLOAD) {
      return Response.json({
        error: 'This coding request is too large for background mode. I will use live streaming instead.',
        backgroundUnavailable: true
      }, { status: 413 });
    }

    const kv = getKv(env);
    await kv.put(
      'trux_background_job_' + payload.jobId,
      JSON.stringify({
        jobId: payload.jobId,
        status: 'queued',
        events: [{
          id: 1,
          tool: 'TruX-Code',
          status: 'I’m preparing a background coding workspace…'
        }],
        final: null,
        error: null,
        createdAt: payload.createdAt
      }),
      { expirationTtl: 24 * 60 * 60 }
    );

    await queue.send(payload);
    return Response.json({ ok: true, jobId: payload.jobId, background: true }, { status: 202 });
  } catch (error) {
    return Response.json({
      error: error?.message || 'Background job could not be started.',
      backgroundUnavailable: true
    }, { status: 503 });
  }
}
