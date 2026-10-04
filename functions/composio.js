const COMPOSIO_BASE_URL = 'https://backend.composio.dev/api/v3.1';

export const PLUGIN_CATALOG = [
  { id: 'gmail', name: 'Gmail', group: 'Google Workspace', slugs: ['gmail'], logo: 'https://cdn.simpleicons.org/gmail',  description: 'Email, search, threads, labels and mailbox actions.' },
  { id: 'google-sheets', name: 'Google Sheets', group: 'Google Workspace', slugs: ['googlesheets'], logo: 'https://cdn.simpleicons.org/googlesheets',  description: 'Read, write and manage spreadsheets.' },
  { id: 'google-docs', name: 'Google Docs', group: 'Google Workspace', slugs: ['googledocs'], logo: 'https://cdn.simpleicons.org/googledocs',  description: 'Create, read and edit Google documents.' },
  { id: 'google-calendar', name: 'Google Calendar', group: 'Google Workspace', slugs: ['googlecalendar'], logo: 'https://cdn.simpleicons.org/googlecalendar',  description: 'Events, schedules, attendees and calendars.' },
  { id: 'google-drive', name: 'Google Drive', group: 'Google Workspace', slugs: ['googledrive'], logo: 'https://cdn.simpleicons.org/googledrive',  description: 'Files, folders, search and sharing.' },
  { id: 'google-meet', name: 'Google Meet', group: 'Google Workspace', slugs: ['googlemeet'], logo: 'https://cdn.simpleicons.org/googlemeet',  description: 'Meetings, spaces and conference workflows.' },
  { id: 'google-chat', name: 'Google Chat', group: 'Google Workspace', slugs: ['google_chat'], logo: 'https://cdn.simpleicons.org/googlechat',  description: 'Spaces, messages and conversations.' },
  { id: 'google-admin', name: 'Google Admin', group: 'Google Workspace', slugs: ['google_admin'], logo: 'https://cdn.simpleicons.org/google',  description: 'Workspace administration and directory operations.' },

  { id: 'microsoft-word', name: 'Microsoft Word', group: 'Microsoft 365', slugs: ['word', 'msword', 'microsoft_word'], logo: 'https://cdn.simpleicons.org/microsoftword',  description: 'Documents, content and Word workflows.' },
  { id: 'microsoft-excel', name: 'Microsoft Excel', group: 'Microsoft 365', slugs: ['excel'], logo: 'https://cdn.simpleicons.org/microsoftexcel',  description: 'Workbooks, ranges, tables and formulas.' },
  { id: 'microsoft-powerpoint', name: 'Microsoft PowerPoint', group: 'Microsoft 365', slugs: ['powerpoint', 'microsoft_powerpoint'], logo: 'https://cdn.simpleicons.org/microsoftpowerpoint',  description: 'Presentations, slides and PowerPoint workflows.' },
  { id: 'microsoft-outlook', name: 'Microsoft Outlook (Mail & Calendar)', group: 'Microsoft 365', slugs: ['outlook'], logo: 'https://cdn.simpleicons.org/microsoftoutlook',  description: 'Email, contacts and calendar operations.' },
  { id: 'microsoft-teams', name: 'Microsoft Teams', group: 'Microsoft 365', slugs: ['msft_teams'], logo: 'https://cdn.simpleicons.org/microsoftteams',  description: 'Chats, teams, channels and collaboration.' },
  { id: 'microsoft-onedrive', name: 'Microsoft OneDrive', group: 'Microsoft 365', slugs: ['one_drive'], logo: 'https://cdn.simpleicons.org/microsoftonedrive',  description: 'Files and folders in OneDrive.' },
  { id: 'microsoft-sharepoint', name: 'Microsoft SharePoint', group: 'Microsoft 365', slugs: ['share_point'], logo: 'https://cdn.simpleicons.org/microsoftsharepoint',  description: 'Sites, lists, libraries and collaboration.' },
  { id: 'microsoft-onenote', name: 'Microsoft OneNote', group: 'Microsoft 365', slugs: ['onenote'], logo: 'https://cdn.simpleicons.org/microsoftonenote',  description: 'Notebooks, sections and notes.' },

  { id: 'supabase', name: 'Supabase', group: 'Developer & Cloud', slugs: ['supabase'], logo: 'https://cdn.simpleicons.org/supabase',  description: 'Database, projects and backend workflows.' },
  { id: 'github', name: 'GitHub', group: 'Developer & Cloud', slugs: ['github'], logo: 'https://cdn.simpleicons.org/github',  description: 'Repositories, issues, pull requests and code workflows.' },
  { id: 'gitlab', name: 'GitLab', group: 'Developer & Cloud', slugs: ['gitlab'], logo: 'https://cdn.simpleicons.org/gitlab',  description: 'Projects, repositories, issues and CI workflows.' },
  { id: 'aws', name: 'AWS / Amazon Web Services', group: 'Developer & Cloud', slugs: ['aws', 'amazon_web_services', 'aws_2'], logo: 'https://cdn.simpleicons.org/amazonaws',  description: 'AWS cloud workflows exposed by Composio.' },
  { id: 'google-cloud', name: 'Google Cloud Console', group: 'Developer & Cloud', slugs: ['gcp', 'google_cloud', 'googlecloud'], logo: 'https://cdn.simpleicons.org/googlecloud',  description: 'Google Cloud project and platform workflows available through Composio.' }
];

