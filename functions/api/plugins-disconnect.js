import { requireFirebaseUser } from '../firebase-auth.js';
import {
  getPluginById,
  listConnectedAccounts,
  deleteConnectedAccount
} from '../composio.js';

export async function onRequestPost({ request, env }) {
  try {
    const user = await requireFirebaseUser(request, env);
    const userId = String(user?.uid || '').trim();
    if (!userId) return Response.json({ error: 'Authenticated user required.' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const pluginId = String(body?.pluginId || '').trim();
    const plugin = getPluginById(pluginId);
    if (!plugin) return Response.json({ error: 'Unknown plugin.' }, { status: 400 });

    const accounts = await listConnectedAccounts(env, userId);
    const account = accounts.find(item => {
      const slug = String(item?.toolkit?.slug || item?.toolkit_slug || '').trim();
      return plugin.slugs.includes(slug);
    });

    if (!account) {
      return Response.json({ ok: true, disconnected: false, pluginId });
    }

    const accountId = String(
      account?.id ||
      account?.nano_id ||
      account?.nanoid ||
      account?.connected_account_id ||
      ''
    ).trim();
    if (!accountId) {
      return Response.json({ error: 'Connected account ID was not returned by Composio.' }, { status: 502 });
    }

    await deleteConnectedAccount(env, accountId);

    return Response.json({
      ok: true,
      disconnected: true,
      pluginId
    });
  } catch (error) {
    return Response.json(
      { error: error?.message || 'Could not disconnect plugin.' },
      { status: Number(error?.status) || 500 }
    );
  }
}
