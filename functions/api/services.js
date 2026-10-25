import { Storage } from '@google-cloud/storage';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PDFParse } from 'pdf-parse';
import unzipper from 'unzipper';
import path from 'node:path';
import {
  getCloudRunKv,
  getFirebaseAdminApp,
  requireFirebaseUser,
  listAvailableGeminiModels,
  bucketName,
  getStorage,
  getBucket,
  safeFileName,
  userFileKey,
  objectExists,
  saveGzipJson,
  saveText,
  downloadBuffer,
  copyObject,
  listObjects,
  sha256,
  processedTextKey,
  processedMetaKey,
  getProcessedText,
  resolvePluginToolkit,
  resolveAllPluginToolkits,
  createPluginAuthLink,
  deleteConnectedAccount,
  listConnectedAccounts,
  pluginDetailForResolved,
  getComposioGeminiTools,
  executeComposioTool,
  getPluginById,
  PLUGIN_CATALOG
} from '../core.js';

const feedbackApi = (({ requireFirebaseUser }) => {
const FEEDBACK_RECIPIENT = "ekagraavn2003@gmail.com";
const MAX_MESSAGE_LENGTH = 12000;
const NO_STORE = { "Cache-Control": "no-store, private, max-age=0" };
const FEEDBACK_LABELS = {
  "bug-report": "Bug report",
  "product-feedback": "Product feedback",
  "feature-request": "Feature request",
  "general-feedback": "General feedback",
  "founder-query": "Founder query"
};

function cleanSingleLine(value, maxLength) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, maxLength);
}

async function onRequestPost({ request, env = {} }) {
  let user;
  try {
    user = await requireFirebaseUser(request, env);
  } catch (error) {
    const status = Number(error?.status) || 401;
    return Response.json(
      { error: status === 401 ? "Please sign in again before sending feedback." : "Could not verify your account." },
      { status, headers: NO_STORE }
    );
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 18000) {
    return Response.json({ error: "Your submission is too large. Please shorten it." }, { status: 413, headers: NO_STORE });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "The feedback form data was invalid." }, { status: 400, headers: NO_STORE });
  }

  const type = String(body?.type || "general-feedback");
  const label = Object.prototype.hasOwnProperty.call(FEEDBACK_LABELS, type) ? FEEDBACK_LABELS[type] : null;
  if (!label) {
    return Response.json({ error: "Choose a valid feedback type." }, { status: 400, headers: NO_STORE });
  }

  const subject = cleanSingleLine(body?.subject, 160) || label;
  const message = String(body?.message ?? "").trim();
  if (message.length < 8) {
    return Response.json({ error: "Please include a little more detail." }, { status: 400, headers: NO_STORE });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return Response.json({ error: "Your message is too long. Please shorten it." }, { status: 413, headers: NO_STORE });
  }

  const apiKey = String(env.RESEND_API_KEY || "").trim();
  const from = String(env.TRUX_FEEDBACK_FROM_EMAIL || "").trim();
  if (!apiKey || !from) {
    return Response.json(
      { error: "Email delivery is not configured on the server yet. Please try again later." },
      { status: 503, headers: NO_STORE }
    );
  }

  const submittedAt = new Date().toISOString();
  const accountEmail = String(user.email || "Not provided");
  const displayName = cleanSingleLine(user.name || user.displayName || "", 120) || "Not provided";
  const userAgent = cleanSingleLine(request.headers.get("user-agent") || "Not provided", 300);
  const text = [
    "New TruX-Omni " + label,
    "",
    "Subject: " + subject,
    "Submitted at: " + submittedAt,
    "Account name: " + displayName,
    "Account email: " + accountEmail,
    "Firebase user ID: " + String(user.uid || "Not provided"),
    "Submission type: " + type,
    "Browser/device: " + userAgent,
    "",
    "Message:",
    message
  ].join("\n");

  const email = {
    from,
    to: [FEEDBACK_RECIPIENT],
    subject: "[TruX-Omni " + label + "] " + subject,
    text,
    ...(accountEmail !== "Not provided" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(accountEmail) ? { reply_to: accountEmail } : {})
  };

  try {
    const emailResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(email),
      signal: request.signal
    });
    const providerResult = await emailResponse.json().catch(() => ({}));
    if (!emailResponse.ok) {
      console.warn("[Feedback] Email provider rejected a submission:", emailResponse.status, providerResult?.message || providerResult?.name || "provider error");
      return Response.json(
        { error: "The email service could not deliver this message right now. Please try again later." },
        { status: 502, headers: NO_STORE }
      );
    }
  } catch (error) {
    if (request.signal?.aborted) return new Response(null, { status: 499, headers: NO_STORE });
    console.error("[Feedback] Email delivery request failed:", String(error?.message || "network error"));
    return Response.json(
      { error: "The email service is temporarily unavailable. Please try again later." },
      { status: 502, headers: NO_STORE }
    );
  }

  const successMessage = type === "founder-query"
    ? "Your query was emailed to the founder."
    : "Your feedback was emailed to the founder.";
  return Response.json({ ok: true, message: successMessage }, { status: 200, headers: NO_STORE });
}
  return { onRequestPost };
})({ requireFirebaseUser });

