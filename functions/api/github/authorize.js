import { createOAuthStateCookie } from '../../github-session.js';

function safeReturnTo(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

function randomId() {
  return [...crypto.getRandomValues(new Uint8Array(24))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function cloudRunOrigin(request, env) {
  const configured = String(env.TRUX_APP_ORIGIN || '').trim().replace(/\/$/, '');
  if (/^https?:\/\//i.test(configured)) return configured;

  const forwardedProto = String(request.headers.get('x-forwarded-proto') || 'https')
    .split(',')[0]
    .trim() || 'https';
  const forwardedHost = String(
    request.headers.get('x-forwarded-host') ||
    request.headers.get('host') ||
    ''
  ).split(',')[0].trim();

  if (!forwardedHost) throw new Error('Unable to determine the Cloud Run public hostname.');
  return forwardedProto + '://' + forwardedHost;
}

export async function onRequestGet({ request, env }) {
  if (!env.GIT_CLIENT_ID || !env.GIT_CLIENT_SECRET) {
    return new Response('GitHub OAuth is not configured.', { status: 503 });
  }

  const url = new URL(request.url);
  const state = randomId();

  /*
   * Cloud Run is no longer using the old Cloudflare callback origin.
   * Build the callback from the active Cloud Run/custom-domain origin so the
   * OAuth flow does not depend on a stale GITHUB_REDIRECT_URI variable.
   */
  const redirectUri = cloudRunOrigin(request, env) + '/api/github/callback';

  const github = new URL('https://github.com/login/oauth/authorize');
  github.searchParams.set('client_id', env.GIT_CLIENT_ID);
  github.searchParams.set('redirect_uri', redirectUri);
  github.searchParams.set('scope', 'repo read:user');
  github.searchParams.set('state', state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: github.toString(),
      'Set-Cookie': await createOAuthStateCookie(
        env,
        state,
        safeReturnTo(url.searchParams.get('returnTo')),
        redirectUri,
        request
      )
    }
  });
}
