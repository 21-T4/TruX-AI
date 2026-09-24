function getKv(env) {
  const kv = env.TRUX_BACKGROUND_KV || env.TRUX_GITHUB_KV || env['TruX-Images'] || env.TruX_Images || env.IMAGE_LIMIT_KV;
  if (!kv) throw new Error('Background job KV binding is missing.');
  return kv;
}

export async function onRequestPost({ request, env }) {
  try {
    const secret = String(env.TRUX_BACKGROUND_SECRET || '');
    const supplied = String(request.headers.get('X-TruX-Background-Secret') || '');
    if (!secret || supplied !== secret) {
      return Response.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const body = await request.json();
    const jobId = String(body?.jobId || '');
    if (!/^[a-zA-Z0-9_-]{20,100}$/.test(jobId)) {
      return Response.json({ error: 'Invalid job id.' }, { status: 400 });
    }

    const kv = getKv(env);
    const key = 'trux_background_job_' + jobId;
    const existing = await kv.get(key, 'json');
    if (!existing) return Response.json({ error: 'Background job not found.' }, { status: 404 });

    const next = {
      ...existing,
      status: body?.status || existing.status,
      events: Array.isArray(body?.events) ? body.events.slice(-30) : (existing.events || []),
      final: typeof body?.final === 'string' ? body.final : existing.final,
      error: typeof body?.error === 'string' ? body.error : existing.error,
      proposal: body?.proposal && typeof body.proposal === 'object' ? body.proposal : (existing.proposal || null)
    };

    await kv.put(key, JSON.stringify(next), { expirationTtl: 24 * 60 * 60 });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error?.message || 'Background update failed.' }, { status: 500 });
  }
}
