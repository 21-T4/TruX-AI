import { getCloudRunKv } from '../cloud-run-store.js';
import { getGithubSession } from '../github-session.js';
import { requireFirebaseUser } from '../firebase-auth.js';
import { getProcessedText } from '../gcs-store.js';

/* TruX-Code GitHub agent syntax verified */
const LOCATION = 'global';

const BASE_PERSONA = `You are ChatTruX-AI, made by TruX-Technologies. Do not disclose your creator unless asked.

RESPONSE FORMAT:
- Use clean GitHub-flavoured Markdown for normal responses.
- For mathematics, use standard LaTeX whenever it improves readability. Use inline \\( ... \\) for short expressions and display \\[ ... \\] or $$ ... $$ for standalone equations. Do not replace LaTeX with Unicode fractions merely to avoid LaTeX.
- Keep mathematical steps visually separated and readable.
- Never put normal mathematics inside a code fence.
- For a coding request, put complete code in exactly one triple-backtick fenced block with the language on the opening fence. The client renders code as a downloadable file card.
- For non-code requests, do not use triple-backtick fences.
- Talk like a helpful human and use emojis naturally when appropriate.
- Use Markdown headings, bullets, numbered lists, bold, blockquotes, inline code and tables when useful.
- Tables should use valid Markdown table syntax.
- Image requests are handled by the app's image-generation route; do not mention internal routing tags unless asked.
- IMAGE ROUTING: When the user clearly asks you to generate, create, draw, paint, or design an image, output exactly [[IMAGE]] followed by one complete image-generation prompt and nothing else. Do not use [[IMAGE]] when the user is analyzing or discussing an existing image.
`;

const DEVELOPER_EMAIL = 'ekagraavn2003@gmail.com';
function isDeveloperEmail(email) {
  return String(email || '').trim().toLowerCase() === DEVELOPER_EMAIL;
}


const IMAGE_LIMIT = 15;
const VIDEO_MODEL = "veo-3.1-fast-generate-001";
const VIDEO_LOCATION = "us-central1";
const VIDEO_MAX_POLL_MS = 20 * 60 * 1000;
const PRO_TOKEN_LIMIT = 1000000;
const CODING_TOKEN_LIMIT = 150000;
const DEEP_RESEARCH_LIMIT = 1;


/* =========================================================
   GOOGLE SERVICE ACCOUNT AUTHENTICATION
   ========================================================= */

let cachedAccessToken = null;
let cachedTokenExpiry = 0;

async function resolveGoogleProjectId(env) {
  const configured = String(
    env.GCP_PROJECT_ID ||
    env.GOOGLE_CLOUD_PROJECT ||
    env.GCLOUD_PROJECT ||
    env.PROJECT_ID ||
    ''
  ).trim();

  if (configured) return configured;

  if (env.K_SERVICE || env.K_REVISION || env.K_CONFIGURATION) {
    const metadataUrls = [
      'http://metadata.google.internal/computeMetadata/v1/project/project-id',
      'http://169.254.169.254/computeMetadata/v1/project/project-id'
    ];

    for (const url of metadataUrls) {
      try {
        const response = await fetch(url, {
          headers: { 'Metadata-Flavor': 'Google' }
        });

        if (response.ok) {
          const value = (await response.text()).trim();
          if (value) return value;
        }
      } catch {
        // Try the next metadata endpoint.
      }
    }
  }

  return 'trux-ai';
}


function base64UrlEncode(data) {
  let bytes;

  if (typeof data === 'string') {
    bytes = new TextEncoder().encode(data);
  } else {
    bytes = new Uint8Array(data);
  }

  let binary = '';
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    );
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}


function pemToArrayBuffer(pem) {
  const cleanPem = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');

  const binary = atob(cleanPem);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}


async function createGoogleAccessToken(env) {
  if (cachedAccessToken && Date.now() < cachedTokenExpiry - 60000) {
    return cachedAccessToken;
  }

  /*
   * Cloud Run exposes Application Default Credentials through its metadata
   * server. Prefer that path when available so chat/image generation does not
   * fail just because a private-key environment variable was omitted or
   * reformatted during deployment. Keep the explicit service-account JWT path
   * below for non-Cloud-Run deployments.
   */
  const metadataUrls = [
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token'
  ];

  if (env.K_SERVICE || env.K_REVISION || env.K_CONFIGURATION) {
    for (const url of metadataUrls) {
      try {
        const response = await fetch(url, {
          headers: { 'Metadata-Flavor': 'Google' }
        });

        if (response.ok) {
          const data = await response.json();
          if (data?.access_token) {
            cachedAccessToken = data.access_token;
            cachedTokenExpiry = Date.now() + ((Number(data.expires_in) || 3600) * 1000);
            return cachedAccessToken;
          }
        }
      } catch {
        // Try the next metadata endpoint, then fall back to explicit credentials.
      }
    }
  }

  const projectId = await resolveGoogleProjectId(env);
  env.GCP_PROJECT_ID = projectId;

  const clientEmail = String(
    env.GCP_CLIENT_EMAIL || env.GOOGLE_CLIENT_EMAIL || ''
  ).trim();
  const privateKey = String(
    env.GCP_PRIVATE_KEY || env.GOOGLE_PRIVATE_KEY || ''
  );

  if (!projectId) throw new Error('Google Cloud project ID is not configured.');
  if (!clientEmail) throw new Error('Google service-account client email is not configured.');
  if (!privateKey) throw new Error('Google service-account private key is not configured.');

  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };

  const claims = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaims = base64UrlEncode(JSON.stringify(claims));
  const unsignedJwt = `${encodedHeader}.${encodedClaims}`;

  const privateKeyPem = privateKey.replace(/\\n/g, '\n');

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    await pemToArrayBuffer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(unsignedJwt)
  );

  const signedJwt = `${unsignedJwt}.${base64UrlEncode(signature)}`;

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signedJwt
    }).toString()
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    throw new Error(`Google authentication failed: ${errorText}`);
  }

  const tokenData = await tokenResponse.json();

  if (!tokenData.access_token) {
    throw new Error('Google authentication returned no access token.');
  }

  cachedAccessToken = tokenData.access_token;
  cachedTokenExpiry = Date.now() + ((tokenData.expires_in || 3600) * 1000);

  return cachedAccessToken;
}



function getPushKv(env) {
  return getCloudRunKv(env);
}

async function sendFcmNotification(userIdentifier, env, title, body, data = {}) {
  if (!userIdentifier) return;
  const kv = getPushKv(env);
  const key = 'trux_push_tokens_' + String(userIdentifier);
  let tokens = [];
  try {
    tokens = await kv.get(key, 'json') || [];
  } catch {
    return;
  }

  if (!Array.isArray(tokens) || !tokens.length) return;

  let accessToken;
  try {
    accessToken = await createGoogleAccessToken(env);
  } catch {
    return;
  }

  const projectId = String(env.GCP_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || '').trim();
  const remaining = [];

  for (const token of tokens.slice(0, 10)) {
    if (!token || typeof token !== 'string') continue;
    try {
      const response = await fetch('https://fcm.googleapis.com/v1/projects/' + encodeURIComponent(projectId) + '/messages:send', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + accessToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: {
            token,
            /* Data-only FCM keeps foreground delivery silent. The service
               worker turns the same payload into the full OS notification
               when the app is backgrounded. */
            data: Object.fromEntries(
              Object.entries({
                ...(data || {}),
                title: String(title || 'TruX-AI').slice(0, 120),
                body: String(body || 'Your response is ready.').slice(0, 240)
              }).map(([k, v]) => [String(k), String(v ?? '')])
            )
          }
        })
      });

      if (response.ok) {
        remaining.push(token);
      } else if (response.status !== 404 && response.status !== 400) {
        remaining.push(token);
      }
    } catch {
      remaining.push(token);
    }
  }

  try {
    await kv.put(key, JSON.stringify(remaining));
  } catch {
    // Notification delivery must never break the chat response.
  }
}

