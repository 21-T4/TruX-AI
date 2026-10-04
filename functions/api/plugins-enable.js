import { requireFirebaseUser } from '../firebase-auth.js';
import { getPluginById, getEnabledPluginIds, setEnabledPluginIds } from '../composio.js';

export async function onRequestPost({ request, env }) {
  try {
    const user = await requireFirebaseUser(request, env);
    const userId = String(user?.uid || '').trim();
    if (!userId) return Response.json({ error: 'Authenticated user required.' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const pluginId = String(body?.pluginId || '').trim();
    if (!getPluginById(pluginId)) return Response.json({ error: 'Unknown plugin.' }, { status: 400 });

    const enabled = await getEnabledPluginIds(env, userId);
    const next = body?.enabled === false
      ? enabled.filter(id => id !== pluginId)
      : [...new Set([...enabled, pluginId])];

    const saved = await setEnabledPluginIds(env, userId, next);
    return Response.json({ ok: true, enabled: saved });
  } catch (error) {
    return Response.json(
      { error: error?.message || 'Could not update plugin access.' },
      { status: Number(error?.status) || 500 }
    );
  }
}
