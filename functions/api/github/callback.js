const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function getKv(env) {
  const kv = env.TRUX_GITHUB_KV || env['TruX-Images'] || env.TruX_Images || env.IMAGE_LIMIT_KV;
  if (!kv) throw new Error('TRUX_GITHUB_KV binding is missing.');
  return kv;
}

function randomId() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function onRequestGet({ request, env }) {
  try {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return new Response('Missing GitHub OAuth code or state.', { status: 400 });

  const kv = getKv(env);
  const stateKey = `github_oauth_state_${state}`;
  const pending = await kv.get(stateKey, 'json');
  if (!pending) return new Response('GitHub connection request expired. Please try again.', { status: 400 });
  await kv.delete(stateKey);

  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: env.GIT_CLIENT_ID,
      client_secret: env.GIT_CLIENT_SECRET,
      code,
      redirect_uri: pending.redirectUri
    })
  });
  const tokenPayload = await tokenResponse.json();
  if (!tokenResponse.ok || !tokenPayload.access_token) {
    return new Response('GitHub authorization failed. Please try again.', { status: 502 });
  }

  const profileResponse = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${tokenPayload.access_token}`, Accept: 'application/vnd.github+json' }
  });
  const profile = await profileResponse.json();
  if (!profileResponse.ok || !profile.login) return new Response('GitHub profile lookup failed.', { status: 502 });

  const sessionId = randomId();
  await kv.put(`github_session_${sessionId}`, JSON.stringify({
    token: tokenPayload.access_token,
    login: profile.login
  }), { expirationTtl: SESSION_TTL_SECONDS });

  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return new Response(null, {
    status: 302,
    headers: {
      Location: pending.returnTo || '/',
      'Set-Cookie': `trux_github_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}${secure}`
    }
  });

  } catch (error) {
    console.error('GitHub OAuth callback failed', error);
    return new Response(`GitHub connection could not be completed: ${error?.message || 'unknown error'}`, { status: 500 });
  }
}