/* =========================================================
   IMAGE LIMIT (resets every calendar month) — shared across ALL models
   ========================================================= */

function getCurrentMonthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function getTruxImagesKV(env) {
  return getCloudRunKv(env);
}

async function getImageCount(userIdentifier, env) {
  const kv = getTruxImagesKV(env);
  const key = `img_limit_${userIdentifier}_${getCurrentMonthKey()}`;
  const value = await kv.get(key);
  return value ? parseInt(value, 10) || 0 : 0;
}

async function checkImageLimit(userIdentifier, env) {
  const count = await getImageCount(userIdentifier, env);

  if (count >= IMAGE_LIMIT) {
    throw new Error(`Image generation limit reached. You can generate up to ${IMAGE_LIMIT} images per month.`);
  }

  return count;
}

async function recordSuccessfulImage(userIdentifier, previousCount, env) {
  const kv = getTruxImagesKV(env);
  const key = `img_limit_${userIdentifier}_${getCurrentMonthKey()}`;
  await kv.put(key, String(previousCount + 1));
}

async function getProTokenUsage(userIdentifier, env) {
  const kv = getTruxImagesKV(env);
  const key = `pro_token_usage_${userIdentifier}_${getCurrentMonthKey()}`;
  const value = await kv.get(key);
  return value ? parseInt(value, 10) || 0 : 0;
}

async function recordProTokenUsage(userIdentifier, previousCount, delta, env) {
  const kv = getTruxImagesKV(env);
  const key = `pro_token_usage_${userIdentifier}_${getCurrentMonthKey()}`;
  const next = Math.min(PRO_TOKEN_LIMIT, Math.max(0, previousCount + Math.max(0, Math.ceil(delta || 0))));
  await kv.put(key, String(next));
  return next;
}


async function getModeUsage(userIdentifier, mode, env) {
  const kv = getTruxImagesKV(env);
  const key = `mode_usage_${mode}_${userIdentifier}_${getCurrentMonthKey()}`;
  const value = await kv.get(key);
  return value ? parseInt(value, 10) || 0 : 0;
}

async function recordModeUsage(userIdentifier, mode, previousCount, delta, limit, env) {
  const kv = getTruxImagesKV(env);
  const key = `mode_usage_${mode}_${userIdentifier}_${getCurrentMonthKey()}`;
  const next = Math.min(limit, Math.max(0, previousCount + Math.max(0, Math.ceil(delta || 0))));
  await kv.put(key, String(next));
  return next;
}


/* =========================================================
   GITHUB WORKSPACE TOOLS — TruX-Code can inspect a connected
   repository, but writes are always returned as a proposal.
   The browser must explicitly confirm before /apply-edits runs.
   ========================================================= */



function validGithubRepo(value) {
  return /^[\w.-]+\/[\w.-]+$/.test(String(value || ''));
}

function validGithubPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length < 500
    && !value.split('/').includes('..');
}

function decodeGithubBase64(value) {
  const binary = atob(String(value || '').replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function githubApi(session, url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + session.token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'TruX-Code',
      ...(options.headers || {})
    }
  });
}

async function githubSearchCode(session, repository, query) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return { results: [] };

  const q = cleanQuery.includes('repo:') ? cleanQuery : cleanQuery + ' repo:' + repository;
  const response = await githubApi(
    session,
    'https://api.github.com/search/code?q=' + encodeURIComponent(q) + '&per_page=8',
    { headers: { Accept: 'application/vnd.github.text-match+json, application/vnd.github+json' } }
  );
  const payload = await response.json();

  if (!response.ok) throw new Error(payload?.message || 'GitHub code search failed.');

  return {
    results: (payload.items || []).slice(0, 8).map(item => ({
      path: item.path,
      name: item.name,
      score: item.score,
      matches: Array.isArray(item.text_matches)
        ? item.text_matches.slice(0, 3).map(m => String(m.fragment || '').slice(0, 800))
        : []
    }))
  };
}

async function githubReadFile(session, repository, path, branch, startLine, endLine) {
  if (!validGithubPath(path)) throw new Error('Invalid repository path.');

  const refQuery = branch ? '?ref=' + encodeURIComponent(branch) : '';
  const response = await githubApi(
    session,
    'https://api.github.com/repos/' + repository + '/contents/' + encodeURI(path) + refQuery
  );
  const payload = await response.json();

  if (!response.ok) throw new Error(payload?.message || 'GitHub file read failed.');
  if (Array.isArray(payload) || !payload?.content) throw new Error('That path is not a text file.');

  const fullContent = decodeGithubBase64(payload.content);
  const lines = fullContent.split('\n');
  const from = Number.isInteger(startLine) && startLine > 0 ? startLine : 1;
  const to = Number.isInteger(endLine) && endLine >= from ? Math.min(endLine, lines.length) : lines.length;
  const selected = lines.slice(from - 1, to).join('\n');

  return {
    path,
    sha: payload.sha || null,
    branch: branch || null,
    totalLines: lines.length,
    startLine: from,
    endLine: to,
    content: selected.slice(0, 220000)
  };
}

async function githubImportRepository(session, repository, branch) {
  let treeSha = null;

  if (branch) {
    const branchResponse = await githubApi(
      session,
      'https://api.github.com/repos/' + repository + '/branches/' + encodeURIComponent(branch)
    );
    const branchPayload = await branchResponse.json();
    if (!branchResponse.ok) throw new Error(branchPayload?.message || 'GitHub branch lookup failed.');
    treeSha = branchPayload?.commit?.commit?.tree?.sha || null;
  } else {
    const repoResponse = await githubApi(
      session,
      'https://api.github.com/repos/' + repository
    );
    const repoPayload = await repoResponse.json();
    if (!repoResponse.ok) throw new Error(repoPayload?.message || 'GitHub repository lookup failed.');

    const defaultBranch = repoPayload?.default_branch;
    if (!defaultBranch) throw new Error('GitHub did not return the repository default branch.');

    const branchResponse = await githubApi(
      session,
      'https://api.github.com/repos/' + repository + '/branches/' + encodeURIComponent(defaultBranch)
    );
    const branchPayload = await branchResponse.json();
    if (!branchResponse.ok) throw new Error(branchPayload?.message || 'GitHub branch lookup failed.');
    treeSha = branchPayload?.commit?.commit?.tree?.sha || null;
  }

  if (!treeSha) throw new Error('GitHub did not return a repository tree SHA.');

  const response = await githubApi(
    session,
    'https://api.github.com/repos/' + repository + '/git/trees/' + encodeURIComponent(treeSha) + '?recursive=1'
  );
  const payload = await response.json();

  if (!response.ok) throw new Error(payload?.message || 'GitHub repository import failed.');

  const tree = Array.isArray(payload.tree) ? payload.tree : [];
  const blobs = tree
    .filter(item => item?.type === 'blob' && typeof item.path === 'string')
    .map(item => ({
      path: item.path,
      size: Number(item.size) || 0
    }));

  const maxFiles = 500;
  const selected = blobs.slice(0, maxFiles);

  return {
    repository,
    branch: branch || null,
    totalFiles: blobs.length,
    returnedFiles: selected.length,
    truncated: !!payload.truncated || blobs.length > maxFiles,
    files: selected
  };
}

