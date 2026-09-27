import { clearGithubSessionCookie } from '../../github-session.js';

export async function onRequestPost({ request }) {
  try {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': clearGithubSessionCookie(request)
      }
    });
  } catch (error) {
    return Response.json({ error: error?.message || 'GitHub disconnect failed.' }, { status: 500 });
  }
}
