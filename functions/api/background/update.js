import { getCloudRunKv } from '../../cloud-run-store.js';

function getKv(env) {
  return getCloudRunKv(env, { strict: true });
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const jobId = String(body?.jobId || '');
    if (!/^[a-zA-Z0-9_-]{20,100}$/.test(jobId)) {
      return Response.json({ error: 'Invalid job id.' }, { status: 400 });
    }

    const kv = getKv(env);
    const key = 'trux_background_job_' + jobId;
    const existing = await kv.get(key, 'json');
    if (!existing) return Response.json({ error: 'Background job not found.' }, { status: 404 });

    if (!body?.jobSecret || body.jobSecret !== existing.jobSecret) {
      return Response.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    /*
     * A stop is terminal. Worker updates can race the Stop request, so a
     * later "running" or "complete" update must never resurrect a stopped job.
     */
    if (existing.status === 'stopped' && body?.status !== 'stopped') {
      return Response.json({ ok: true, stopped: true });
    }

    const latest = await kv.get(key, 'json');
    if (!latest) return Response.json({ error: 'Background job not found.' }, { status: 404 });

    if (latest.status === 'stopped' && body?.status !== 'stopped') {
      return Response.json({ ok: true, stopped: true });
    }

    const next = {
      ...latest,
      status: body?.status || latest.status,
      events: Array.isArray(body?.events) ? body.events.slice(-120) : (latest.events || []),
      final: typeof body?.final === 'string' ? body.final : latest.final,
      liveText: typeof body?.liveText === 'string' ? body.liveText : (latest.liveText || ''),
      error: typeof body?.error === 'string' ? body.error : latest.error,
      proposal: body?.proposal && typeof body.proposal === 'object' ? body.proposal : (latest.proposal || null),
      updatedAt: Date.now()
    };

    await kv.put(key, JSON.stringify(next), { expirationTtl: 24 * 60 * 60 });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error?.message || 'Background update failed.' }, { status: 500 });
  }
}