const videoApi = (() => {
const storage = new Storage();

function parseGsUri(uri){
  const value=String(uri||"");
  if(!value.startsWith("gs://")) return null;
  const rest=value.slice(5);
  const slash=rest.indexOf("/");
  if(slash<=0) return null;
  return {bucket:rest.slice(0,slash),object:rest.slice(slash+1)};
}

async function onRequestGet({request,env}){
  try{
    const uri=new URL(request.url).searchParams.get("uri")||"";
    const parsed=parseGsUri(uri);
    const configured=String(env.TRUX_VIDEO_OUTPUT_GCS_URI||env.VIDEO_OUTPUT_GCS_URI||"").trim().replace(/\/+$/,"");
    if(!parsed||!configured.startsWith("gs://")||!uri.startsWith(configured+"/")) return new Response("Not found.",{status:404});

    const file=storage.bucket(parsed.bucket).file(parsed.object);
    const [metadata]=await file.getMetadata();
    const headers=new Headers();
    headers.set("Content-Type",metadata.contentType||"video/mp4");
    headers.set("Cache-Control","private, max-age=3600");
    if(metadata.size!=null) headers.set("Content-Length",String(metadata.size));
    return new Response(Readable.toWeb(file.createReadStream()),{status:200,headers});
  }catch(error){
    return new Response((error&&error.message)||"Video playback failed.",{status:500});
  }
}
  return { onRequestGet };
})();

const modelCatalogApi = (({ requireFirebaseUser, listAvailableGeminiModels }) => {
const OWNER_EMAIL = "ekagraavn2003@gmail.com";

async function onRequestGet({ request, env } = {}) {
  const headers = { "Cache-Control": "no-store" };
  let user;
  try {
    user = await requireFirebaseUser(request, env);
  } catch {
    return Response.json({ error: "Authentication required." }, { status: 401, headers });
  }

  if (String(user?.email || "").trim().toLowerCase() !== OWNER_EMAIL) {
    return Response.json({ error: "Owner access required." }, { status: 403, headers });
  }

  try {
    const refresh = new URL(request.url).searchParams.get("refresh") === "1";
    const models = await listAvailableGeminiModels({ refresh });
    return Response.json({ models }, { headers });
  } catch (error) {
    return Response.json(
      { error: String(error?.message || "Could not load the Google Cloud Gemini model catalog.") },
      { status: 503, headers }
    );
  }
}
  return { onRequestGet };
})({ requireFirebaseUser, listAvailableGeminiModels });

const firebaseConfigApi = (() => {
async function onRequestGet(context) {
  const env = context?.env || process.env || {};
  const firebaseConfig = {
    apiKey: env.FIREBASE_API_KEY || "AIzaSyAs_GDrzlBaucHfiff0Y6cA8GVHjFTA62Q",
    authDomain: env.FIREBASE_AUTH_DOMAIN || "trux-ai.firebaseapp.com",
    projectId: env.FIREBASE_PROJECT_ID || "trux-ai",
    storageBucket: env.FIREBASE_STORAGE_BUCKET || "trux-ai.firebasestorage.app",
    messagingSenderId: env.FIREBASE_MESSAGING_SENDER_ID || "59313097411",
    appId: env.FIREBASE_APP_ID || "1:59313097411:web:32e4158bfb733fa7cfb076",
    measurementId: env.FIREBASE_MEASUREMENT_ID || "G-C32LC29QHC"
  };
  return Response.json(firebaseConfig);
}
  return { onRequestGet };
})();

