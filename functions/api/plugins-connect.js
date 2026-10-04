import { requireFirebaseUser } from '../firebase-auth.js';
import {
  getPluginById,
  resolvePluginToolkit,
  createPluginAuthLink
} from '../composio.js';

export async function onRequestPost({ request, env }) {
  try {
    const user = await requireFirebaseUser(request, env);
    const userId = String(user?.uid || '').trim();
    if (!userId) return Response.json({ error: 'Authenticated user required.' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const plugin = getPluginById(body?.pluginId);
    if (!plugin) return Response.json({ error: 'Unknown plugin.' }, { status: 400 });

    const resolved = await resolvePluginToolkit(env, plugin);
    if (!resolved?.slug) {
      return Response.json({ error: plugin.name + ' is not currently available in your Composio catalog.' }, { status: 404 });
    }

    const origin = new URL(request.url).origin;
    const callbackUrl =
      origin + '/?trux_plugins=1&plugin=' + encodeURIComponent(plugin.id) + '&composio_callback=1';

    const link = await createPluginAuthLink(env, userId, resolved.slug, callbackUrl);
    return Response.json({
      ok: true,
      pluginId: plugin.id,
      slug: resolved.slug,
      redirectUrl: link?.redirect_url || link?.redirectUrl || null,
      connectedAccountId: link?.connected_account_id || link?.connectedAccountId || null
    });
  } catch (error) {
    return Response.json(
      { error: error?.message || 'Could not start plugin connection.' },
      { status: Number(error?.status) || 500 }
    );
  }
}
