/* Small HTTP helpers shared by all routes. Handlers use the Fetch API
   Request/Response types; server/index.js bridges them to node:http. */
export const NO_STORE = { 'Cache-Control': 'no-store, private, max-age=0' };

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

export function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { ...NO_STORE, ...headers } });
}

export function errorResponse(error) {
  const status = Number(error?.status) || 500;
  if (status >= 500) console.error('[api]', error?.stack || error?.message || error);
  const message = status >= 500 ? 'Something went wrong on the server. Please try again.' : String(error?.message || 'Request failed.');
  return json({ error: message, ...(error?.code ? { code: error.code } : {}) }, status);
}

/* Reads a JSON body with a hard size cap. */
export async function readJson(request, maxBytes = 1024 * 1024) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new HttpError(413, 'Request body is too large.');
  const text = await request.text();
  if (Buffer.byteLength(text) > maxBytes) throw new HttpError(413, 'Request body is too large.');
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw new HttpError(400, 'Request body must be valid JSON.'); }
}

export function sseResponse(start, { signal } = {}) {
  const encoder = new TextEncoder();
  let closed = false;
  let controllerRef;
  const stream = new ReadableStream({
    start(controller) {
      controllerRef = controller;
      const send = payload => {
        if (closed) return false;
        try { controller.enqueue(encoder.encode('data: ' + JSON.stringify(payload) + '\n\n')); return true; }
        catch { closed = true; return false; }
      };
      // Keeps proxies from closing an idle stream while tools run.
      const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 15000);
      signal?.addEventListener('abort', () => { closed = true; }, { once: true });
      Promise.resolve()
        .then(() => start(send))
        .catch(error => {
          console.error('[sse]', error?.stack || error?.message || error);
          send({ type: 'error', error: Number(error?.status) < 500 ? String(error.message) : 'The response could not be completed.' });
        })
        .finally(() => {
          clearInterval(heartbeat);
          if (!closed) { send({ type: 'done' }); closed = true; }
          try { controller.close(); } catch {}
        });
    },
    cancel() { closed = true; }
  });
  void controllerRef;
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no'
    }
  });
}