const filesApi = (({
  downloadBuffer, getBucket, processedMetaKey, processedTextKey, userFileKey, requireFirebaseUser
}) => {
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

async function handleUpload({ request, env }) {
  const user = await requireFirebaseUser(request, env);
  const name = decodeURIComponent(String(request.headers.get('x-trux-file-name') || 'upload.bin')).slice(0, 200);
  const mimeType = String(request.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
  const declaredSize = Number(request.headers.get('content-length') || 0);

  if (!request.body) {
    return Response.json({ error: 'File body is missing.' }, { status: 400 });
  }
  if (declaredSize > MAX_UPLOAD_BYTES) {
    return Response.json({ error: 'Files are limited to 30 MB.' }, { status: 413 });
  }

  const objectKey = userFileKey(user.uid, name);
  const target = getBucket(env).file(objectKey);
  let total = 0;

  const limiter = new Transform({
    transform(chunk, enc, callback) {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES) {
        callback(new Error('Files are limited to 30 MB.'));
        return;
      }
      callback(null, chunk);
    }
  });

  try {
    await pipeline(
      Readable.fromWeb(request.body),
      limiter,
      target.createWriteStream({
        resumable: false,
        validation: 'crc32c',
        metadata: {
          contentType: mimeType,
          metadata: { ownerUid: user.uid, originalName: name }
        }
      })
    );
  } catch (error) {
    try { await target.delete({ ignoreNotFound: true }); } catch {}
    const status = /limited to 30 MB/i.test(String(error?.message)) ? 413 : 500;
    return Response.json({ error: status === 413 ? error.message : 'Upload failed.' }, { status });
  }

  return Response.json({
    ok: true,
    objectKey,
    name,
    size: total,
    mimeType
  });
}

const MAX_PROCESS_BYTES = 30 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 5_000_000;
const MAX_ZIP_FILES = 1500;
const MAX_ZIP_FILE_BYTES = 800_000;
const IGNORED_DIRS = /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|target|vendor)(\/|$)/i;
const TEXT_EXTS = new Set([
  'txt','md','markdown','json','csv','log','js','jsx','ts','tsx','html','css','xml','py',
  'java','c','cpp','h','hpp','cs','go','rs','sql','sh','yaml','yml','toml','ini','env',
  'vue','svelte','php','rb','swift','kt','kts','dart'
]);

function extension(name) {
  return path.extname(String(name || '')).toLowerCase().replace(/^\./, '');
}

function looksText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let zeros = 0;
  for (const b of sample) if (b === 0) zeros++;
  return zeros === 0;
}

function clip(text) {
  const value = String(text || '').replace(/\r\n?/g, '\n');
  return value.length > MAX_EXTRACTED_CHARS ? value.slice(0, MAX_EXTRACTED_CHARS) + '\n\n[Extraction capped at 5,000,000 characters.]' : value;
}

async function extractPdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return {
      kind: 'pdf',
      text: clip(result?.text || ''),
      pages: Array.isArray(result?.pages) ? result.pages.length : null
    };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractZip(buffer) {
  const directory = await unzipper.Open.buffer(buffer);
  const chunks = [];
  let included = 0;
  let skipped = 0;

  for (const entry of directory.files.slice(0, MAX_ZIP_FILES)) {
    const entryPath = String(entry.path || '');
    if (!entryPath || entry.type === 'Directory' || IGNORED_DIRS.test(entryPath)) {
      skipped++;
      continue;
    }
    const ext = extension(entryPath);
    if (!TEXT_EXTS.has(ext) || Number(entry.uncompressedSize || 0) > MAX_ZIP_FILE_BYTES) {
      skipped++;
      continue;
    }

    try {
      const data = await entry.buffer();
      if (!looksText(data)) {
        skipped++;
        continue;
      }
      const text = data.toString('utf8').replace(/\u0000/g, '');
      chunks.push(`--- FILE: ${entryPath} ---\n${text}\n`);
      included++;
      if (chunks.join('\n').length >= MAX_EXTRACTED_CHARS) break;
    } catch {
      skipped++;
    }
  }

  return {
    kind: 'codebase',
    text: clip(chunks.join('\n')),
    filesIncluded: included,
    filesSkipped: skipped
  };
}

