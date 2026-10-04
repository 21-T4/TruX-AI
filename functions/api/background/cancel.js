import { getCloudRunKv } from '../../cloud-run-store.js';
import { requireFirebaseUser } from '../../firebase-auth.js';

function getKv(env) {
  return getCloudRunKv(env);
}

function pushEvent(events, event) {
  const nextId = events.reduce((max, item) => Math.max(max, Number(item?.id) || 0), 0) + 1;
  return [...events, { id: nextId, ...event }].slice(-30);
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const jobId = String(body?.jobId || '');
    const requestedJobSecret = String(body?.jobSecret || '');

    let verified = null;
    if (!requestedJobSecret) {
      verified = await requireFirebaseUser(request, env);
    }

    if (!/^[a-zA-Z0-9_-]{20,100}$/.test(jobId)) {
      return Response.json({ error: 'Invalid background job id.' }, { status: 400 });
    }

    const kv = getKv(env);
    const key = 'trux_background_job_' + jobId;
    const existing = await kv.get(key, 'json');

    if (!existing) return Response.json({ error: 'Background job not found.' }, { status: 404 });

    const ownerId = String(existing?.body?.userId || '');
    const secretMatches = !!requestedJobSecret && requestedJobSecret === String(existing?.jobSecret || '');
    const firebaseMatches = !!verified && !!ownerId && ownerId === String(verified.uid);

    if (!secretMatches && !firebaseMatches) {
      if (!requestedJobSecret && !verified) {
        return Response.json({ error: 'Authentication required to stop this background job.' }, { status: 401 });
      }
      return Response.json({ error: 'You are not authorized to stop this background job.' }, { status: 403 });
    }

    if (existing.status === 'stopped') {
      return Response.json({ ok: true, stopped: true, alreadyStopped: true });
    }

    const next = {
      ...existing,
      status: 'stopped',
      cancelRequested: true,
      stoppedAt: Date.now(),
      final: null,
      error: null,
      events: pushEvent(existing.events || [], {
        type: 'status',
        tool: 'TruX-Code',
        status: 'Generation stopped.'
      })
    };

    await kv.put(key, JSON.stringify(next), { expirationTtl: 24 * 60 * 60 });

    return Response.json({ ok: true, stopped: true });
  } catch (error) {
    return Response.json(
      { error: error?.message || 'Background generation could not be stopped.' },
      { status: error?.status || 500 }
    );
  }
}
