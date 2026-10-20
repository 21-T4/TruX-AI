import { requireFirebaseUser } from '../firebase-auth.js';
import { getFirebaseAssistantRefs } from '../trux-chat-store.js';

function errorResponse(error) {
  const status = Number(error?.status) || 500;
  return Response.json({
    error: status >= 500 ? 'Realtime chat streaming is temporarily unavailable.' : String(error?.message || 'Invalid stream request.')
  }, { status, headers: { 'Cache-Control': 'no-store' } });
}
export async function onRequestGet(context) {
  const { request, env } = context;
  let refs;
  try {
    const user = await requireFirebaseUser(request, env);
    const url = new URL(request.url);
    const chatId = String(url.searchParams.get('chatId') || '');
    const turnId = String(url.searchParams.get('turnId') || '');
    if (!chatId || !turnId) return Response.json({ error: 'chatId and turnId are required.' }, { status: 400 });
    refs = getFirebaseAssistantRefs(user.uid, chatId, turnId, env);
  } catch (error) { return errorResponse(error); }

  // Reject missing turns before creating a long-lived SSE request; use only the tiny status node,
  // not the full answer/chunk subtree.
  try {
    const statusSnapshot = await refs.statusRef.once('value');
    if (!statusSnapshot.exists()) {
      return Response.json({ error: 'Chat turn not found.' }, {
        status: 404, headers: { 'Cache-Control': 'no-store' }
      });
    }
  } catch (error) {
    return errorResponse(error);
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false, status = null, statusReady = false;
      let targetChunkCount = 0, countReady = false, lastSequence = 0, finishing = false;
      const waitingChunks = new Map();
      let heartbeat = null;
      function cleanup() {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        refs.chunksRef.off('child_added', onChunk);
        refs.statusRef.off('value', onStatus);
        refs.countRef.off('value', onCount);
        request.signal?.removeEventListener('abort', onAbort);
      }
      function close() {
        if (closed) return;
        cleanup();
        try { controller.close(); } catch {}
      }
      function send(packet) {
        if (closed) return;
        try { controller.enqueue(encoder.encode('data: ' + JSON.stringify(packet) + '\n\n')); }
        catch { close(); }
      }
      function finishIfReady() {
        if (closed || finishing || !statusReady || !countReady || !status || status === 'streaming' || lastSequence < targetChunkCount) return;
        finishing = true;
        refs.assistantRef.once('value').then(snapshot => {
          if (closed) return;
          const message = snapshot.val() || {};
          const chunks = Object.values(message.chunks || {})
            .filter(chunk => chunk && typeof chunk === 'object')
            .sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0));
          send({
            type: 'complete',
            status,
            text: typeof message.text === 'string' ? message.text : chunks.map(chunk => String(chunk.text || '')).join(''),
            error: typeof message.error === 'string' ? message.error : ''
          });
          close();
        }).catch(() => { send({ type: 'error', error: 'Could not read the final saved chat response.' }); close(); });
      }
      function flushWaitingChunks() {
        while (waitingChunks.has(lastSequence + 1)) {
          const sequence = lastSequence + 1;
          const chunk = waitingChunks.get(sequence);
          waitingChunks.delete(sequence);
          lastSequence = sequence;
          const text = String(chunk?.text || '');
          if (text) send({ type: 'chunk', sequence, text });
        }
        finishIfReady();
      }
      function onChunk(snapshot) {
        const chunk = snapshot.val();
        const sequence = Number(chunk?.sequence);
        if (!Number.isSafeInteger(sequence) || sequence <= lastSequence) return;
        waitingChunks.set(sequence, chunk || {});
        flushWaitingChunks();
      }
      function onStatus(snapshot) { status = snapshot.val() == null ? null : String(snapshot.val()); statusReady = true; finishIfReady(); }
      function onCount(snapshot) { targetChunkCount = Math.max(0, Number(snapshot.val()) || 0); countReady = true; finishIfReady(); }
      function onAbort() { close(); }

      // The browser waits for this acknowledgment before posting the generation request.
      send({ type: 'ready' });
      if (closed) return;
      refs.chunksRef.on('child_added', onChunk, () => { send({ type: 'error', error: 'Realtime Database could not deliver saved response chunks.' }); close(); });
      refs.statusRef.on('value', onStatus, () => { send({ type: 'error', error: 'Realtime Database could not read response status.' }); close(); });
      refs.countRef.on('value', onCount, () => { send({ type: 'error', error: 'Realtime Database could not read response progress.' }); close(); });
      heartbeat = setInterval(() => send({ type: 'heartbeat' }), 15000);
      if (request.signal?.aborted) close();
      else request.signal?.addEventListener('abort', onAbort, { once: true });
    },
    cancel() {}
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, private, max-age=0, must-revalidate, no-transform',
      'CDN-Cache-Control': 'no-store', 'Surrogate-Control': 'no-store',
      'Pragma': 'no-cache', 'Expires': '0', 'X-Accel-Buffering': 'no'
    }
  });
}
