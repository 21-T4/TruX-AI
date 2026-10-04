import { getCloudRunKv } from '../cloud-run-store.js';
import { requireFirebaseUser } from '../firebase-auth.js';
import {
  resolveAllPluginToolkits,
  listConnectedAccounts,
  connectedToolkitSet,
  pluginDetailForResolved,
  getEnabledPluginIds
} from '../composio.js';

export async function onRequestGet({ request, env }) {
  try {
    const user = await requireFirebaseUser(request, env);
    const userId = String(user?.uid || '').trim();
    if (!userId) return Response.json({ error: 'Authenticated user required.' }, { status: 401 });

    const resolved = await resolveAllPluginToolkits(env);
    const accounts = await listConnectedAccounts(env, userId);
    const connected = connectedToolkitSet(accounts);
    const enabled = await getEnabledPluginIds(env, userId);

    return Response.json({
      configured: !!String(env.COMPOSIO_API_KEY || '').trim(),
      plugins: resolved.map(item => pluginDetailForResolved(item, connected, enabled)),
      connectedCount: accounts.length,
      enabledCount: enabled.length
    });
  } catch (error) {
    return Response.json(
      { error: error?.message || 'Could not load Composio plugins.' },
      { status: Number(error?.status) || 500 }
    );
  }
}