async function extractFile(buffer, name, mimeType) {
  const ext = extension(name);
  if (ext === 'pdf' || mimeType === 'application/pdf') return extractPdf(buffer);
  if (ext === 'zip' || mimeType === 'application/zip') return extractZip(buffer);

  if (TEXT_EXTS.has(ext) || mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('csv')) {
    if (!looksText(buffer)) throw new Error('The uploaded file does not look like text data.');
    const text = buffer.toString('utf8').replace(/\u0000/g, '');
    const csv = ext === 'csv' || mimeType.includes('csv');
    const rows = csv ? text.split(/\n/).filter(Boolean).length : null;
    return { kind: csv ? 'csv' : 'text', text: clip(text), rows };
  }

  throw new Error('This file type cannot be text-processed yet. PDF, CSV, ZIP codebases, and common text/code formats are supported.');
}

async function handleProcess({ request, env }) {
  const user = await requireFirebaseUser(request, env);
  const body = await request.json();
  const objectKey = String(body?.objectKey || '');

  if (!objectKey.startsWith(`users/${user.uid}/files/`)) {
    return Response.json({ error: 'That file does not belong to this account.' }, { status: 403 });
  }

  const file = getBucket(env).file(objectKey);
  const [metadata] = await file.getMetadata();
  const size = Number(metadata?.size || 0);
  if (size > MAX_PROCESS_BYTES) {
    return Response.json({ error: 'Files are limited to 30 MB for processing.' }, { status: 413 });
  }

  const buffer = await downloadBuffer(env, objectKey);
  const originalName = String(metadata?.metadata?.originalname || metadata?.metadata?.originalName || path.basename(objectKey));
  const mimeType = String(metadata?.contentType || body?.mimeType || 'application/octet-stream');

  let extracted;
  try {
    extracted = await extractFile(buffer, originalName, mimeType);
  } catch (error) {
    return Response.json({ error: String(error?.message || 'File processing failed.') }, { status: 422 });
  }

  const textKey = processedTextKey(user.uid, objectKey);
  await getBucket(env).file(textKey).save(Buffer.from(extracted.text, 'utf8'), {
    resumable: false,
    validation: 'crc32c',
    metadata: { contentType: 'text/plain; charset=utf-8', cacheControl: 'private, no-store' }
  });

  const meta = {
    version: 1,
    objectKey,
    name: originalName,
    mimeType,
    size,
    kind: extracted.kind,
    pages: extracted.pages ?? null,
    rows: extracted.rows ?? null,
    filesIncluded: extracted.filesIncluded ?? null,
    filesSkipped: extracted.filesSkipped ?? null,
    processedAt: new Date().toISOString(),
    textKey
  };
  await getBucket(env).file(processedMetaKey(user.uid, objectKey)).save(
    Buffer.from(JSON.stringify(meta), 'utf8'),
    { resumable: false, validation: 'crc32c', metadata: { contentType: 'application/json', cacheControl: 'private, no-store' } }
  );

  return Response.json({
    ok: true,
    file: {
      objectKey,
      processedKey: textKey,
      name: originalName,
      mimeType,
      size,
      kind: meta.kind,
      pages: meta.pages,
      rows: meta.rows,
      filesIncluded: meta.filesIncluded,
      filesSkipped: meta.filesSkipped,
      snippet: `${originalName} · ${meta.kind.toUpperCase()} · ${Math.ceil(size / 1024)} KB`
    }
  });
}

async function onRequestPost(context) {
  const pathname = new URL(context.request.url).pathname;
  if (pathname === '/api/files/upload') return handleUpload(context);
  if (pathname === '/api/files/process') return handleProcess(context);
  return new Response('Not Found', { status: 404 });
}
  return { onRequestPost };
})({ downloadBuffer, getBucket, processedMetaKey, processedTextKey, userFileKey, requireFirebaseUser });