const toolkitCache = new Map();

function requireApiKey(env) {
  const apiKey = String(env?.COMPOSIO_API_KEY || '').trim();
  if (!apiKey) {
    throw Object.assign(new Error('COMPOSIO_API_KEY is not configured on the server.'), { status: 503 });
  }
  return apiKey;
}

async function composioRequest(env, pathname, init = {}) {
  const apiKey = requireApiKey(env);
  const response = await fetch(COMPOSIO_BASE_URL + pathname, {
    ...init,
    headers: {
      'x-api-key': apiKey,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {})
    }
  });

  const raw = await response.text();
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw }; }

  if (!response.ok) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      payload?.error ||
      raw ||
      ('Composio request failed with HTTP ' + response.status);
    throw Object.assign(new Error(String(message)), { status: response.status, composio: payload });
  }

  return payload;
}

export async function resolvePluginToolkit(env, plugin) {
  const candidates = Array.isArray(plugin?.slugs) ? plugin.slugs : [];
  for (const slug of candidates) {
    const cacheKey = 'toolkit:' + slug;
    const cached = toolkitCache.get(cacheKey);
    if (cached) return { slug, detail: await cached };

    const pending = (async () => {
      try {
        return await composioRequest(env, '/toolkits/' + encodeURIComponent(slug) + '?version=latest');
      } catch (error) {
        if (error?.status === 404) return null;
        throw error;
      }
    })();

    toolkitCache.set(cacheKey, pending);
    try {
      const detail = await pending;
      if (detail) {
        toolkitCache.set(cacheKey, Promise.resolve(detail));
        return { slug, detail };
      }
      toolkitCache.delete(cacheKey);
    } catch (error) {
      toolkitCache.delete(cacheKey);
      throw error;
    }
  }
  return { slug: '', detail: null };
}

export async function resolveAllPluginToolkits(env) {
  return await Promise.all(PLUGIN_CATALOG.map(async plugin => {
    try {
      const resolved = await resolvePluginToolkit(env, plugin);
      return { plugin, ...resolved };
    } catch (error) {
      return { plugin, slug: '', detail: null, error: String(error?.message || error) };
    }
  }));
}

function authConfigCandidates(detail) {
  return Array.isArray(detail?.auth_config_details)
    ? detail.auth_config_details
    : (Array.isArray(detail?.authConfigDetails) ? detail.authConfigDetails : []);
}

async function getManagedAuthConfig(env, toolkitSlug) {
  const query = new URLSearchParams({
    toolkit_slug: toolkitSlug,
    is_composio_managed: 'true',
    show_disabled: 'false',
    limit: '50'
  });

  const payload = await composioRequest(env, '/auth_configs?' + query.toString());
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const managed = items.find(item =>
    item?.status === 'ENABLED' &&
    (item?.isComposioManaged === true || item?.is_composio_managed === true) &&
    item?.id
  );
  if (managed) return managed;

  // Some managed OAuth toolkits may not have a project auth config yet.
  // Create the default Composio-managed auth config once, then return it.
  try {
    const created = await composioRequest(env, '/auth_configs', {
      method: 'POST',
      body: JSON.stringify({
        toolkit: { slug: toolkitSlug },
        auth_config: {
          type: 'use_composio_managed_auth',
          credentials: {},
          restrict_to_following_tools: []
        }
      })
    });
    const createdConfig = created?.auth_config || created?.authConfig || null;
    if (createdConfig?.id) return createdConfig;
  } catch (error) {
    // A toolkit without managed OAuth/configuration stays unavailable.
    if (error?.status !== 404 && error?.status !== 400) throw error;
  }

  return null;
}

export async function createPluginAuthLink(env, userId, toolkitSlug, callbackUrl) {
  const authConfig = await getManagedAuthConfig(env, toolkitSlug);
  if (!authConfig?.id) {
    throw new Error('No enabled Composio-managed authentication config is available for this plugin.');
  }

  return await composioRequest(env, '/connected_accounts/link', {
    method: 'POST',
    body: JSON.stringify({
      auth_config_id: authConfig.id,
      user_id: userId,
      alias: 'trux-' + toolkitSlug,
      callback_url: callbackUrl
    })
  });
}

export async function listConnectedAccounts(env, userId) {
  const query = new URLSearchParams();
  query.set('user_ids', userId);
  query.set('statuses', 'ACTIVE');
  query.set('account_type', 'PRIVATE');
  query.set('limit', '200');

  const payload = await composioRequest(env, '/connected_accounts?' + query.toString());
  return Array.isArray(payload?.items) ? payload.items : [];
}

