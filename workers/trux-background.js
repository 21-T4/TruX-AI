const APP_ORIGIN_FALLBACK = 'https://chat.trux.website';

async function updateJob(env, payload) {
  const origin = String(env.TRUX_BACKGROUND_ORIGIN || env.TRUX_APP_ORIGIN || APP_ORIGIN_FALLBACK).replace(/\/$/, '');

  await fetch(origin + '/api/background/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function isJobStopped(job, env) {
  const origin = String(job?.origin || env.TRUX_BACKGROUND_ORIGIN || env.TRUX_APP_ORIGIN || APP_ORIGIN_FALLBACK).replace(/\/$/, '');
  try {
    const response = await fetch(origin + '/api/background/status?jobId=' + encodeURIComponent(String(job?.jobId || '')), {
      cache: 'no-store',
      headers: {
        'X-Trux-Background-Secret': String(job?.jobSecret || '')
      }
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

    const origin = String(job.origin || env.TRUX_BACKGROUND_ORIGIN || env.TRUX_APP_ORIGIN || APP_ORIGIN_FALLBACK).replace(/\/$/, '');
    const body = {
      ...(job.body || {}),
      mode: 'coding',
      notifyOnComplete: true,
      backgroundJobId: jobId
    };

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream'
    };

    if (job.cookie) headers.Cookie = String(job.cookie);
    headers['X-Trux-Background-Job'] = jobId;
    headers['X-Trux-Background-Secret'] = String(job.jobSecret || '');

    const chatController = new AbortController();
    const response = await fetch(origin + '/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: chatController.signal
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new Error(text || 'The coding backend returned an error.');
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
          events.push({
            id: ++seq,
            type: event.type === 'chunk' ? 'text' : 'status',
            text: piece,
            status: event.type === 'progress' ? piece : undefined
          });
          events = events.slice(-30);
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
          status: String(event.status || '')
        });
        events = events.slice(-30);
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
        events = events.slice(-30);
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
          try { chatController.abort(); } catch {}
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
      finalText = liveText.trim() || 'Completed TruX-Code task.';
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
        events: events.slice(-30),
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
