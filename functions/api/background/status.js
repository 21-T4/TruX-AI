function getKv(env) {
  const kv = env.TRUX_BACKGROUND_KV || env.TRUX_GITHUB_KV || env['TruX-Images'] || env.TruX_Images || env.IMAGE_LIMIT_KV;
  if (!kv) throw new Error('Background job KV binding is missing.');
  return kv;
}

export async function onRequestGet({ request, env }) {
  try {
    const id = new URL(request.url).searchParams.get('jobId') || '';
    if (!/^[a-zA-Z0-9_-]{20,100}$/.test(id)) {
      return Response.json({ error: 'Invalid job id.' }, { status: 400 });
    }

    const job = await getKv(env).get('trux_background_job_' + id, 'json');
    if (!job) return Response.json({ error: 'Background job not found.' }, { status: 404 });

    return Response.json(job, {
      headers: { 'Cache-Control': 'no-store' }
    });
  } catch (error) {
    return Response.json({ error: error?.message || 'Background status failed.' }, { status: 500 });
  }
}
