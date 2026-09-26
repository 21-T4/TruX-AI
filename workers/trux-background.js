const APP_ORIGIN_FALLBACK = 'https://www.chat.trux.website';

async function updateJob(env, payload) {
  const origin = String(env.TRUX_APP_ORIGIN || APP_ORIGIN_FALLBACK).replace(/\/$/, '');

  await fetch(origin + '/api/background/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function processJob(job, env) {
  const jobId = String(job?.jobId || '');
  if (!jobId) return;

  let events = [{
    id: 1,
    tool: 'TruX-Code',
    status: 'Background worker started. I’m continuing your coding request safely…'
  }];

  try {
    await updateJob(env, {
      jobId,
      jobSecret: job.jobSecret,
      status: 'running',
      events
    });

    const origin = String(env.TRUX_APP_ORIGIN || APP_ORIGIN_FALLBACK).replace(/\/$/, '');
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

    const response = await fetch(origin + '/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new Error(text || 'The coding backend returned an error.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalText = '';
    let seq = 1;

    const handleEvent = async (raw) => {
      if (!raw) return;
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        return;
      }

      if (event.type === 'progress' || event.type === 'chunk') {
        /*
         * Both event types carry visible text, but they have different
         * meanings:
         *   - progress = TruX-Code keep-alive / activity prose
         *   - chunk   = actual model response text
         *
         * The background worker must forward BOTH. Previously it only handled
         * progress, so streamed model text was silently discarded.
         */
        const progress = String(event.text || '');
        if (progress) {
          events.push({
            id: ++seq,
            type: 'text',
            text: progress
          });
          events = events.slice(-30);
          await updateJob(env, { jobId, jobSecret: job.jobSecret, status: 'running', events });
        }
        return;
      }

      if (event.type === 'tool_status') {
        events.push({
          id: ++seq,
          type: 'tool_status',
          phase: event.phase || 'complete',
          tool: String(event.tool || 'GitHub Tool'),
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

      if (event.type === 'github_proposal') {
        await updateJob(env, { jobId, jobSecret: job.jobSecret, status: 'running', events, proposal: event.proposal || null });
        return;
      }

      if (event.type === 'final') {
        finalText = String(event.text || '');
      }

      if (event.type === 'error') {
        throw new Error(String(event.error || 'Coding request failed.'));
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || '';

      for (const frame of frames) {
        const lines = frame
          .split(/\r?\n/)
          .filter(line => line.startsWith('data:'));

        if (lines.length) {
          await handleEvent(lines.map(line => line.slice(5).trimStart()).join('\n'));
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

    if (!finalText.trim()) {
      throw new Error('The coding backend finished without a final response.');
    }

    await updateJob(env, {
      jobId,
      jobSecret: job.jobSecret,
      status: 'complete',
      events,
      final: finalText.trim(),
      error: null
    });
  } catch (error) {
    events.push({
      id: events.length + 1,
      tool: 'TruX-Code',
      status: 'Background run stopped: ' + String(error?.message || 'Unknown error.')
    });

    try {
      await updateJob(env, {
        jobId,
        jobSecret: job.jobSecret,
        status: 'error',
        events: events.slice(-30),
        final: null,
        error: String(error?.message || 'Background coding request failed.')
      });
    } catch {
      // The queue consumer must not loop forever when status persistence is unavailable.
    }

    throw error;
  }
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      await processJob(message.body, env);
    }
  }
};
