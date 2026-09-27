import { createGithubSessionCookie, readOAuthState } from '../../github-session.js';


function randomId() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function onRequestGet({ request, env }) {
  try {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return new Response('Missing GitHub OAuth code or state.', { status: 400 });

  const pending = await readOAuthState(request, env);
  if (!pending || pending.state !== state) return new Response('GitHub connection request expired or is invalid. Please try again.', { status: 400 });

  const tokenBody = new URLSearchParams({
    client_id: String(env.GIT_CLIENT_ID || ''),
    client_secret: String(env.GIT_CLIENT_SECRET || ''),
    code,
    redirect_uri: pending.redirectUri
  });
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': 'TruX-Code'
    },
    body: tokenBody.toString()
  });
  const tokenText = await tokenResponse.text();
  let tokenPayload;
  try {
    tokenPayload = JSON.parse(tokenText);
  } catch {
    throw new Error(`GitHub token exchange returned HTTP ${tokenResponse.status}: ${tokenText.slice(0, 160)}`);
  }
  if (!tokenResponse.ok || !tokenPayload.access_token) {
    return new Response(`GitHub authorization failed: ${tokenPayload.error_description || tokenPayload.error || 'unknown error'}`, { status: 502 });
  }

  const profileResponse = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tokenPayload.access_token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'TruX-Code'
    }
  });
  const profileText = await profileResponse.text();
  let profile;
  try {
    profile = JSON.parse(profileText);
  } catch {
    throw new Error(`GitHub profile lookup returned HTTP ${profileResponse.status}: ${profileText.slice(0, 160)}`);
  }
  if (!profileResponse.ok || !profile.login) return new Response(`GitHub profile lookup failed: ${profile.message || 'unknown error'}`, { status: 502 });

  return new Response(null, {
    status: 302,
    headers: {
      Location: pending.returnTo || '/',
      'Set-Cookie': await createGithubSessionCookie(env, { token: tokenPayload.access_token, login: profile.login }, request)
    }
  });

  } catch (error) {
    console.error('GitHub OAuth callback failed', error);
    return new Response(`GitHub connection could not be completed: ${error?.message || 'unknown error'}`, { status: 500 });
  }
}
