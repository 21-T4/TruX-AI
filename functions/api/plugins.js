import { requireFirebaseUser } from '../firebase-auth.js';
import {
  resolveAllPluginToolkits,
  listConnectedAccounts,
  pluginDetailForResolved,
  getPluginById,
  resolvePluginToolkit,
  createPluginAuthLink,
  deleteConnectedAccount
} from '../composio.js';

export async function onRequestGet({ request, env }) {
  if (new URL(request.url).pathname !== '/api/plugins') return new Response('Method Not Allowed', { status: 405 });
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

async function handleConnect({ request, env }) {
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

async function handleDisconnect({ request, env }) {
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

export async function onRequestPost(context) {
  const pathname = new URL(context.request.url).pathname;
  if (pathname === '/api/plugins/connect') return handleConnect(context);
  if (pathname === '/api/plugins/disconnect') return handleDisconnect(context);
  return new Response('Method Not Allowed', { status: 405 });
}
