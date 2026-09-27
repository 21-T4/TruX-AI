import { createOAuthStateCookie } from '../../github-session.js';

function safeReturnTo(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

function randomId() {
  return [...crypto.getRandomValues(new Uint8Array(24))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function onRequestGet({ request, env }) {
  if (!env.GIT_CLIENT_ID || !env.GIT_CLIENT_SECRET) {
    return new Response('GitHub OAuth is not configured.', { status: 503 });
  }

  const url = new URL(request.url);
  const state = randomId();
  const redirectUri = env.GITHUB_REDIRECT_URI || 'https://www.chat.trux.website/api/github/callback';
  const github = new URL('https://github.com/login/oauth/authorize');
  github.searchParams.set('client_id', env.GIT_CLIENT_ID);
  github.searchParams.set('redirect_uri', redirectUri);
  github.searchParams.set('scope', 'repo read:user');
  github.searchParams.set('state', state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: github.toString(),
      'Set-Cookie': await createOAuthStateCookie(env, state, safeReturnTo(url.searchParams.get('returnTo')), redirectUri, request)
    }
  });
}
