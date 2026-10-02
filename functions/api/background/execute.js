import { processJob } from '../../../workers/trux-background.js';

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const jobId = String(body?.jobId || '');
    const jobSecret = String(body?.jobSecret || '');
    const headerSecret = String(request.headers.get('X-TruX-Background-Secret') || '');

    if (!jobId || !jobSecret || !headerSecret || headerSecret !== jobSecret) {
      return Response.json({ error: 'Unauthorized background worker request.' }, { status: 401 });
    }

    /*
     * This request is intentionally long-lived. The Cloud Run instance that
     * receives it owns the coding job until completion, independent of the
     * browser request that created the job.
     */
    await processJob(body, env);

    return Response.json({ ok: true, jobId });
  } catch (error) {
    return Response.json({
      error: error?.message || 'Background worker failed.'
    }, { status: 500 });
  }
}
