const STATE_TTL_SECONDS = 10 * 60;

function getKv(env) {
  const kv = env.TRUX_GITHUB_KV || env['TruX-Images'] || env.TruX_Images || env.IMAGE_LIMIT_KV;
  if (!kv) throw new Error('TRUX_GITHUB_KV binding is missing.');
  return kv;
}

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
  const kv = getKv(env);

  await kv.put(`github_oauth_state_${state}`, JSON.stringify({
    returnTo: safeReturnTo(url.searchParams.get('returnTo')),
    redirectUri
  }), { expirationTtl: STATE_TTL_SECONDS });

  const github = new URL('https://github.com/login/oauth/authorize');
  github.searchParams.set('client_id', env.GIT_CLIENT_ID);
  github.searchParams.set('redirect_uri', redirectUri);
  github.searchParams.set('scope', 'repo read:user');
  github.searchParams.set('state', state);

  return Response.redirect(github.toString(), 302);
}