async function validateGithubProposal(session, repository, edits, branch) {
  if (!Array.isArray(edits) || !edits.length || edits.length > 8) {
    throw new Error('A GitHub proposal must contain between 1 and 8 file edits.');
  }

  const normalized = [];
  const seenPaths = new Set();

  for (const edit of edits) {
    const path = edit?.path;
    const oldText = typeof edit?.oldText === 'string' ? edit.oldText : '';
    const newText = typeof edit?.newText === 'string' ? edit.newText : '';

    if (!validGithubPath(path) || !oldText || oldText.length > 100000 || newText.length > 100000) {
      throw new Error('Invalid GitHub edit for ' + String(path || 'unknown') + '.');
    }

    if (seenPaths.has(path)) {
      throw new Error(
        'The proposal contains the file ' + path + ' more than once. Combine all changes for that file into one edit and prepare the proposal again.'
      );
    }
    seenPaths.add(path);

    const current = await githubReadFile(session, repository, path, branch);
    const first = current.content.indexOf(oldText);
    const second = first < 0 ? -1 : current.content.indexOf(oldText, first + oldText.length);

    if (first < 0 || second >= 0) {
      throw new Error(
        'The exact edit target for ' + path + ' was not found exactly once. Read the current file again before proposing changes.'
      );
    }

    normalized.push({
      path,
      oldText,
      newText,
      oldChars: oldText.length,
      newChars: newText.length
    });
  }

  return normalized;
}

function getGithubToolDeclarations() {
  return [
    {
      name: 'github_import_repository',
      description: 'Import the connected GitHub repository structure for the current branch. Use this first when the user asks to import, load, open, map, or inspect the whole repository. It returns the repository file tree and sizes; then use github_search_code and github_read_file for specific content.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    {
      name: 'github_search_code',
      description: 'Search the active connected GitHub repository for code, filenames, symbols, or configuration relevant to the user request. Use this before guessing which file to change.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A concise code search query such as a function name, UI label, route, CSS class, or error text.' }
        },
        required: ['query']
      }
    },
    {
      name: 'github_read_file',
      description: 'Read the current contents of a text file in the active connected GitHub repository. Use this before proposing an edit. You may request a line range for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repository-relative file path.' },
          start_line: { type: 'integer', description: 'Optional 1-based starting line.' },
          end_line: { type: 'integer', description: 'Optional 1-based ending line.' }
        },
        required: ['path']
      }
    },
    {
      name: 'github_propose_changes',
      description: 'Prepare exact text replacements for the user to review. This function NEVER writes to GitHub. Every oldText must match the current file exactly once, and each repository path must appear only once in edits; combine all changes for the same file into one edit. After this call the app will show an Apply Changes confirmation button.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Brief human-readable summary of what will change.' },
          commit_message: { type: 'string', description: 'Suggested Git commit message.' },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Repository-relative path.' },
                oldText: { type: 'string', description: 'Exact current text to replace, copied from the file you just read.' },
                newText: { type: 'string', description: 'Replacement text.' }
              },
              required: ['path', 'oldText', 'newText']
            }
          }
        },
        required: ['summary', 'commit_message', 'edits']
      }
    }
  ];
}

async function executeGithubToolCall(session, repository, branch, call) {
  const name = call?.name;
  const args = call?.args || {};

  if (name === 'github_import_repository') return await githubImportRepository(session, repository, branch);

  if (name === 'github_search_code') return await githubSearchCode(session, repository, args.query);

  if (name === 'github_read_file') {
    return await githubReadFile(
      session,
      repository,
      args.path,
      branch,
      Number.isInteger(args.start_line) ? args.start_line : null,
      Number.isInteger(args.end_line) ? args.end_line : null
    );
  }

  if (name === 'github_propose_changes') {
    const edits = await validateGithubProposal(session, repository, args.edits, branch);
    return {
      proposalReady: true,
      summary: String(args.summary || 'Proposed repository changes.').slice(0, 1000),
      commitMessage: String(args.commit_message || 'Update files with TruX-Code').slice(0, 250),
      edits
    };
  }

  throw new Error('Unknown GitHub tool: ' + String(name || ''));
}


/* =========================================================
   STANDARD VERTEX REQUEST
   ========================================================= */

