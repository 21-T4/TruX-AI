import { onRequestPost as chatRequest } from '../functions/api/chat.js';
import { onRequestGet as backgroundStatusRequest } from '../functions/api/background/status.js';
import { onRequestPost as backgroundUpdateRequest } from '../functions/api/background/update.js';

function backgroundRequest(path, init = {}) {
  return new Request('http://trux-background.internal' + path, {
    ...init,
    headers: new Headers(init.headers || {})
  });
}

async function updateJob(env, payload) {
  const response = await backgroundUpdateRequest({
    request: backgroundRequest('/api/background/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }),
    env
  });
  if (!response.ok && response.status !== 404) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || 'Background state update failed.');
  }
}

async function isJobStopped(job, env) {
  try {
    const response = await backgroundStatusRequest({
      request: backgroundRequest(
        '/api/background/status?jobId=' + encodeURIComponent(String(job?.jobId || '')),
        {
          method: 'GET',
          headers: { 'X-Trux-Background-Secret': String(job?.jobSecret || '') }
        }
      ),
      env
    });
    if (!response.ok) return false;
    const state = await response.json();
    return state?.status === 'stopped' || state?.cancelRequested === true;
  } catch {
    return false;
  }
}

async function processJob(job, env) {
  const jobId = String(job?.jobId || '');
  if (!jobId) return;

  if (await isJobStopped(job, env)) return;

  let events = [{
    id: 1,
    type: 'status',
    tool: 'TruX-Code',
    status: 'Thinking…'
  }];

  try {
    await updateJob(env, {
      jobId,
      jobSecret: job.jobSecret,
      status: 'running',
      events
    });

    const body = {
      ...(job.body || {}),
      mode: 'coding',
      notifyOnComplete: true,
      backgroundJobId: jobId
    };

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'X-TruX-Background-Job': jobId,
      'X-TruX-Background-Secret': String(job.jobSecret || '')
    };

    if (job.cookie) headers.Cookie = String(job.cookie);

    /*
     * Invoke the chat handler directly. The old worker made a nested
     * 127.0.0.1 HTTP request, which could deadlock under low concurrency and
     * added another failure point to every long-running coding task.
     */
    const chatController = new AbortController();
    const response = await chatRequest({
      request: new Request('http://trux-background.internal/api/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: chatController.signal
      }),
      env
    });

    if (!response.ok || !response.body) {
      const responseText = await response.text().catch(() => '');
      throw new Error(responseText || 'The coding backend returned an error.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalText = '';
    let liveText = '';
    let seq = 1;
    let lastLivePublishAt = 0;
    async function publishLiveState(force = false) {
      const now = Date.now();
      // Keep background state updates frequent enough for live UI without
      // turning every streamed token into a datastore write.
      if (!force && now - lastLivePublishAt < 750) return;
      lastLivePublishAt = now;
      await updateJob(env, { jobId, jobSecret: job.jobSecret, status: 'running', events, liveText });
    }


    const handleEvent = async (raw) => {
      if (!raw) return;
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        return;
      }

      if (event.type === 'progress' || event.type === 'chunk') {
        const piece = String(event.text || '');
        if (piece) {
          if (event.type === 'chunk') liveText += piece;
          if (event.type === 'progress') {
            events.push({
              id: ++seq,
              type: 'status',
              tool: 'TruX-Code',
              text: piece,
              status: piece
            });
            events = events.slice(-120);
          }
          await publishLiveState(false);
        }
        return;
      }

      if (event.type === 'tool_status') {
        events.push({
          id: ++seq,
          type: 'tool_status',
          tool: String(event.tool || 'TruX-Code'),
          phase: String(event.phase || 'complete'),
          status: String(event.status || ''),
          details: event.details && typeof event.details === 'object' ? event.details : null
        });
        events = events.slice(-120);
        await updateJob(env, { jobId, jobSecret: job.jobSecret, status: 'running', events });
        return;
      }

      if (event.type === 'status') {
        events.push({
          id: ++seq,
          type: 'status',
          tool: 'TruX-Code',
          status: String(event.status || '')
        });
        events = events.slice(-120);
        await updateJob(env, { jobId, jobSecret: job.jobSecret, status: 'running', events });
        return;
      }

      if (event.type === 'github_proposal' || event.type === 'github_commit') {
        const commit = event.type === 'github_commit' ? event.commit : (event.proposal?.commit || null);
        const proposal = event.proposal || null;
        if (proposal && commit) proposal.commit = commit;
        await updateJob(env, {
          jobId,
          jobSecret: job.jobSecret,
          status: 'running',
          events,
          proposal,
          commit: commit || null
        });
        return;
      }

      if (event.type === 'final') {
        finalText = String(event.text || '');
      }

      if (event.type === 'error') {
        throw new Error(String(event.error || 'Coding request failed.'));
      }
    };

    let pendingRead = reader.read();
    while (true) {
      const stopPulse = new Promise(resolve => setTimeout(() => resolve({ __stopPulse: true }), 750));
      const readResult = await Promise.race([pendingRead, stopPulse]);

      if (readResult?.__stopPulse) {
        if (await isJobStopped(job, env)) {
          chatController.abort();
          try { await reader.cancel(); } catch {}
          return;
        }
        continue;
      }

      const { value, done } = readResult;
      if (done) break;
      pendingRead = reader.read();

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || '';

      for (const frame of frames) {
        const lines = frame
          .split(/\r?\n/)
          .filter(line => line.startsWith('data:'));

        if (lines.length) {
          await handleEvent(lines.map(line => line.slice(5).trimStart()).join('\n'));
          if (await isJobStopped(job, env)) {
            try { chatController.abort(); } catch {}
            try { await reader.cancel(); } catch {}
            return;
          }
        }
      }
    }

    buffer += decoder.decode();

    if (buffer.trim()) {
      const lines = buffer
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'));
      if (lines.length) {
        await handleEvent(lines.map(line => line.slice(5).trimStart()).join('\n'));
      }
    }

    if (await isJobStopped(job, env)) return;

    if (!finalText.trim()) {
      throw new Error('The model completed the coding tool phase but did not return a final response.');
    }

    await updateJob(env, {
      jobId,
      jobSecret: job.jobSecret,
      status: 'complete',
      events,
      final: finalText.trim(),
      liveText,
      error: null
    });
  } catch (error) {
    if (await isJobStopped(job, env)) return;

    events.push({
      id: events.length + 1,
      type: 'status',
      tool: 'TruX-Code',
      status: 'Background run failed: ' + String(error?.message || 'Unknown error.')
    });

    try {
      await updateJob(env, {
        jobId,
        jobSecret: job.jobSecret,
        status: 'error',
        events: events.slice(-120),
        final: null,
        liveText,
        error: String(error?.message || 'Background coding request failed.')
      });
    } catch {
      // The queue consumer must not loop forever when status persistence is unavailable.
    }

    throw error;
  }
}

export { processJob };

export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      await processJob(message.body, env);
    }
  }
};
