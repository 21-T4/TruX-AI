function getKv(env) {
  const kv = env.TRUX_GITHUB_KV || env['TruX-Images'] || env.TruX_Images || env.IMAGE_LIMIT_KV;
  if (!kv) throw new Error('TRUX_GITHUB_KV binding is missing.');
  return kv;
}

function getCookie(request, name) {
  return (request.headers.get('Cookie') || '').split(';').map(v => v.trim()).find(v => v.startsWith(name + '='))?.slice(name.length + 1) || '';
}

function validRepo(value) { return /^[\w.-]+\/[\w.-]+$/.test(String(value || '')); }
function validPath(value) { return typeof value === 'string' && value.length > 0 && value.length < 500 && !value.split('/').includes('..'); }

export async function onRequestPost({ request, env }) {
  const sessionId = getCookie(request, 'trux_github_session');
  const session = sessionId ? await getKv(env).get(`github_session_${sessionId}`, 'json') : null;
  if (!session?.token) return Response.json({ error: 'Connect GitHub before editing a repository.' }, { status: 401 });

  const { repository, branch, path, content, sha, message, confirmed } = await request.json();
  if (confirmed !== true) return Response.json({ error: 'Explicit confirmation is required before writing to GitHub.' }, { status: 400 });
  if (!validRepo(repository) || !validPath(path) || typeof content !== 'string' || content.length > 1024 * 1024) {
    return Response.json({ error: 'Invalid repository edit request.' }, { status: 400 });
  }

  const response = await fetch(`https://api.github.com/repos/${repository}/contents/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${session.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: String(message || `Update ${path} with TruX-Code`).slice(0, 250),
      content: btoa(unescape(encodeURIComponent(content))),
      branch: branch || undefined,
      sha: sha || undefined
    })
  });
  const payload = await response.json();
  if (!response.ok) return Response.json({ error: payload.message || 'GitHub rejected the edit.' }, { status: response.status });
  return Response.json({ ok: true, commit: payload.commit?.sha, content: payload.content?.path });
}
