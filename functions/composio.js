const COMPOSIO_BASE_URL = 'https://backend.composio.dev/api/v3.1';

export const PLUGIN_CATALOG = [
  { id: 'gmail', name: 'Gmail', group: 'Google Workspace', slugs: ['gmail'], logo: 'https://cdn.simpleicons.org/gmail', description: 'Email, search, labels, threads and mailbox actions.' },
  { id: 'google-sheets', name: 'Google Sheets', group: 'Google Workspace', slugs: ['googlesheets'], logo: 'https://cdn.simpleicons.org/googlesheets', description: 'Read and update spreadsheets, ranges and tables.' },
  { id: 'google-docs', name: 'Google Docs', group: 'Google Workspace', slugs: ['googledocs'], logo: 'https://cdn.simpleicons.org/googledocs', description: 'Create, read and edit Google documents.' },
  { id: 'google-calendar', name: 'Google Calendar', group: 'Google Workspace', slugs: ['googlecalendar'], logo: 'https://cdn.simpleicons.org/googlecalendar', description: 'Create, search and manage calendar events.' },
  { id: 'google-drive', name: 'Google Drive', group: 'Google Workspace', slugs: ['googledrive'], logo: 'https://cdn.simpleicons.org/googledrive', description: 'Search, read and manage Drive files and folders.' },
  { id: 'google-meet', name: 'Google Meet', group: 'Google Workspace', slugs: ['googlemeet'], logo: 'https://cdn.simpleicons.org/googlemeet', description: 'Create meetings and work with conference details, transcripts and recordings.' },

  { id: 'microsoft-excel', name: 'Microsoft Excel', group: 'Microsoft 365', slugs: ['excel'], logo: 'https://cdn.simpleicons.org/microsoftexcel', description: 'Work with workbooks, worksheets, ranges, tables and charts.' },
  { id: 'microsoft-teams', name: 'Microsoft Teams', group: 'Microsoft 365', slugs: ['microsoft_teams'], logo: 'https://cdn.simpleicons.org/microsoftteams', description: 'Teams, chats, channels and collaboration.' },
  { id: 'microsoft-outlook', name: 'Microsoft Outlook', group: 'Microsoft 365', slugs: ['outlook'], logo: 'https://cdn.simpleicons.org/microsoftoutlook', description: 'Email, calendar and contact workflows.' },
  { id: 'microsoft-onedrive', name: 'Microsoft OneDrive', group: 'Microsoft 365', slugs: ['one_drive'], logo: 'https://cdn.simpleicons.org/microsoftonedrive', description: 'Search, read, upload and manage cloud files.' },

  { id: 'github', name: 'GitHub', group: 'Developer', slugs: ['github'], logo: 'https://cdn.simpleicons.org/github', description: 'Repositories, issues, pull requests and code workflows.' },
  { id: 'slack', name: 'Slack', group: 'Work & Collaboration', slugs: ['slack'], logo: 'https://cdn.simpleicons.org/slack', description: 'Channels, messages, threads and team collaboration.' },
  { id: 'notion', name: 'Notion', group: 'Work & Collaboration', slugs: ['notion'], logo: 'https://cdn.simpleicons.org/notion', description: 'Pages, databases, notes and workspace content.' }
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
    const error = Object.assign(new Error(String(message)), {
      status: response.status,
      composio: payload
    });
    // Composio can report a scoped-project-key denial as a generic 401
    // "Invalid API key". Keep this distinct from a provider OAuth failure.
    if (
      (response.status === 401 || response.status === 403) &&
      /invalid\s+api\s+key|project\s+api\s+key|api\s+key|not permitted|permission/i.test(String(message))
    ) {
      error.composioProjectKeyPermission = true;
    }
    throw error;
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

export async function deleteConnectedAccount(env, connectedAccountId) {
  const id = String(connectedAccountId || '').trim();
  if (!id) throw Object.assign(new Error('Connected account ID is required.'), { status: 400 });
  return await composioRequest(
    env,
    '/connected_accounts/' + encodeURIComponent(id),
    { method: 'DELETE' }
  );
}

export async function listConnectedAccounts(env, userId, toolkitSlug = '') {
  const query = new URLSearchParams();
  query.set('user_ids', userId);
  query.set('statuses', 'ACTIVE');
  query.set('limit', '200');
  if (toolkitSlug) query.set('toolkit_slugs', toolkitSlug);

  const payload = await composioRequest(env, '/connected_accounts?' + query.toString());
  return Array.isArray(payload?.items) ? payload.items : [];
}

function getConnectedAccountId(account) {
  return String(
    account?.id ||
    account?.nanoid ||
    account?.nano_id ||
    account?.connected_account_id ||
    ''
  ).trim();
}

function isLikelyAuthFailure(error) {
  if (error?.composioProjectKeyPermission) return false;
  const status = Number(error?.status) || 0;
  if (status === 401 || status === 403) return true;
  const text = String(
    error?.message ||
    error?.composio?.error?.message ||
    error?.composio?.message ||
    error?.composio?.error ||
    ''
  ).toLowerCase();
  return /unauthori[sz]ed|forbidden|permission|scope|oauth|authentication|credential|token|invalid.?grant|reauthor|not connected|expired/.test(text);
}

async function createReconnectUrl(env, userId, toolkitSlug, callbackUrl) {
  if (!callbackUrl) return null;
  const plugin = PLUGIN_CATALOG.find(item =>
    Array.isArray(item?.slugs) && item.slugs.includes(String(toolkitSlug))
  );
  if (!plugin) return null;
  try {
    const link = await createPluginAuthLink(env, userId, String(toolkitSlug), callbackUrl);
    return link?.redirect_url || link?.redirectUrl || null;
  } catch {
    return null;
  }
}

export function pluginDetailForResolved(resolved, connectedAccounts) {
  const plugin = resolved.plugin;
  const detail = resolved.detail;
  const actualSlug = resolved.slug || '';
  const meta = detail?.meta || {};
  const matchingAccount = actualSlug
    ? (Array.isArray(connectedAccounts)
      ? connectedAccounts.find(account => String(account?.toolkit?.slug || account?.toolkit_slug || '') === actualSlug)
      : null)
    : null;
  const connected = !!actualSlug && !!matchingAccount;
  // A connected app may be offered to the agent for contextual discovery.
  // The model decides whether an action is useful and must respect user intent.
  const enabled = connected;
  return {
    id: plugin.id,
    name: plugin.name,
    group: plugin.group,
    description: meta.description || plugin.description,
    logo: meta.logo || plugin.logo || null,
    appUrl: meta.app_url || meta.appUrl || null,
    slug: actualSlug,
    configured: !!detail,
    connectable: !!actualSlug,
    connected,
    connectedAccountId: matchingAccount?.id || matchingAccount?.nano_id || matchingAccount?.nanoid || matchingAccount?.connected_account_id || null,
    enabled,
    authAvailable: Array.isArray(detail?.auth_config_details) && detail.auth_config_details.length > 0,
    toolsCount: Number(meta.tools_count || meta.toolsCount || 0) || 0
  };
}

/*
 * Gemini/Vertex function declarations accept a limited OpenAPI-like schema.
 * Composio's input metadata is richer (examples, human_* fields, defaults,
 * internal metadata, etc.). Never forward that metadata verbatim.
 */
const GEMINI_SCHEMA_KEYS = new Set([
  'type','nullable','required','format','description','properties',
  'items','enum','anyOf','$ref','$defs'
]);

function sanitizeGeminiSchema(value, fallbackType = 'string') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { type: fallbackType };
  }

  // Gemini function declarations accept a restricted OpenAPI-style schema.
  // Never pass Composio's richer metadata (examples, human_* labels, defaults,
  // internal UI fields, JSON-Schema refs, etc.) to Vertex unchanged.
  if (Array.isArray(value.anyOf) && value.anyOf.length) {
    return {
      anyOf: value.anyOf
        .filter(v => v && typeof v === 'object')
        .map(v => sanitizeGeminiSchema(v))
        .filter(v => v && typeof v === 'object')
    };
  }

  const out = {};

  // Composio/JSON-Schema may encode a union as type: ["string","null"].
  // Vertex's OpenAPI-style Schema expects a single type plus nullable.
  if (Array.isArray(value.type)) {
    const types = value.type.map(v => String(v || '').trim().toLowerCase()).filter(Boolean);
    const nonNullType = types.find(v => v !== 'null');
    if (nonNullType) out.type = nonNullType;
    if (types.includes('null')) out.nullable = true;
  } else if (value.type) {
    out.type = String(value.type).trim().toLowerCase();
  }

  if (value.nullable != null) out.nullable = !!value.nullable;
  if (value.description) out.description = String(value.description);
  if (value.format) out.format = String(value.format);

  // Preserve enum scalar types. Converting numbers/booleans to strings can
  // make an otherwise valid function schema incompatible with Vertex.
  if (Array.isArray(value.enum)) {
    out.enum = value.enum
      .filter(v => v == null || ['string','number','boolean'].includes(typeof v))
      .slice(0, 256);
  }

  if (value.items && typeof value.items === 'object') {
    out.items = sanitizeGeminiSchema(value.items);
  }

  if (value.properties && typeof value.properties === 'object' && !Array.isArray(value.properties)) {
    out.properties = Object.fromEntries(
      Object.entries(value.properties).map(([name, schema]) => [
        name,
        sanitizeGeminiSchema(schema)
      ])
    );
    out.type = 'object';
  }

  if (Array.isArray(value.required)) {
    const required = value.required.map(String);
    out.required = out.properties
      ? required.filter(name => Object.prototype.hasOwnProperty.call(out.properties, name))
      : required;
    if (!out.required.length) delete out.required;
  }

  if (!out.type) {
    if (out.properties) out.type = 'object';
    else if (out.enum) out.type = 'string';
    else if (out.items) out.type = 'array';
    else out.type = fallbackType;
  }

  return out;
}
function schemaFromInputParameters(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    if (input.type === 'object' && input.properties) return sanitizeGeminiSchema(input, 'object');
    if (input.schema && typeof input.schema === 'object') return sanitizeGeminiSchema(input.schema, 'object');
  }

  const properties = {};
  const required = [];

  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const [key, value] of Object.entries(input)) {
      if (!value || typeof value !== 'object') continue;
      properties[key] = sanitizeGeminiSchema(value);
      if (value.required === true) required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {})
  };
}

