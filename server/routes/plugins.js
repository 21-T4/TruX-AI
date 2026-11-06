/* Composio connected apps. */
import { requireUser } from '../lib/firebase.js';
import { HttpError, json, readJson } from '../lib/http.js';
import {
  createPluginAuthLink, deleteConnectedAccount, getPluginById, listConnectedAccounts,
  pluginDetailForResolved, resolveAllPluginToolkits, resolvePluginToolkit
} from '../lib/composio.js';
import { invalidateConnectedApps } from '../chat/context.js';

const LIMIT = { name: 'plugins', capacity: 20, refillPerSecond: 0.3 };

async function list(request, { env }) {
  const user = await requireUser(request, { limit: LIMIT });
  if (!env.COMPOSIO_API_KEY) return json({ configured: false, plugins: [], connectedCount: 0 });
  const [resolved, accounts] = await Promise.all([resolveAllPluginToolkits(env), listConnectedAccounts(env, user.uid)]);
  return json({ configured: true, plugins: resolved.map(item => pluginDetailForResolved(item, accounts)), connectedCount: accounts.length });
}

async function connect(request, { env, url }) {
  const user = await requireUser(request, { limit: LIMIT });
  const body = await readJson(request, 4096);
  const plugin = getPluginById(body?.pluginId);
  if (!plugin) throw new HttpError(400, 'Unknown plugin.');
  const resolved = await resolvePluginToolkit(env, plugin);
  if (!resolved?.slug) throw new HttpError(404, plugin.name + ' is not available in your Composio catalog.');
  const callbackUrl = url.origin + '/?trux_plugins=1&plugin=' + encodeURIComponent(plugin.id) + '&composio_callback=1';
  const link = await createPluginAuthLink(env, user.uid, resolved.slug, callbackUrl);
  invalidateConnectedApps(user.uid);
  return json({ ok: true, pluginId: plugin.id, slug: resolved.slug, redirectUrl: link?.redirect_url || link?.redirectUrl || null });
}

async function disconnect(request, { env }) {
  const user = await requireUser(request, { limit: LIMIT });
  const body = await readJson(request, 4096);
  const plugin = getPluginById(body?.pluginId);
  if (!plugin) throw new HttpError(400, 'Unknown plugin.');
  const accounts = await listConnectedAccounts(env, user.uid);
  const account = accounts.find(item => plugin.slugs.includes(String(item?.toolkit?.slug || item?.toolkit_slug || '').trim()));
  invalidateConnectedApps(user.uid);
  if (!account) return json({ ok: true, disconnected: false, pluginId: plugin.id });
  const accountId = String(account?.id || account?.nano_id || account?.nanoid || account?.connected_account_id || '').trim();
  if (!accountId) throw new HttpError(502, 'Composio did not return a connected account id.');
  await deleteConnectedAccount(env, accountId);
  return json({ ok: true, disconnected: true, pluginId: plugin.id });
}

export const routes = {
  'GET /api/plugins': list,
  'POST /api/plugins/connect': connect,
  'POST /api/plugins/disconnect': disconnect
};
