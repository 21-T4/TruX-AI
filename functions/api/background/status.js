import { getCloudRunKv } from '../../cloud-run-store.js';
import { requireFirebaseUser } from '../../firebase-auth.js';

function getKv(env) {
  return getCloudRunKv(env);
}

export async function onRequestGet({ request, env }) {
  try {
    const id = new URL(request.url).searchParams.get('jobId') || '';
    if (!/^[a-zA-Z0-9_-]{20,100}$/.test(id)) {
      return Response.json({ error: 'Invalid job id.' }, { status: 400 });
    }

    const authHeader = String(request.headers.get('authorization') || '');
    const workerSecret = String(request.headers.get('x-trux-background-secret') || '');
    const kv = getKv(env);
    const job = await kv.get('trux_background_job_' + id, 'json');
    if (!job) return Response.json({ error: 'Background job not found.' }, { status: 404 });

    let authorized = false;
    if (workerSecret && workerSecret === String(job.jobSecret || '')) {
      authorized = true;
    } else if (/^Bearer\s+\S+$/i.test(authHeader)) {
      const verified = await requireFirebaseUser(request, env);
      const ownerId = String(job?.body?.userId || '');
      authorized = !!ownerId && ownerId === String(verified.uid || '');
    }

    if (!authorized) {
      return Response.json({ error: 'Authentication required.' }, { status: 401 });
    }

    const { jobSecret, ...safeJob } = job;
    return Response.json(safeJob, {
      headers: { 'Cache-Control': 'no-store' }
    });
  } catch (error) {
    return Response.json(
      { error: error?.message || 'Background status failed.' },
      { status: error?.status || 500 }
    );
  }
}
