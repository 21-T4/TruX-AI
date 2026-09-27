import { getGithubSession } from '../../github-session.js';

function validSession(session) { return !!session?.token; }

export async function onRequestGet({ request, env }) {
  try {
    const session = await getGithubSession(request, env);
    if (!validSession(session)) return Response.json({ error: 'GitHub is not connected.' }, { status: 401 });

    const r = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
      headers: {
        Authorization: 'Bearer ' + session.token,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'TruX-Code'
      }
    });
    const d = await r.json();
    if (!r.ok) return Response.json({ error: d.message || 'Repository import failed.' }, { status: r.status });
    return Response.json({
      login: session.login,
      repositories: d.map(x => ({ full_name: x.full_name, default_branch: x.default_branch, private: !!x.private }))
    });
  } catch (x) {
    return Response.json({ error: x?.message || 'Repository import failed.' }, { status: 500 });
  }
}
