import { getGithubSession } from '../../github-session.js';

export async function onRequestGet({ request, env }) {
  try {
    const session = await getGithubSession(request, env);
    if (!session?.token) return Response.json({ error: 'GitHub is not connected.' }, { status: 401 });

    const repositories = [];
    let page = 1;

    while (true) {
      const r = await fetch(
        'https://api.github.com/user/repos?per_page=100&sort=updated&page=' + page,
        {
          headers: {
            Authorization: 'Bearer ' + session.token,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'TruX-Code'
          }
        }
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        return Response.json({
          error: d.message || 'Repository import failed.'
        }, { status: r.status });
      }

      if (Array.isArray(d)) repositories.push(...d);
      const link = String(r.headers.get('Link') || '');
      if (!/<[^>]+>;\s*rel="next"/i.test(link)) break;
      page += 1;
    }

    const unique = new Map();
    for (const x of repositories) {
      if (!x?.full_name) continue;
      unique.set(String(x.full_name), {
        full_name: x.full_name,
        default_branch: x.default_branch,
        private: !!x.private
      });
    }

    return Response.json({
      login: session.login,
      repositories: Array.from(unique.values())
    });
  } catch (error) {
    return Response.json({ error: error?.message || 'Repository import failed.' }, { status: 500 });
  }
}
