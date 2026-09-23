const MAX_FILE_BYTES = 1024 * 1024;
const MAX_EDITS = 8;

function getKv(env) {
  const kv = env.TRUX_GITHUB_KV || env['TruX-Images'] || env.TruX_Images || env.IMAGE_LIMIT_KV;
  if (!kv) throw new Error('TRUX_GITHUB_KV binding is missing.');
  return kv;
}

function getCookie(request, name) {
  return (request.headers.get('Cookie') || '')
    .split(';')
    .map(v => v.trim())
    .find(v => v.startsWith(name + '='))
    ?.slice(name.length + 1) || '';
}

function validRepo(value) {
  return /^[\\w.-]+\\/[\\w.-]+$/.test(String(value || ''));
}

function validPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length < 500
    && !value.split('/').includes('..');
}

function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

function base64ToUtf8(value) {
  const normalized = String(value || '').replace(/\\s/g, '');
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function githubRequest(session, url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + session.token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'TruX-Code',
      ...(options.headers || {})
    }
  });
}

function countExact(source, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const i = source.indexOf(needle, from);
    if (i < 0) return count;
    count++;
    from = i + needle.length;
    if (count > 1) return count;
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const sessionId = getCookie(request, 'trux_github_session');
    const session = sessionId ? await getKv(env).get('github_session_' + sessionId, 'json') : null;
    if (!session?.token) {
      return Response.json({ error: 'Connect GitHub before applying repository changes.' }, { status: 401 });
    }

    const body = await request.json();
    const { repository, branch, edits, message, confirmed } = body || {};

    if (confirmed !== true) {
      return Response.json({ error: 'Explicit confirmation is required before writing to GitHub.' }, { status: 400 });
    }

    if (!validRepo(repository) || !Array.isArray(edits) || edits.length < 1 || edits.length > MAX_EDITS) {
      return Response.json({ error: 'Invalid GitHub edit request.' }, { status: 400 });
    }

    const results = [];

    for (const edit of edits) {
      const path = edit?.path;
      const oldText = typeof edit?.oldText === 'string' ? edit.oldText : '';
      const newText = typeof edit?.newText === 'string' ? edit.newText : '';

      if (!validPath(path) || oldText.length < 1 || oldText.length > 100000 || newText.length > 100000) {
        return Response.json({ error: 'Invalid edit payload for ' + String(path || 'unknown') + '.' }, { status: 400 });
      }

      const query = branch ? '?ref=' + encodeURIComponent(branch) : '';
      const fileResponse = await githubRequest(
        session,
        `https://api.github.com/repos/${repository}/contents/${encodeURI(path)}${query}`
      );
      const filePayload = await fileResponse.json();

      if (!fileResponse.ok || !filePayload?.content || !filePayload?.sha) {
        return Response.json({
          error: `Could not read ${path} before applying the change: ${filePayload?.message || 'GitHub returned an error.'}`
        }, { status: fileResponse.status || 502 });
      }

      const currentContent = base64ToUtf8(filePayload.content);
      const occurrences = countExact(currentContent, oldText);

      if (occurrences !== 1) {
        return Response.json({
          error: `The file ${path} changed since the proposal was prepared, so the exact edit could not be applied safely.`,
          conflict: true,
          path
        }, { status: 409 });
      }

      const nextContent = currentContent.replace(oldText, newText);
      const byteLength = new TextEncoder().encode(nextContent).byteLength;
      if (byteLength > MAX_FILE_BYTES) {
        return Response.json({ error: `The edited file ${path} is larger than 1 MB.` }, { status: 413 });
      }

      const putResponse = await githubRequest(
        session,
        `https://api.github.com/repos/${repository}/contents/${encodeURI(path)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: String(message || `Update ${path} with TruX-Code`).slice(0, 250),
            content: utf8ToBase64(nextContent),
            branch: branch || undefined,
            sha: filePayload.sha
          })
        }
      );

      const putPayload = await putResponse.json();
      if (!putResponse.ok) {
        return Response.json({
          error: putPayload?.message || `GitHub rejected the update to ${path}.`,
          path
        }, { status: putResponse.status || 502 });
      }

      results.push({ path, commit: putPayload?.commit?.sha || null });
    }

    return Response.json({ ok: true, repository, branch: branch || null, results });
  } catch (error) {
    console.error('GitHub apply-edits failed', error);
    return Response.json({ error: error?.message || 'GitHub edit failed.' }, { status: 500 });
  }
}