const pluginsApi = (({
  requireFirebaseUser, resolveAllPluginToolkits, listConnectedAccounts, pluginDetailForResolved,
  getPluginById, resolvePluginToolkit, createPluginAuthLink, deleteConnectedAccount
}) => {
async function onRequestGet({ request, env }) {
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

async function onRequestPost(context) {
  const pathname = new URL(context.request.url).pathname;
  if (pathname === '/api/plugins/connect') return handleConnect(context);
  if (pathname === '/api/plugins/disconnect') return handleDisconnect(context);
  return new Response('Method Not Allowed', { status: 405 });
}
  return { onRequestGet, onRequestPost };
})({
  requireFirebaseUser, resolveAllPluginToolkits, listConnectedAccounts, pluginDetailForResolved,
  getPluginById, resolvePluginToolkit, createPluginAuthLink, deleteConnectedAccount
});

const pushApi = (({ getCloudRunKv, requireFirebaseUser }) => {
const PUSH_TOKEN_TTL_SECONDS = 180 * 24 * 60 * 60;

async function onRequestGet({ request, env }) {
  if (new URL(request.url).pathname !== '/api/push/config') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  const vapidKey = String(env?.FCM_VAPID_PUBLIC_KEY || '').trim();
  return Response.json({ configured: !!vapidKey, vapidKey: vapidKey || null });
}

async function onRequestPost({ request, env }) {
  const pathname = new URL(request.url).pathname;
  if (pathname !== '/api/push/register' && pathname !== '/api/push/unregister') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let user;
  try {
    user = await requireFirebaseUser(request, env);
  } catch {
    return Response.json({ error: 'Authentication required.' }, { status: 401 });
  }

  const uid = String(user?.uid || '').trim();
  if (!uid) return Response.json({ error: 'Authenticated user required.' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  if (String(body?.userId || '').trim() !== uid) {
    return Response.json({ error: 'User identity mismatch.' }, { status: 403 });
  }

  const token = body?.token;
  const kv = getCloudRunKv(env);
  const key = 'trux_push_tokens_' + uid;

  try {
    if (pathname === '/api/push/register') {
      if (typeof token !== 'string' || token.length < 20 || token.length > 10000) {
        return Response.json({ error: 'Invalid push registration.' }, { status: 400 });
      }
      const existing = await kv.get(key, 'json');
      const tokens = Array.isArray(existing) ? existing.filter(x => typeof x === 'string') : [];
      if (!tokens.includes(token)) tokens.push(token);
      await kv.put(key, JSON.stringify(tokens.slice(-10)), { expirationTtl: PUSH_TOKEN_TTL_SECONDS });
      return Response.json({ ok: true });
    }

    if (typeof token !== 'string') return Response.json({ ok: true });
    const existing = await kv.get(key, 'json');
    const tokens = Array.isArray(existing) ? existing.filter(x => x !== token) : [];
    await kv.put(key, JSON.stringify(tokens), { expirationTtl: PUSH_TOKEN_TTL_SECONDS });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({
      error: error?.message || (pathname === '/api/push/register' ? 'Push registration failed.' : 'Push unregistration failed.')
    }, { status: 500 });
  }
}
  return { onRequestGet, onRequestPost };
})({ getCloudRunKv, requireFirebaseUser });

const ROUTES = {
  '/api/feedback': { POST: context => feedbackApi.onRequestPost(context) },
  '/api/video': { GET: context => videoApi.onRequestGet(context) },
  '/api/firebase-config': { GET: context => firebaseConfigApi.onRequestGet(context) },
  '/api/models': { GET: context => modelCatalogApi.onRequestGet(context) },
  '/api/files/upload': { POST: context => filesApi.onRequestPost(context) },
  '/api/files/process': { POST: context => filesApi.onRequestPost(context) },
  '/api/plugins': { GET: context => pluginsApi.onRequestGet(context) },
  '/api/plugins/connect': { POST: context => pluginsApi.onRequestPost(context) },
  '/api/plugins/disconnect': { POST: context => pluginsApi.onRequestPost(context) },
  '/api/push/config': { GET: context => pushApi.onRequestGet(context) },
  '/api/push/register': { POST: context => pushApi.onRequestPost(context) },
  '/api/push/unregister': { POST: context => pushApi.onRequestPost(context) }
};

async function dispatch(context) {
  const pathname = new URL(context.request.url).pathname;
  const method = String(context.request.method || 'GET').toUpperCase();
  const handler = ROUTES[pathname]?.[method];
  if (!handler) return new Response('Method Not Allowed', { status: 405 });
  return handler(context);
}

export async function onRequestGet(context) {
  return dispatch(context);
}

export async function onRequestPost(context) {
  return dispatch(context);
}
