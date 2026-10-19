import { requireFirebaseUser } from '../firebase-auth.js';
import {
  downloadBuffer,
  getBucket,
  listObjects,
  objectExists,
  saveGzipJson,
  sha256
} from '../gcs-store.js';
import { gunzip as gunzipCallback } from 'node:zlib';
import { promisify } from 'node:util';

const gunzip = promisify(gunzipCallback);
const MANIFEST_FILE = 'manifest.json.gz';
const LEGACY_FILE = 'current.json.gz';
const NO_STORE = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'private, no-store, no-cache, max-age=0, must-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0',
  'Vary': 'Authorization'
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: NO_STORE
  });
}

function accountPrefix(uid) {
  return `chat-state/${uid}/`;
}

function manifestKey(uid) {
  return accountPrefix(uid) + MANIFEST_FILE;
}

function legacyKey(uid) {
  return accountPrefix(uid) + LEGACY_FILE;
}

function chatObjectKey(uid, chatId) {
  return accountPrefix(uid) + 'chats/' + sha256(String(chatId)) + '.json.gz';
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPersistableChat(chat) {
  return isObject(chat) && chat.incognito !== true;
}

async function readGzipJson(env, objectKey) {
  // The Cloud Storage Node client can transparently decompress objects whose
  // metadata says Content-Encoding: gzip. Parse that response first; if the
  // stored bytes remain compressed (or older metadata prevents transcoding),
  // fall back to an explicit gunzip.
  const downloaded = await downloadBuffer(env, objectKey);
  try {
    return JSON.parse(downloaded.toString('utf8'));
  } catch {
    const expanded = await gunzip(downloaded);
    return JSON.parse(expanded.toString('utf8'));
  }
}

async function writeChat(env, uid, chatId, chat) {
  const id = String(chatId || '');
  if (!id || id.length > 512 || !isPersistableChat(chat)) return false;
  await saveGzipJson(env, chatObjectKey(uid, id), {
    schemaVersion: 2,
    userId: uid,
    chatId: id,
    savedAt: new Date().toISOString(),
    chat
  });
  return true;
}

async function writeManifest(env, uid) {
  await saveGzipJson(env, manifestKey(uid), {
    schemaVersion: 2,
    userId: uid,
    initialized: true,
    savedAt: new Date().toISOString()
  });
}

async function deleteChatObject(env, uid, chatId) {
  const id = String(chatId || '');
  if (!id || id.length > 512) return false;
  await getBucket(env).file(chatObjectKey(uid, id)).delete({ ignoreNotFound: true });
  return true;
}

async function migrateLegacySnapshot(env, uid, currentChats) {
  const oldKey = legacyKey(uid);
  if (!(await objectExists(env, oldKey))) return { found: false, savedAt: null };

  const legacy = await readGzipJson(env, oldKey);
  if (!isObject(legacy) || (legacy.userId && legacy.userId !== uid) || !isObject(legacy.chats)) {
    throw new Error('The legacy cloud chat snapshot is invalid or belongs to another account.');
  }

  for (const [chatId, chat] of Object.entries(legacy.chats)) {
    if (!isPersistableChat(chat)) continue;
    if (!Object.prototype.hasOwnProperty.call(currentChats, chatId)) {
      await writeChat(env, uid, chatId, chat);
      currentChats[chatId] = chat;
    }
  }

  await getBucket(env).file(oldKey).delete({ ignoreNotFound: true });
  return { found: true, savedAt: legacy.savedAt || null };
}

export async function onRequestGet({ request, env }) {
  const user = await requireFirebaseUser(request, env);
  const uid = user.uid;
  const prefix = accountPrefix(uid);
  const [files, hasManifest, hasLegacy] = await Promise.all([
    listObjects(env, prefix + 'chats/'),
    objectExists(env, manifestKey(uid)),
    objectExists(env, legacyKey(uid))
  ]);

  const chats = {};
  let savedAt = null;
  let unreadableRecords = 0;
  let missingRecords = 0;
  for (const file of files) {
    let record;
    try {
      record = await readGzipJson(env, file.name);
    } catch (error) {
      // A stale listing can race a delete. Skip missing objects and isolate a
      // malformed gzip/JSON record; neither should hide every other chat.
      const code = error?.code;
      const missing = Number(code) === 404 || code === 'ENOENT';
      const corrupt = error instanceof SyntaxError ||
        code === 'Z_DATA_ERROR' || code === 'Z_BUF_ERROR' ||
        /unexpected end of file|incorrect header check|invalid distance|invalid stored block|unexpected token/i.test(String(error?.message || ''));
      if (missing || corrupt) {
        if (missing) missingRecords++;
        else unreadableRecords++;
        console.warn('[chat-sync] Skipping unreadable chat object:', file.name, String(error?.message || error));
        continue;
      }
      // Authentication, permission, and bucket outages must not masquerade as
      // an empty history. Let the request fail so the client can retain history.
      throw error;
    }
    if (!isObject(record) || (record.userId && record.userId !== uid)) continue;
    const chatId = String(record.chatId || '');
    if (!chatId || !isPersistableChat(record.chat)) continue;
    chats[chatId] = record.chat;
    if (record.savedAt && (!savedAt || String(record.savedAt) > savedAt)) savedAt = String(record.savedAt);
  }

  let legacyFound = false;
  if (hasLegacy) {
    const legacyResult = await migrateLegacySnapshot(env, uid, chats);
    legacyFound = legacyResult.found;
    if (legacyResult.savedAt && (!savedAt || String(legacyResult.savedAt) > savedAt)) {
      savedAt = String(legacyResult.savedAt);
    }
  }

  const found = hasManifest || files.length > 0 || legacyFound;
  if (found && !hasManifest) await writeManifest(env, uid);

  return jsonResponse({
    ok: true,
    found,
    userId: uid,
    savedAt,
    unreadableRecords,
    missingRecords,
    chats
  });
}

export async function onRequestPost({ request, env }) {
  const user = await requireFirebaseUser(request, env);
  const uid = user.uid;
  let body;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, 'utf8') > 32 * 1024 * 1024) {
      return jsonResponse({ error: 'A single chat sync request is too large.' }, 413);
    }
    body = JSON.parse(raw || '{}');
  } catch (error) {
    if (error?.status) throw error;
    return jsonResponse({ error: 'Chat data is not valid JSON.' }, 400);
  }

  if (body?.incognito === true) return jsonResponse({ ok: true, skipped: true });

  if (body?.action === 'clear') {
    const [files] = await getBucket(env).getFiles({ prefix: accountPrefix(uid) + 'chats/' });
    await Promise.all(files.map(file => file.delete({ ignoreNotFound: true })));
    await getBucket(env).file(legacyKey(uid)).delete({ ignoreNotFound: true });
    await writeManifest(env, uid);
    return jsonResponse({ ok: true, cleared: true, savedAt: new Date().toISOString() });
  }

  const chats = body?.chats;
  if (chats !== undefined && !isObject(chats)) {
    return jsonResponse({ error: 'Chat data is invalid.' }, 400);
  }

  let saved = 0;
  if (typeof body?.chatId === 'string' && body.chatId && isPersistableChat(body.chat)) {
    if (await writeChat(env, uid, body.chatId, body.chat)) saved++;
  }

  if (isObject(chats)) {
    for (const [chatId, chat] of Object.entries(chats)) {
      if (await writeChat(env, uid, chatId, chat)) saved++;
    }
  }

  const deletedIds = Array.isArray(body?.deletedChatIds) ? body.deletedChatIds : [];
  if (body?.action === 'delete' && typeof body.chatId === 'string') deletedIds.push(body.chatId);
  const idsToDelete = new Set(deletedIds.map(id => String(id || '')).filter(Boolean));
  if (isObject(chats)) {
    for (const id of Object.keys(chats)) idsToDelete.delete(id);
  }
  if (typeof body?.chatId === 'string' && isPersistableChat(body.chat)) idsToDelete.delete(body.chatId);
  for (const id of idsToDelete) await deleteChatObject(env, uid, id);

  if (saved > 0 || idsToDelete.size > 0 || body?.action === 'delete') {
    await writeManifest(env, uid);
  }

  return jsonResponse({
    ok: true,
    saved,
    deleted: idsToDelete.size,
    savedAt: new Date().toISOString()
  });
}
