import { getCloudRunKv } from '../../cloud-run-store.js';
import { processJob } from '../../../workers/trux-background.js';

function pushEvent(events, event) {
  const nextId = (Array.isArray(events) ? events : []).reduce(
    (max, item) => Math.max(max, Number(item?.id) || 0),
    0
  ) + 1;
  return [...(Array.isArray(events) ? events : []), { id: nextId, ...event }].slice(-120);
}

async function persistWorkerFailure(body, env, error) {
  const jobId = String(body?.jobId || '');
  const jobSecret = String(body?.jobSecret || '');
  if (!jobId || !jobSecret) return;

  try {
    const kv = getCloudRunKv(env, { strict: true });
    const key = 'trux_background_job_' + jobId;
    const existing = await kv.get(key, 'json');
    if (!existing || existing.status === 'stopped' || existing.status === 'complete') return;

    const message = String(error?.message || 'Background worker failed.');
    await kv.put(
      key,
      JSON.stringify({
        ...existing,
        status: 'error',
        final: null,
        error: message,
        events: pushEvent(existing.events || [], {
          type: 'status',
          tool: 'TruX-Code',
          status: 'Background worker failed: ' + message
        }),
        updatedAt: Date.now()
      }),
      { expirationTtl: 24 * 60 * 60 }
    );
  } catch {
    // There is no safe persistence path left; the caller still closes the
    // internal worker request so it cannot remain half-open forever.
  }
}

export async function onRequestPost({ request, env }) {
  let body = null;

  try {
    body = await request.json();

    const jobId = String(body?.jobId || '');
    const jobSecret = String(body?.jobSecret || '');
    const headerSecret = String(request.headers.get('X-Trux-Background-Secret') || '');

    if (!jobId || !jobSecret || !headerSecret || headerSecret !== jobSecret) {
      return Response.json({ error: 'Unauthorized background worker request.' }, { status: 401 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(JSON.stringify({ ok: true, accepted: true, jobId }) + '\n')
        );

        void (async () => {
          try {
            await processJob(body, env);
          } catch (error) {
            await persistWorkerFailure(body, env, error);
            controller.enqueue(
              encoder.encode(JSON.stringify({ ok: false, error: String(error?.message || 'Background worker failed.') }) + '\n')
            );
          } finally {
            try { controller.close(); } catch {}
          }
        })();
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Accel-Buffering': 'no'
      }
    });
  } catch (error) {
    if (body) await persistWorkerFailure(body, env, error);
    return Response.json({
      error: error?.message || 'Background worker failed.'
    }, { status: 500 });
  }
}
