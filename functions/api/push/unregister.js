function getKv(env) {
  const kv = env.TRUX_BACKGROUND_KV || env.TRUX_GITHUB_KV || env['TruX-Images'] || env.TruX_Images || env.IMAGE_LIMIT_KV;
  if (!kv) throw new Error('Push notification KV binding is missing.');
  return kv;
}

export async function onRequestPost({ request, env }) {
  try {
    const { userId, token } = await request.json();
    if (!userId || typeof token !== 'string') return Response.json({ ok: true });

    const kv = getKv(env);
    const key = 'trux_push_tokens_' + String(userId);
    const existing = await kv.get(key, 'json');
    const tokens = Array.isArray(existing) ? existing.filter(x => x !== token) : [];
    await kv.put(key, JSON.stringify(tokens), { expirationTtl: 180 * 24 * 60 * 60 });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: true });
  }
}