export function connectedToolkitSet(accounts) {
  return new Set(
    accounts
      .map(account => account?.toolkit?.slug || account?.toolkit_slug || '')
      .filter(Boolean)
      .map(String)
  );
}

export function pluginDetailForResolved(resolved, connectedSlugs, enabledIds) {
  const plugin = resolved.plugin;
  const detail = resolved.detail;
  const actualSlug = resolved.slug || '';
  const meta = detail?.meta || {};
  const connected = !!actualSlug && connectedSlugs.has(actualSlug);
  const enabled = enabledIds.includes(plugin.id);
  return {
    id: plugin.id,
    name: plugin.name,
    group: plugin.group,
    description: meta.description || plugin.description,
    logo: meta.logo || plugin.logo || null,
    appUrl: meta.app_url || meta.appUrl || null,
    slug: actualSlug,
    configured: !!detail,
    connected,
    enabled,
    authAvailable: Array.isArray(detail?.auth_config_details) && detail.auth_config_details.length > 0,
    toolsCount: Number(meta.tools_count || meta.toolsCount || 0) || 0
  };
}

function schemaFromInputParameters(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    if (input.type === 'object' && input.properties) return input;
    if (input.schema && typeof input.schema === 'object') return input.schema;
  }

  const properties = {};
  const required = [];

  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const [key, value] of Object.entries(input)) {
      if (!value || typeof value !== 'object') continue;
      properties[key] = normalizeSchema(value);
      if (value.required === true) required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {})
  };
}

function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'string' };
  if (schema.anyOf || schema.oneOf || schema.allOf) return schema;
  if (schema.type) return schema;
  if (schema.properties) return { type: 'object', ...schema };
  if (schema.enum) return { type: 'string', ...schema };
  return { type: 'string', description: schema.description || '' };
}

export async function getComposioGeminiTools(env, enabledToolkitSlugs, queryText = '') {
  const slugs = [...new Set((enabledToolkitSlugs || []).filter(Boolean).map(String))];
  if (!slugs.length) return { declarations: [], metadata: new Map() };

  const params = new URLSearchParams({
    toolkit_slug: slugs.join(','),
    toolkit_versions: 'latest',
    include_deprecated: 'false',
    limit: '100'
  });

  const query = String(queryText || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (query) params.set('query', query);

  let payload;
  try {
    payload = await composioRequest(env, '/tools?' + params.toString());
  } catch (error) {
    if (!query) throw error;
    const fallback = new URLSearchParams({
      toolkit_slug: slugs.join(','),
      toolkit_versions: 'latest',
      include_deprecated: 'false',
      limit: '100'
    });
    payload = await composioRequest(env, '/tools?' + fallback.toString());
  }

  const items = Array.isArray(payload?.items) ? payload.items : [];
  const declarations = [];
  const metadata = new Map();

  for (const item of items) {
    const slug = String(item?.slug || item?.name || '').trim();
    if (!slug || declarations.some(tool => tool.name === slug)) continue;

    const toolkitSlug = String(item?.toolkit?.slug || item?.toolkit_slug || '').trim();
    if (!toolkitSlug || !slugs.includes(toolkitSlug)) continue;

    const schema = schemaFromInputParameters(item?.input_parameters || item?.inputParameters || item?.parameters);
    const declaration = {
      name: slug,
      description: String(item?.description || item?.name || slug).slice(0, 1200),
      parameters: schema
    };

    declarations.push(declaration);
    metadata.set(slug, {
      toolkitSlug,
      toolkitName: String(item?.toolkit?.name || toolkitSlug),
      name: String(item?.name || slug)
    });
  }

  return { declarations, metadata };
}

export async function executeComposioTool(env, userId, toolSlug, args, metadata = null) {
  const body = {
    user_id: userId,
    arguments: args && typeof args === 'object' ? args : {},
    version: 'latest'
  };

  const result = await composioRequest(
    env,
    '/tools/execute/' + encodeURIComponent(toolSlug),
    { method: 'POST', body: JSON.stringify(body) }
  );

  return {
    success: result?.successful !== false && result?.success !== false,
    tool: toolSlug,
    toolkit: metadata?.toolkitSlug || null,
    result
  };
}

export async function getEnabledPluginIds(env, userId) {
  if (!userId) return [];
  const kv = (await import('./cloud-run-store.js')).getCloudRunKv(env);
  const data = await kv.get('trux_composio_plugins_' + userId, 'json').catch(() => []);
  return Array.isArray(data) ? data : [];
}

export async function setEnabledPluginIds(env, userId, pluginIds) {
  const kv = (await import('./cloud-run-store.js')).getCloudRunKv(env);
  const allowed = new Set(PLUGIN_CATALOG.map(plugin => plugin.id));
  const clean = [...new Set((Array.isArray(pluginIds) ? pluginIds : []).map(String).filter(id => allowed.has(id)))];
  await kv.put('trux_composio_plugins_' + userId, JSON.stringify(clean));
  return clean;
}

export function getPluginById(id) {
  return PLUGIN_CATALOG.find(plugin => plugin.id === String(id)) || null;
}
