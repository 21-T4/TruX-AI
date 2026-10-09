import { requireFirebaseUser } from '../firebase-auth.js';
import {
  resolveAllPluginToolkits,
  listConnectedAccounts,
  pluginDetailForResolved,
} from '../composio.js';

export async function onRequestGet({ request, env }) {
  try {
    const user = await requireFirebaseUser(request, env);
    const userId = String(user?.uid || '').trim();
    if (!userId) return Response.json({ error: 'Authenticated user required.' }, { status: 401 });

    const resolved = await resolveAllPluginToolkits(env);
    const accounts = await listConnectedAccounts(env, userId);

    return Response.json({
      configured: !!String(env.COMPOSIO_API_KEY || '').trim(),
      plugins: resolved.map(item => pluginDetailForResolved(item, accounts)),
      connectedCount: accounts.length
    });
  } catch (error) {
    return Response.json(
      { error: error?.message || 'Could not load Composio plugins.' },
      { status: Number(error?.status) || 500 }
    );
  }
}
