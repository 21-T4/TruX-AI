import { getGithubSession } from '../../github-session.js';

const GITHUB_REPOS_TIMEOUT_MS = 15000;

export async function onRequestGet({ request, env }) {
  try {
    const session = await getGithubSession(request, env);
    if (!session?.token) return Response.json({ error: 'GitHub is not connected.' }, { status: 401 });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GITHUB_REPOS_TIMEOUT_MS);
    let r;
    try {
      r = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
        signal: controller.signal,
        headers: {
          Authorization: 'Bearer ' + session.token,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'TruX-Code'
        }
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('GitHub repository refresh timed out after 15 seconds.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return Response.json({ error: d.message || 'Repository import failed.' }, { status: r.status });

    return Response.json({
      login: session.login,
      repositories: (Array.isArray(d) ? d : []).map(x => ({
        full_name: x.full_name,
        default_branch: x.default_branch,
        private: !!x.private
      }))
    });
  } catch (error) {
    return Response.json({ error: error?.message || 'Repository import failed.' }, { status: 500 });
  }
}
