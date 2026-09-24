function getKv(env) {
  const kv = env.TRUX_GITHUB_KV || env['TruX-Images'] || env.TruX_Images || env.IMAGE_LIMIT_KV;
  if (!kv) throw new Error('TRUX_GITHUB_KV binding is missing.');
}

export async function onRequestPost({ request, env }) {
  try {
    const kv = env.TRUX_GITHUB_KV || env['TruX-Images'] || env.TruX_Images || env.IMAGE_LIMIT_KV;
    if (!kv) throw new Error('TRUX_GITHUB_KV binding is missing.');

    const cookie = request.headers.get('Cookie') || '';
    const sessionId = cookie.split(';').map(v => v.trim())
      .find(v => v.startsWith('trux_github_session='))
      ?.slice('trux_github_session='.length) || '';

    if (sessionId) await kv.delete('github_session_' + sessionId);

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': 'trux_github_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
      }
    });
  } catch (error) {
    return Response.json({ error: error?.message || 'GitHub disconnect failed.' }, { status: 500 });
  }
}