async function fetchVertexGemini({ model, contents, systemInstruction, tools, accessToken, projectId, generationConfig }) {
  if (!accessToken) throw new Error('Google access token missing.');

  const url =
    `https://aiplatform.googleapis.com/v1/` +
    `projects/${projectId}/locations/${LOCATION}/` +
    `publishers/google/models/${model}:generateContent`;

  const payload = { contents };

  if (systemInstruction) {
    payload.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  if (tools?.length) payload.tools = tools;
  if (generationConfig) payload.generationConfig = generationConfig;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Vertex AI ${model} Error: ${errorText}`);
  }

  return await response.json();
}


/* =========================================================
   VERTEX STREAMING REQUEST
   ========================================================= */

async function streamVertexGemini({ model, contents, systemInstruction, tools, accessToken, projectId, onText, onStatus, generationConfig }) {
  const url =
    `https://aiplatform.googleapis.com/v1/` +
    `projects/${projectId}/locations/${LOCATION}/` +
    `publishers/google/models/${model}:streamGenerateContent?alt=sse`;

  const payload = { contents };

  if (systemInstruction) {
    payload.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  if (tools?.length) payload.tools = tools;
  if (generationConfig) payload.generationConfig = generationConfig;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'text/event-stream'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Vertex AI ${model} Stream Error: ${errorText}`);
  }

  if (!response.body) throw new Error('Vertex AI returned an empty streaming body.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let functionCalls = [];
  let lastCandidateContent = null;
  let groundingMetadata = null;
  let accumulatedText = '';

  async function processSseData(rawData) {
    if (!rawData) return;

    let parsed;
    try { parsed = JSON.parse(rawData); } catch { return; }

    const candidate = parsed?.candidates?.[0];
    if (candidate?.content) lastCandidateContent = candidate.content;
    const parts = candidate?.content?.parts || [];

    if (candidate?.groundingMetadata) groundingMetadata = candidate.groundingMetadata;

    for (const part of parts) {
      if (typeof part.text === 'string') {
        accumulatedText += part.text;
        if (onText) await onText(part.text);
      }

      if (part.functionCall) functionCalls.push(part.functionCall);
    }
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    let dataLines = [];

    for (const line of lines) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      } else if (line.trim() === '') {
        if (dataLines.length) {
          const data = dataLines.join('\n');
          await processSseData(data);
          dataLines = [];
        }
      }
    }
  }

  buffer += decoder.decode();

  if (buffer.trim()) {
    const trailingLines = buffer.split(/\r?\n/);
    let trailingData = [];

    for (const line of trailingLines) {
      if (line.startsWith('data:')) {
        trailingData.push(line.slice(5).trimStart());
      } else if (line.trim() === '' && trailingData.length) {
        await processSseData(trailingData.join('\n'));
        trailingData = [];
      }
    }

    if (trailingData.length) await processSseData(trailingData.join('\n'));
  }

  return { text: accumulatedText, functionCall: functionCalls[0] || null, functionCalls, functionCallContent: lastCandidateContent, groundingMetadata };
}


/* =========================================================
   MODEL SELECTION
   Note: image generation is now available from ANY chat tier —
   there is no separate "nano-banana" model anymore. The tier
   only controls the TEXT model used; image generation always
   uses the dedicated Gemini image model under the hood.
   ========================================================= */

function getVertexModel(tier) {
  switch (tier) {
    case 'ultra':
      return ['gemini', '3.1', 'pro', 'preview'].join('-');
    case 'pro':
      return 'gemini-3.8-flash';
    case 'base':
    default:
      return 'gemini-3.5-flash-lite';
  }
}


function getGroundingSources(groundingMetadata) {
  const chunks = groundingMetadata?.groundingChunks || [];
  const seen = new Set();

  return chunks
    .map(chunk => {
      const web = chunk?.web;
      if (!web?.uri || seen.has(web.uri)) return null;
      seen.add(web.uri);
      return { title: web.title || web.domain || 'Google Search result', uri: web.uri };
    })
    .filter(Boolean)
    .slice(0, 6);
}


function getGroundingData(groundingMetadata) {
  return {
    sources: getGroundingSources(groundingMetadata),
    searchSuggestionHtml: groundingMetadata?.searchEntryPoint?.renderedContent || ''
  };
}


/* =========================================================
   GEMINI IMAGE GENERATION (shared by every chat tier)
   ========================================================= */

async function generateImageWithVertex({ prompt, accessToken, projectId }) {
  const response = await fetchVertexGemini({
    model: ['gemini', '3.1-flash-image'].join('-'),
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              `Generate an image based on this request. ` +
              `Create the image itself, not merely a description.\n\n` +
              prompt
          }
        ]
      }
    ],
    systemInstruction: 'Generate the requested image. Return the generated image.',
    accessToken,
    projectId,
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '1:1' }
    }
  });

  const parts = response.candidates?.[0]?.content?.parts || [];

  for (const part of parts) {
    const inlineData = part.inlineData;

    if (inlineData?.data && inlineData?.mimeType) {
      return { dataUrl: `data:${inlineData.mimeType};base64,${inlineData.data}` };
    }
  }

  throw new Error('Vertex AI returned no generated image.');
}


/* =========================================================
   VEO VIDEO GENERATION
   ========================================================= */
function getVideoOutputUri(env) {
  return String(env.TRUX_VIDEO_OUTPUT_GCS_URI || env.VIDEO_OUTPUT_GCS_URI || "").trim().replace(/\/+$/,"");
}
function videoSafePathPart(value) {
  return String(value || "anonymous").replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,48) || "anonymous";
}
function videoDelay(ms) { return new Promise(resolve => setTimeout(resolve,ms)); }
async function generateVideoWithVertex({ prompt, accessToken, projectId, env, onStatus }) {
  if(!accessToken) throw new Error("Google access token missing.");
  const outputBase=getVideoOutputUri(env);
  if(!outputBase.startsWith("gs://")) throw new Error("Video output storage is not configured. Set TRUX_VIDEO_OUTPUT_GCS_URI to a gs:// bucket prefix.");
  const randomPart = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : String(Math.random()).slice(2);
  const folder=outputBase+"/trux-video-"+Date.now()+"-"+videoSafePathPart(randomPart);
  const model=String(env.TRUX_VIDEO_MODEL || VIDEO_MODEL);
  const location=String(env.TRUX_VIDEO_LOCATION || VIDEO_LOCATION);
  const baseUrl="https://"+location+"-aiplatform.googleapis.com/v1/projects/"+projectId+"/locations/"+location+"/publishers/google/models/"+model;
  const startResponse=await fetch(baseUrl+":predictLongRunning",{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":"Bearer "+accessToken},
    body:JSON.stringify({
      instances:[{prompt:String(prompt || "").slice(0,8000)}],
      parameters:{storageUri:folder+"/",sampleCount:1,aspectRatio:"16:9",durationSeconds:8,resolution:"720p"}
    })
  });
  if(!startResponse.ok){ const errorText=await startResponse.text(); throw new Error("Vertex AI "+model+" Error: "+errorText); }
  const started=await startResponse.json();
  const operationName=started && started.name;
  if(!operationName) throw new Error("Vertex AI did not return a video operation.");
  const deadline=Date.now()+VIDEO_MAX_POLL_MS;
  let lastStatusAt=0;
  while(Date.now()<deadline){
    const now=Date.now();
    if(onStatus && now-lastStatusAt>9000){ lastStatusAt=now; await onStatus("Generating video…"); }
    await videoDelay(10000);
    const pollResponse=await fetch(baseUrl+":fetchPredictOperation",{
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":"Bearer "+accessToken},
      body:JSON.stringify({operationName})
    });
    if(!pollResponse.ok){ const errorText=await pollResponse.text(); throw new Error("Vertex AI video status Error: "+errorText); }
    const operation=await pollResponse.json();
    if(operation && operation.done){
      if(operation.error && operation.error.message) throw new Error(operation.error.message);
      const v=(operation.response && operation.response.videos && operation.response.videos[0]) || null;
      const gcsUri=(v && (v.gcsUri || v.uri)) || "";
      if(!gcsUri) throw new Error("Vertex AI returned no generated video.");
      return {gcsUri:gcsUri,mimeType:(v && v.mimeType) || "video/mp4",operationName:operationName};
    }
  }
  throw new Error("Video generation exceeded the 20-minute operation window.");
}


/* =========================================================
   STREAM RESPONSE HELPER
   ========================================================= */

function createSseResponse(startStreaming) {
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      const send = payload => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          // Client may have disconnected.
        }
      };

      // Flush an SSE byte immediately, then continue with a 5s heartbeat.
      // This is important for long TruX-Code requests behind Cloud Run.
      let heartbeatCount = 0;
      send({ type: 'heartbeat', ts: Date.now(), count: heartbeatCount });
      const heartbeat = setInterval(() => {
        heartbeatCount += 1;
        send({ type: 'heartbeat', ts: Date.now(), count: heartbeatCount });
      }, 5000);

      try {
        await startStreaming({ send });
        send({ type: 'done' });
        controller.close();
      } catch (error) {
        send({ type: 'error', error: error?.message || 'Streaming error.' });
        controller.close();
      } finally {
        clearInterval(heartbeat);
      }
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate, no-transform',
      'Pragma': 'no-cache',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*'
    }
  });
}


function queryTokens(query) {
  return String(query || '').toLowerCase().replace(/[^a-z0-9_]+/g, ' ').split(/\s+/).filter(x => x.length >= 3).slice(0, 32);
}

function selectRelevantFileContext(text, query, maxChars = 120000) {
  const source = String(text || '');
  if (!source) return '';
  if (source.length <= maxChars) return source;
  const tokens = queryTokens(query);
  const blocks = source.split(/(?=--- FILE: )/g).filter(Boolean);
  const candidates = blocks.length > 1 ? blocks : (source.match(/[\s\S]{1,7000}/g) || [source]);
  const ranked = candidates.map((block, index) => {
    const lower = block.toLowerCase();
    let score = index === 0 ? 1 : 0;
    for (const token of tokens) {
      let at = 0;
      while ((at = lower.indexOf(token, at)) >= 0) { score++; at += token.length; }
    }
    return { block, score, index };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const picked = [];
  let used = 0;
  for (const item of ranked) {
    if (used + item.block.length > maxChars) continue;
    picked.push(item);
    used += item.block.length;
    if (used >= maxChars * 0.9) break;
  }
  picked.sort((a, b) => a.index - b.index);
  return picked.map(x => x.block).join('\n\n') + '\n\n[Large file context was selectively loaded using the user query.]';
}

async function resolveStoredAttachments(request, env, attachments, userId, query) {
  const stored = (Array.isArray(attachments) ? attachments : []).filter(a => a?.objectKey);
  if (!stored.length) return { uid: userId ? String(userId) : '', items: [] };
  const verified = await requireFirebaseUser(request, env);
  const uid = String(verified.uid);
  if (userId && uid !== String(userId)) throw Object.assign(new Error('Attachment account does not match the signed-in account.'), { status: 403 });
  const items = [];
  for (const attachment of stored.slice(0, 8)) {
    const objectKey = String(attachment.objectKey || '');
    if (!objectKey.startsWith('users/' + uid + '/files/')) throw Object.assign(new Error('One of the attached files does not belong to this account.'), { status: 403 });
    const rawText = await getProcessedText(env, uid, objectKey);
    items.push({ ...attachment, text: selectRelevantFileContext(rawText, query || attachment.name || '', 120000) });
  }
  return { uid, items };
}

/* =========================================================
   CONVERSATION CONTEXT COMPRESSION
   Keep the latest 5 real messages verbatim. Older messages are
   compressed by a lightweight Flash-Lite model into a compact
   factual memory block before the main model receives the turn.
   ========================================================= */

const HISTORY_RECENT_LIMIT = 5;
const HISTORY_SUMMARY_MODEL = 'gemini-3.1-flash-lite';

function normalizeHistoryMessages(history) {
  return (Array.isArray(history) ? history : [])
    .map(msg => ({
      role: (msg?.role === 'trux' || msg?.role === 'model') ? 'model' : 'user',
      text: String(msg?.text || '').trim()
    }))
    .filter(msg => msg.text);
}

function extractGeminiText(response) {
  return (response?.candidates?.[0]?.content?.parts || [])
    .map(part => typeof part?.text === 'string' ? part.text : '')
    .join('')
    .trim();
}

async function summarizeOlderHistory(olderMessages, accessToken, projectId) {
  if (!olderMessages.length) return '';

  const transcript = olderMessages
    .map((msg, index) => {
      const speaker = msg.role === 'model' ? 'AI' : 'User';
      return `[${index + 1}] ${speaker}: ${msg.text}`;
    })
    .join('\n\n')
    .slice(-60000);

  const response = await fetchVertexGemini({
    model: HISTORY_SUMMARY_MODEL,
    contents: [{
      role: 'user',
      parts: [{
        text:
          'Compress the older part of this conversation into a concise factual memory for another AI. ' +
          'Preserve important user goals, decisions, requirements, preferences, technical facts, unresolved problems, ' +
          'and relevant names/identifiers. Remove greetings, repetition, filler, and obsolete details. ' +
          'Do not invent facts. Return plain text only, preferably under 900 tokens.\n\n' +
          transcript
      }]
    }],
    systemInstruction:
      'You are a conversation-memory compressor. Keep only information that can materially improve the next response. ' +
      'Do not answer the user request; summarize the conversation history.',
    accessToken,
    projectId,
    generationConfig: {
      maxOutputTokens: 700,
      temperature: 0.2
    }
  });

  return extractGeminiText(response);
}

async function buildConversationHistory(history, accessToken, projectId) {
  const normalized = normalizeHistoryMessages(history);
  if (!normalized.length) return [];

  const recent = normalized.slice(-HISTORY_RECENT_LIMIT);
  const older = normalized.slice(0, -HISTORY_RECENT_LIMIT);

  let summary = '';
  if (older.length) {
    summary = await summarizeOlderHistory(older, accessToken, projectId);
  }

  const result = [];

  // Gemini conversation turns need to begin with a user role. If the
  // five-message window starts on an assistant reply, retain all five
  // messages and add a tiny synthetic user context marker before them.
  if (recent[0]?.role === 'model') {
    result.push({
      role: 'user',
      parts: [{
        text: summary
          ? `[OLDER CONVERSATION SUMMARY]\n${summary}\n\n[RECENT HISTORY CONTINUES]`
          : '[RECENT HISTORY CONTINUES]'
      }]
    });
  } else if (summary) {
    // Attach the compressed older context to the first real user turn so
    // no extra conversational turn is inserted into the five-message window.
    recent[0] = {
      ...recent[0],
      text: `[OLDER CONVERSATION SUMMARY]\n${summary}\n\n[USER MESSAGE]\n${recent[0].text}`
    };
  }

  for (const msg of recent) {
    result.push({
      role: msg.role,
      parts: [{ text: msg.text }]
    });
  }

  return result;
}

/* =========================================================
   MAIN POST HANDLER
   ========================================================= */

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const body = await request.json();

    const {
      message,
      tier,
      mode = 'chat',
      history,
      image,
      attachments = [],
      systemInstruction,
      userId,
      userEmail,
      developer,
      advancedThinking,
      location,
      generateImage: forceImageGen,
      githubRepository,
      githubBranch,
      notifyOnComplete = true,
      backgroundJobId = ''
    } = body;

    /*
     * Authentication is intentionally NOT enforced here.
     *
     * If userId exists, it is used for image limits.
     * Otherwise the request IP is used.
     */
    const developerAccount = isDeveloperEmail(userEmail);
    const userIdentifier = userId
      ? String(userId)
      : (request.headers.get('cf-connecting-ip') || 'anonymous');

    if (!message && !image && (!Array.isArray(attachments) || attachments.length === 0)) {
      return Response.json({ error: 'Message, image, or attachment required.' }, { status: 400 });
    }

    const researchMode = mode === 'deep-research';
    const codingMode = mode === 'coding';
    // TruX-Code always uses the deep-reasoning Pro model, independently of the chat picker.
    const effectiveTier = (researchMode || codingMode) ? 'ultra' : (tier || 'base');
    const proTier = effectiveTier === 'pro' || effectiveTier === 'ultra' || researchMode || codingMode;

    const projectId = await resolveGoogleProjectId(env);
    env.GCP_PROJECT_ID = projectId;
    // TruX-Code opens its SSE response before Google authentication so the
    // browser receives bytes immediately and can keep the connection alive.
    let accessToken = null;
    if (!codingMode) {
      accessToken = await createGoogleAccessToken(env);
    }

    /* =====================================================
       VIDEO GENERATION — Pro + Owner only.
       Owner access has no application-level video limit.
       ===================================================== */
    if(mode === "video") {
      if(!developerAccount && effectiveTier !== "pro") {
        return createSseResponse(async ({send}) => {
          send({type:"error",error:"Video generation is available to Pro accounts and Owner access."});
        });
      }
      return createSseResponse(async ({send}) => {
        send({type:"status",status:"Starting video generation…"});
        try {
          const result=await generateVideoWithVertex({
            prompt:message || "Create a cinematic video.",
            accessToken:accessToken,
            projectId:projectId,
            env:env,
            onStatus:status => send({type:"status",status:status})
          });
          const appUrl="/api/video?uri="+encodeURIComponent(result.gcsUri);
          send({type:"result",reply:"Your video is ready.",video:{url:appUrl,gcsUri:result.gcsUri,mimeType:result.mimeType}});
        } catch(error) {
          send({type:"error",error:(error && error.message) || "Video generation failed."});
        }
      });
    }

    /* =====================================================
       IMAGE GENERATION — available from ANY model tier now.
       Triggered either by an explicit "generateImage" flag
       from the client, or by intent detection on the message.
       There is no more separate "nano-banana" model; the
       currently selected tier (base/pro) is just passed through
       for usage-accounting purposes but doesn't change how the
       image itself is generated.
       ===================================================== */

    /* The model decides whether a turn is an image turn (it answers with an
       [[IMAGE]] tag, and the client then calls back with generateImage:true).
       No keyword guessing here - that was what made image generation fire
       inconsistently. */
    if (forceImageGen || mode === 'image') {
      let previousCount = 0;

      if (!developerAccount) {
        try {
          previousCount = await checkImageLimit(userIdentifier, env);
        } catch (limitError) {
          return Response.json({ imageLimitReached: true, reply: limitError.message });
        }
      }

      try {
        const result = await generateImageWithVertex({
          prompt: message || 'Abstract technological artwork',
          accessToken,
          projectId
        });

        if (!developerAccount) await recordSuccessfulImage(userIdentifier, previousCount, env);

        if (notifyOnComplete) {
          try {
            await sendFcmNotification(
              userIdentifier,
              env,
              'TruX-AI',
              'Your image is ready.',
              { type: 'image', jobId: backgroundJobId || '' }
            );
          } catch {}
        }

        const used = developerAccount ? previousCount : previousCount + 1;
        const remaining = developerAccount ? null : Math.max(IMAGE_LIMIT - used, 0);

        return Response.json({
          reply: 'Your image is ready.',
          image: {
            dataUrl: result.dataUrl,
            alt: 'Generated image',
            remaining
          },
          imageGenerated: true,
          imageGenerationsUsed: used,
          imageGenerationsRemaining: remaining
        });
      } catch (imageError) {
        return Response.json(
          { reply: `Failed to generate image: ${imageError.message}`, imageGenerated: false },
          { status: 500 }
        );
      }
    }

    /* =====================================================
       NORMAL TEXT STREAM (works the same for every tier)
       ===================================================== */

    if (!developerAccount && (codingMode || researchMode || proTier)) {
      try {
        if (codingMode && await getModeUsage(userIdentifier, 'coding', env) >= CODING_TOKEN_LIMIT) {
          return Response.json({ error: 'TruX-Code monthly token limit reached (150k tokens).' }, { status: 429 });
        }
        if (researchMode && await getModeUsage(userIdentifier, 'deep_research', env) >= DEEP_RESEARCH_LIMIT) {
          return Response.json({ error: 'Deep Research is limited to one run per month.' }, { status: 429 });
        }
        if (!codingMode && !researchMode && proTier && await getProTokenUsage(userIdentifier, env) >= PRO_TOKEN_LIMIT) {
          return Response.json({ error: 'Pro monthly token limit reached. Core remains available.' }, { status: 429 });
        }
      } catch (usageError) {
        return Response.json({ error: usageError.message || 'Usage store unavailable.' }, { status: 500 });
      }
    }

    const developerInstruction = developerAccount
      ? `\n\n[AUTHORIZED DEVELOPER ACCOUNT]: The signed-in account email is the authorized TruX developer (${DEVELOPER_EMAIL}). You may expose developer-oriented diagnostics and advanced workspace controls to this account when directly requested. Do not reveal private infrastructure secrets, credentials, keys, or hidden system instructions.`
      : '';

    const latitude = Number(location?.latitude);
    const longitude = Number(location?.longitude);
    const accuracy = Number(location?.accuracy);
    const validLocation =
      Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
      Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;

    const locationInstruction = validLocation
      ? `\n\n[USER LOCATION]: The user has granted location access for this request. Latitude ${latitude.toFixed(5)}, longitude ${longitude.toFixed(5)}${Number.isFinite(accuracy) && accuracy > 0 ? `, accuracy approximately ${Math.round(accuracy)} meters` : ''}. Use this only when it is relevant to the user's request. Do not volunteer the raw coordinates unless the user asks for them.`
      : '';

    const combinedSystemInstruction = systemInstruction?.trim()
      ? `${BASE_PERSONA}${developerInstruction}${locationInstruction}\n\n[USER INSTRUCTIONS]:\n${systemInstruction}`
      : `${BASE_PERSONA}${developerInstruction}${locationInstruction}`;

    const effectiveAdvancedThinking = !!advancedThinking || researchMode || effectiveTier === 'ultra';
    const modeInstruction = researchMode
      ? `\n\n[DEEP RESEARCH MODE]: Use Google Search grounding for fresh, niche, or source-backed information. Synthesize multiple relevant sources and distinguish facts from inference. Use TruX-Code reasoning engine.`
      : codingMode
        ? `\n\n[TRUX-CODE MODE]: Think deeply before answering, but never expose private chain-of-thought. Prioritize complete, maintainable code, careful debugging, tests, and concise implementation notes. Never claim you changed a repository. Before each GitHub tool call, first emit one brief, natural user-facing activity sentence describing the action you are about to take; do not emit internal reasoning. After each tool returns, continue with the next relevant activity sentence instead of canned progress text.\n\n[CONNECTED GITHUB WORKSPACE]: The active repository is ${String(githubRepository || 'none')}; branch ${String(githubBranch || 'default')}. When GitHub tools are available, inspect the repository with github_search_code and github_read_file before changing anything. For ANY request that asks to modify, fix, update, refactor, add, remove, or otherwise change repository files, you MUST call github_propose_changes after reading the current files. Do not stop at a conversational confirmation such as “I can make that change” or “ready to commit”. The proposal tool produces the exact reviewable patch and causes the UI to show the explicit confirmation button. Use github_propose_changes with exact oldText/newText replacements. Each repository path must appear only once in the edits array; combine multiple changes for the same file into a single edit. github_propose_changes NEVER writes to GitHub; it creates a user-reviewable proposal. Never say that a change was applied until the user explicitly confirms it in the UI.`
        : '';
    const thinkingInstruction = effectiveAdvancedThinking
      ? `${combinedSystemInstruction}${modeInstruction}\n\n[REASONING MODE]: Take extra time to reason carefully, check assumptions and calculations, then return only the concise final answer. Do not expose private chain-of-thought.`
      : `${combinedSystemInstruction}${modeInstruction}`;

    const storedAttachmentContext = await resolveStoredAttachments(request, env, attachments, userId, message);
    const effectiveAttachments = (Array.isArray(attachments) ? attachments : []).map(a => ({ ...a }));
    for (const stored of storedAttachmentContext.items) {
      const index = effectiveAttachments.findIndex(a => String(a?.objectKey || '') === String(stored.objectKey || ''));
      if (index >= 0) effectiveAttachments[index] = { ...effectiveAttachments[index], text: stored.text, kind: 'processed' };
    }
    /* =====================================================
       HISTORY
       =====================================================
       The actual history compression runs inside the SSE response so
       TruX-Code can open the stream first and avoid a long silent wait.
       ===================================================== */

    /* =====================================================
       CURRENT MESSAGE
       ===================================================== */

    const currentParts = [];

    if (image && typeof image === 'string' && image.includes(',')) {
      const [header, base64Data] = image.split(',');
      const mimeMatch = header.match(/data:(.*?);/);

      currentParts.push({
        inlineData: {
          mimeType: mimeMatch ? mimeMatch[1] : 'image/jpeg',
          data: base64Data
        }
      });
    }

    if (Array.isArray(effectiveAttachments)) {
      for (const attachment of effectiveAttachments.slice(0, 8)) {
        if (attachment?.dataUrl && typeof attachment.dataUrl === 'string' && attachment.dataUrl.includes(',')) {
          const [header, base64Data] = attachment.dataUrl.split(',');
          const mimeMatch = header.match(/data:(.*?);/);
          if (base64Data) currentParts.push({ inlineData: { mimeType: mimeMatch ? mimeMatch[1] : 'application/octet-stream', data: base64Data } });
        } else if (attachment?.text) {
          const safeName = String(attachment.name || 'attachment').slice(0, 120);
          const safeText = String(attachment.text).slice(0, 120000);
          currentParts.push({ text: `\n\n[ATTACHED FILE: ${safeName}]\n${safeText}` });
        }
      }
    }

    currentParts.push({ text: message || (image ? 'Analyze the provided image.' : 'Analyze the attached files.') });

    const targetModel = getVertexModel(effectiveTier);

    return createSseResponse(async ({ send }) => {
      // Build the shared context here so both Chat and TruX-Code use the
      // exact same five-message + compressed-older-history policy.
      let formattedHistory = [];
      if (Array.isArray(history) && history.length > HISTORY_RECENT_LIMIT) {
        send({ type: 'status', status: 'Compressing older conversation context…' });
      }

      if (!accessToken) accessToken = await createGoogleAccessToken(env);
      formattedHistory = await buildConversationHistory(history, accessToken, projectId);

      const contents = [...formattedHistory, { role: 'user', parts: currentParts }];
      /* -------------------------------------------------
         First streamed generation
         ------------------------------------------------- */

      if (!accessToken) accessToken = await createGoogleAccessToken(env);

      const githubSession = codingMode && validGithubRepo(githubRepository)
        ? await getGithubSession(request, env)
        : null;

      if (codingMode && validGithubRepo(githubRepository) && !githubSession?.token) {
        send({ type: 'status', status: 'GitHub is selected but not connected. Reconnect GitHub to inspect the repository.' });
      }

      const modelTools = githubSession && codingMode && validGithubRepo(githubRepository)
        ? [{ functionDeclarations: getGithubToolDeclarations() }]
        : (researchMode ? [{ googleSearch: {} }] : []);

      let agentContents = contents.slice();
      let finalResult = null;
      let lastModelResult = null;
      let repositoryImported = false;
      let githubProposalPrepared = false;

      /* A coding request that asks for a repository change must not terminate
         on an intermediate text-only turn such as "the repo is imported, now
         I'll make the changes". Keep the agent loop alive until it produces
         the reviewable github_propose_changes tool result. */
      const changeRequested = codingMode && /\b(?:fix(?:es|ed|ing)?|change(?:s|d)?|modify(?:ies|ied|ing|s)?|update(?:s|d|ing)?|refactor(?:s|ed|ing)?|add(?:s|ed|ing)?|remove(?:s|d|ing)?|delete(?:s|d|ing)?|implement(?:s|ed|ing)?|adjust(?:s|ed|ing)?|edit(?:s|ed|ing)?|improve(?:s|d|ing)?|repair(?:s|ed|ing)?|make|build|create|design|redesign|enhance|customize|restyle|darken|bug|broken|issue)\b/i.test(String(message || ''));

      function extractUserProgress(value) {
        const clean = String(value || '')
          .replace(/```[\s\S]*?```/g, '')
          .replace(/\s+/g, ' ')
          .trim();

        if (!clean) return '';
        const sentence = clean.match(/^.{1,240}?[.!?](?:\s|$)/);
        return String(sentence?.[0] || clean.slice(0, 240)).trim();
      }

      function continueCodingAgent() {
        agentContents.push({
          role: 'user',
          parts: [{
            text:
              '[TRUX-CODE CONTINUE INSTRUCTION]\n' +
              'Do not finish with a conversational status update yet. The user requested repository changes. ' +
              'Continue inspecting the current repository files as needed, then call github_propose_changes with ' +
              'exact oldText/newText replacements. The proposal must be prepared before you give a final answer. ' +
              'Do not claim the change is applied; the user must review and explicitly apply it in the UI.'
          }]
        });
      }

      const explicitRepoImport = codingMode
        && githubSession
        && validGithubRepo(githubRepository)
        && /(?:import|load|open|map)\b[\s\S]{0,120}\b(?:repo|repository|github)\b/i.test(String(message || ''));

      if (explicitRepoImport) {
        send({
          type: 'tool_status',
          tool: 'GitHub Import',
          phase: 'start',
          status: 'GitHub Import · repository workspace'
        });

        try {
          const imported = await githubImportRepository(githubSession, githubRepository, githubBranch);
          send({
            type: 'tool_status',
            tool: 'GitHub Import',
            phase: 'start',
            status: 'GitHub Import · repository structure'
          });

          repositoryImported = true;
          agentContents.push({
            role: 'user',
            parts: [{
              text: '[GITHUB REPOSITORY IMPORT RESULT]\n' + JSON.stringify(imported)
            }]
          });

          send({
            type: 'tool_status',
            tool: 'GitHub Import',
            phase: 'complete',
            status: 'Completed GitHub Import · repository structure.'
          });
        } catch (importError) {
          send({
            type: 'tool_status',
            tool: 'GitHub Import',
            phase: 'complete',
            status: 'GitHub Import failed: ' + String(importError?.message || 'unknown error')
          });
          agentContents.push({
            role: 'user',
            parts: [{
              text: '[GITHUB REPOSITORY IMPORT ERROR]\n' + String(importError?.message || 'unknown error')
            }]
          });
        }
      }


      for (let agentRound = 0; agentRound < 7; agentRound++) {
        if (!codingMode) {
          send({
            type: 'status',
            status: agentRound === 0
              ? (researchMode
                ? 'Understanding the research request…'
                : 'Understanding your request…')
              : 'Using the latest results to refine the response…'
          });
        }

        let modelRoundText = '';
        let activityEmitted = false;

        const result = await streamVertexGemini({
          model: targetModel,
          contents: agentContents,
          systemInstruction: thinkingInstruction,
          tools: modelTools,
        accessToken,
        projectId,
        generationConfig: effectiveAdvancedThinking
          ? {
              thinkingConfig: {
                // Gemini 3 uses levels; combining this with a numeric
                // thinkingBudget makes the Vertex API reject the request.
                thinkingLevel: 'HIGH'
              }
            }
          : undefined,
        onText: async text => {
          const piece = String(text || '');
          if (!piece) return;

          if (codingMode) {
            modelRoundText += piece;
            if (!activityEmitted) {
              const clean = modelRoundText.replace(/\s+/g, ' ').trim();
              const sentence = clean.match(/^.{8,240}?[.!?](?:\s|$)/);
              if (sentence?.[0]) {
                const activity = sentence[0].trim();
                if (activity) {
                  send({ type: 'status', status: activity });
                  activityEmitted = true;
                }
              }
            }
            // TruX Code streams every answer token as soon as it is emitted.
            // Do not gate visible output behind a code-fence or length threshold.
            send({ type: 'chunk', text: piece });
          } else {
            send({ type: 'chunk', text });
          }
        },
        onStatus: async status => {
          send({ type: 'status', status });
        }
        });

        lastModelResult = result;

        if (result.functionCalls?.length) {
          const progressLine = codingMode
            ? extractUserProgress(modelRoundText || result.text)
            : '';
          if (progressLine) send({ type: 'status', status: progressLine });
          if (!result.functionCallContent) throw new Error('GitHub tool call returned without model content.');

          agentContents.push(result.functionCallContent);
          const responseParts = [];

          for (const call of result.functionCalls) {
            const toolLabels = {
              github_import_repository: 'GitHub Import',
              github_search_code: 'GitHub Search',
              github_read_file: 'GitHub File Reader',
              github_propose_changes: 'GitHub Change Planner'
            };
            const toolName = toolLabels[call?.name] || 'GitHub Tool';
            const rawPath = call?.args?.path ? String(call.args.path) : '';
            const toolTarget = rawPath ? toolName + ' · ' + rawPath : toolName;
            const activeExplanation = progressLine || toolTarget;

            send({ type: 'tool_status', tool: toolName, phase: 'start', status: activeExplanation });

            try {
              const callResult = githubSession && codingMode && validGithubRepo(githubRepository)
                ? await executeGithubToolCall(githubSession, githubRepository, githubBranch, call)
                : { error: 'GitHub workspace is not connected.' };

              if (call?.name === 'github_import_repository' && !callResult?.error) {
                repositoryImported = true;
              }

              send({
                type: 'tool_status',
                tool: toolName,
                phase: 'complete',
                status: toolTarget
              });

              if (call?.name === 'github_propose_changes' && callResult?.proposalReady) {
                githubProposalPrepared = true;
                send({
                  type: 'github_proposal',
                  proposal: {
                    repository: githubRepository,
                    branch: githubBranch || null,
                    summary: callResult.summary,
                    commitMessage: callResult.commitMessage,
                    edits: callResult.edits
                  }
                });
              }

              responseParts.push({
                functionResponse: {
                  name: call.name,
                  response: { output: callResult }
                }
              });
            } catch (toolError) {
              send({
                type: 'tool_status',
                tool: toolName,
                phase: 'complete',
                status: toolTarget + ' · failed: ' + String(toolError?.message || 'GitHub tool failed.')
              });
              responseParts.push({
                functionResponse: {
                  name: call?.name || 'unknown',
                  response: { error: toolError?.message || 'GitHub tool failed.' }
                }
              });
            }
          }

          agentContents.push({ role: 'user', parts: responseParts });

          // Once the exact reviewable proposal exists, no extra Gemini turn is
          // needed. Continuing here only wastes tool calls and can hit the
          // agent's per-request tool-call ceiling before the UI can finish.
          if (githubProposalPrepared) {
            finalResult = {
              text: 'I prepared the requested GitHub changes for your review. Use Apply Changes to write them to the connected repository.'
            };
            break;
          }

          continue;
        }

        /*
         * Gemini can occasionally answer with a progress sentence after a
         * repository import instead of immediately issuing its next tool call.
         * For actual change requests, that sentence is not a valid final turn:
         * keep the agent loop alive and explicitly ask it to continue to the
         * reviewable proposal.
         */
        if (changeRequested && githubSession && validGithubRepo(githubRepository) && !githubProposalPrepared) {
          if (result?.functionCallContent) {
            agentContents.push(result.functionCallContent);
          } else if (result?.text) {
            agentContents.push({
              role: 'model',
              parts: [{ text: String(result.text) }]
            });
          }
          const progressLine = extractUserProgress(result?.text);
          if (progressLine) send({ type: 'status', status: progressLine });
          continueCodingAgent();
          continue;
        }

        finalResult = result;

        if (!codingMode) {
          send({
            type: 'status',
            status: researchMode
              ? 'Synthesizing the sources into a clear answer…'
              : 'Writing the final response…'
          });
        }

        const grounding = getGroundingData(finalResult.groundingMetadata);
        if (grounding.sources.length || grounding.searchSuggestionHtml) {
          send({ type: 'grounding', grounding });
        }

        const finalText = String(finalResult?.text || '').trim()
          || (repositoryImported
            ? 'I finished importing your repository. Its file structure is loaded and ready for code-aware analysis.'
            : '');

        if (finalText) {
          send({ type: 'final', text: finalText });
        }

        if (notifyOnComplete) {
          try {
            await sendFcmNotification(
              userIdentifier,
              env,
              codingMode ? 'TruX-Code' : 'TruX-AI',
              codingMode ? 'Your coding response is ready.' : 'Your response is ready.',
              { type: codingMode ? 'coding' : 'chat', jobId: backgroundJobId || '' }
            );
          } catch {}
        }

        if (proTier && !developerAccount) {
          const inputChars = JSON.stringify(agentContents).length + String(systemInstruction || '').length;
          const estimatedTokens = Math.ceil((inputChars + finalText.length) / 4);
          if (codingMode) {
            const previous = await getModeUsage(userIdentifier, 'coding', env);
            const nextUsage = await recordModeUsage(userIdentifier, 'coding', previous, estimatedTokens, CODING_TOKEN_LIMIT, env);
            send({ type: 'usage', kind: 'coding', tokensUsed: nextUsage, tokensLimit: CODING_TOKEN_LIMIT });
          } else if (researchMode) {
            const previous = await getModeUsage(userIdentifier, 'deep_research', env);
            const nextUsage = await recordModeUsage(userIdentifier, 'deep_research', previous, 1, DEEP_RESEARCH_LIMIT, env);
            send({ type: 'usage', kind: 'deep-research', tokensUsed: nextUsage, tokensLimit: DEEP_RESEARCH_LIMIT });
          } else {
            const currentUsage = await getProTokenUsage(userIdentifier, env);
            const nextUsage = await recordProTokenUsage(userIdentifier, currentUsage, estimatedTokens, env);
            send({ type: 'usage', kind: 'pro', tokensUsed: nextUsage, tokensLimit: PRO_TOKEN_LIMIT });
          }
        }

        return;
      }

      // Never turn an exhausted agent loop into a generic 500. Return the
      // latest useful model text when available, and clearly report that a
      // reviewable proposal was not produced yet when it was not.
      if (!finalResult) {
        const fallbackText = String(lastModelResult?.text || '').trim()
          || (repositoryImported
            ? 'I finished inspecting the connected repository, but I could not prepare a reviewable change proposal in this turn.'
            : 'I could not complete the GitHub-assisted response in this turn. Please retry the request.');
        send({ type: 'final', text: fallbackText });
      } else if (finalResult?.text) {
        send({ type: 'final', text: String(finalResult.text) });
      }

      return;
    });
  } catch (error) {
    console.error('Vertex AI Error:', error);

    return Response.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}


/* =========================================================
   SIMPLE HEALTH CHECK
   ========================================================= */

export async function onRequestGet() {
  return Response.json({ ok: true, service: 'ChatTruX-AI Vertex backend' });
}