export async function getComposioGeminiTools(env, enabledToolkitSlugs, queryText = '') {
  const slugs = [...new Set(
    (enabledToolkitSlugs || []).filter(Boolean).map(String)
  )];
  if (!slugs.length) return { declarations: [], metadata: new Map() };

  const baseParams = new URLSearchParams({
    toolkit_slug: slugs.join(','),
    toolkit_versions: 'latest',
    include_deprecated: 'false',
    limit: '100'
  });

  const requested = String(queryText || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  // The agent supplies the goal for discovery. Do not force a preset action
  // list or append integration-specific commands behind the model's back.
  if (!requested) return { declarations: [], metadata: new Map() };

  const params = new URLSearchParams(baseParams);
  params.set('query', requested);
  let payload;
  try {
    payload = await composioRequest(env, '/tools?' + params.toString());
  } catch (error) {
    if (error?.status) payload = null;
    else throw error;
  }

  const items = [];
  const seenItems = new Set();

  for (const item of Array.isArray(payload?.items) ? payload.items : []) {
    const slug = String(item?.slug || item?.name || '').trim();
    if (!slug || seenItems.has(slug)) continue;
    seenItems.add(slug);
    items.push(item);
  }

  const declarations = [];
  const metadata = new Map();

  for (const item of items) {
    const slug = String(item?.slug || item?.name || '').trim();
    if (!slug || declarations.some(tool => tool.name === slug)) continue;

    const toolkitSlug = String(
      item?.toolkit?.slug || item?.toolkit_slug || ''
    ).trim();

    if (!toolkitSlug || !slugs.includes(toolkitSlug)) continue;

    const schema = schemaFromInputParameters(
      item?.input_parameters ||
      item?.inputParameters ||
      item?.parameters
    );

    declarations.push({
      name: slug,
      description: String(
        item?.description || item?.name || slug
      ).slice(0, 1200),
      parameters: schema
    });

    metadata.set(slug, {
      toolkitSlug,
      toolkitName: String(item?.toolkit?.name || toolkitSlug),
      name: String(item?.name || slug)
    });
  }

  return { declarations, metadata };
}

export async function executeComposioTool(env, userId, toolSlug, args, metadata = null, callbackUrl = '') {
  const toolkitSlug = String(metadata?.toolkitSlug || '').trim();

  const accounts = toolkitSlug
    ? await listConnectedAccounts(env, userId, toolkitSlug)
    : await listConnectedAccounts(env, userId);

  const account = accounts.find(item =>
    String(item?.toolkit?.slug || item?.toolkit_slug || '').trim().toLowerCase() ===
    toolkitSlug.toLowerCase()
  );
  const connectedAccountId = getConnectedAccountId(account);

  if (!connectedAccountId) {
    const reconnectUrl = await createReconnectUrl(env, userId, toolkitSlug, callbackUrl);
    return {
      success: false,
      authRequired: true,
      tool: toolSlug,
      toolkit: toolkitSlug || null,
      error: 'This app is not currently authorized for this user. Reconnect it to grant TruX access.',
      reconnectUrl
    };
  }

  const body = {
    connected_account_id: connectedAccountId,
    user_id: userId,
    arguments: args && typeof args === 'object' ? args : {}
  };

  try {
    const result = await composioRequest(
      env,
      '/tools/execute/' + encodeURIComponent(toolSlug),
      { method: 'POST', body: JSON.stringify(body) }
    );

    const success =
      result?.successful !== false &&
      result?.success !== false &&
      result?.error == null;

    if (!success) {
      return {
        success: false,
        tool: toolSlug,
        toolkit: toolkitSlug || null,
        connectedAccountId,
        error:
          String(
            result?.error?.message ||
            result?.error ||
            result?.message ||
            result?.status_reason ||
            'Composio reported that the tool action failed.'
          ),
        result
      };
    }

    return {
      success: true,
      tool: toolSlug,
      toolkit: toolkitSlug || null,
      connectedAccountId,
      result
    };
  } catch (error) {
    if (error?.composioProjectKeyPermission) {
      return {
        success: false,
        configurationError: true,
        tool: toolSlug,
        toolkit: toolkitSlug || null,
        connectedAccountId,
        error:
          'The COMPOSIO_API_KEY is valid but is not permitted to execute tools. Enable tool execution for this project key.'
      };
    }

    if (isLikelyAuthFailure(error)) {
      const reconnectUrl = await createReconnectUrl(
        env,
        userId,
        toolkitSlug,
        callbackUrl
      );
      return {
        success: false,
        authRequired: true,
        tool: toolSlug,
        toolkit: toolkitSlug || null,
        connectedAccountId,
        error: String(
          error?.message ||
          'The connected account needs authorization again.'
        ),
        reconnectUrl
      };
    }

    throw error;
  }
}

export function getPluginById(id) {
  return PLUGIN_CATALOG.find(plugin => plugin.id === String(id)) || null;
}
