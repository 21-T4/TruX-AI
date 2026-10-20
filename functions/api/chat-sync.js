import { getFirebaseAdminApp, requireFirebaseUser } from '../firebase-auth.js';
import { getFirestore } from 'firebase-admin/firestore';
import crypto from 'node:crypto';
import { gzip as gzipCallback, gunzip as gunzipCallback } from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

// Keep enough headroom below Firestore's 1 MiB document limit for document
// metadata. Large conversations are compressed and split into bounded parts.
const INLINE_PAYLOAD_LIMIT = 700 * 1024;
const CHUNK_BYTES = 700 * 1024;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const BATCH_LIMIT = 400;
const NO_STORE = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'private, no-store, no-cache, max-age=0, must-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0',
  'Vary': 'Authorization'
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: NO_STORE });
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPersistableChat(chat) {
  return isObject(chat) && chat.incognito !== true;
}

function firestore() {
  return getFirestore(getFirebaseAdminApp());
}

function chatCollection(uid) {
  return firestore().collection('users').doc(uid).collection('chats');
}

function chatDocumentId(chatId) {
  return crypto.createHash('sha256').update(String(chatId)).digest('hex');
}

function chatDocument(uid, chatId) {
  return chatCollection(uid).doc(chatDocumentId(chatId));
}

function bufferFromFirestore(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value && typeof value.toUint8Array === 'function') {
    return Buffer.from(value.toUint8Array());
  }
  throw new Error('Stored chat payload is missing or invalid.');
}

async function commitDeletes(refs) {
  for (let start = 0; start < refs.length; start += BATCH_LIMIT) {
    const batch = firestore().batch();
    for (const ref of refs.slice(start, start + BATCH_LIMIT)) batch.delete(ref);
    await batch.commit();
  }
}

async function deleteChunkVersion(ref, version, count) {
  if (!version || !Number.isSafeInteger(Number(count)) || Number(count) < 1) return;
  const safeCount = Math.min(Number(count), 10000);
  const refs = [];
  for (let i = 0; i < safeCount; i++) {
    refs.push(ref.collection('parts').doc(version + '_' + i));
  }
  await commitDeletes(refs);
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function writeChat(uid, chatId, chat, options = {}) {
  const id = String(chatId || '');
  if (!id || id.length > 512 || !isPersistableChat(chat)) return false;

  const ref = chatDocument(uid, id);
  const raw = Buffer.from(JSON.stringify(chat), 'utf8');
  if (raw.length > MAX_REQUEST_BYTES) {
    throw Object.assign(new Error('A single chat is too large for one safe sync request.'), { status: 413 });
  }
  const payload = await gzip(raw, { level: 6 });
  const savedAt = String(options.savedAt || new Date().toISOString());
  const base = {
    schemaVersion: 4,
    userId: uid,
    chatId: id,
    savedAt,
    payloadBytes: payload.length
  };

  // Large chats are content-addressed per chunk. When a streamed response only
  // changes the final compressed blocks, unchanged chunks are reused instead of
  // being written again. One Firestore transaction switches the parent record
  // and updates chunk references atomically, so refreshes never see half a chat.
  const result = await firestore().runTransaction(async transaction => {
    const previousSnapshot = await transaction.get(ref);
    const previous = previousSnapshot.exists ? previousSnapshot.data() : null;
    const legacyVersion = previous?.storageMode === 'chunks' ? String(previous.storageVersion || '') : '';
    const legacyCount = previous?.storageMode === 'chunks' ? Math.max(0, Number(previous.chunkCount) || 0) : 0;

    if (payload.length <= INLINE_PAYLOAD_LIMIT) {
      transaction.set(ref, { ...base, storageMode: 'inline', payload });
      if (previous?.storageMode === 'chunks-v2') {
        for (const hash of new Set(Array.isArray(previous.chunkHashes) ? previous.chunkHashes : [])) {
          if (/^[a-f0-9]{64}$/.test(String(hash))) transaction.delete(ref.collection('parts').doc(String(hash)));
        }
      } else if (legacyVersion && legacyCount <= BATCH_LIMIT - 1) {
        for (let index = 0; index < legacyCount; index++) {
          transaction.delete(ref.collection('parts').doc(legacyVersion + '_' + index));
        }
      }
      return { legacyVersion: legacyCount > BATCH_LIMIT - 1 ? legacyVersion : '', legacyCount };
    }

    const pieces = [];
    for (let start = 0; start < payload.length; start += CHUNK_BYTES) {
      pieces.push(payload.subarray(start, Math.min(start + CHUNK_BYTES, payload.length)));
    }
    const hashes = pieces.map(hashBuffer);
    const nextHashes = new Set(hashes);
    const previousHashes = new Set(
      previous?.storageMode === 'chunks-v2' && Array.isArray(previous.chunkHashes)
        ? previous.chunkHashes.map(String)
        : []
    );

    const writtenHashes = new Set();
    for (let index = 0; index < pieces.length; index++) {
      const hash = hashes[index];
      if (previousHashes.has(hash) || writtenHashes.has(hash)) continue;
      writtenHashes.add(hash);
      transaction.set(ref.collection('parts').doc(hash), {
        storageMode: 'chunks-v2',
        sha256: hash,
        data: Buffer.from(pieces[index])
      });
    }

    transaction.set(ref, {
      ...base,
      storageMode: 'chunks-v2',
      chunkCount: hashes.length,
      chunkHashes: hashes
    });

    if (previous?.storageMode === 'chunks-v2') {
      for (const hash of previousHashes) {
        if (!nextHashes.has(hash) && /^[a-f0-9]{64}$/.test(hash)) {
          transaction.delete(ref.collection('parts').doc(hash));
        }
      }
    } else if (legacyVersion && legacyCount <= BATCH_LIMIT - 1) {
      for (let index = 0; index < legacyCount; index++) {
        transaction.delete(ref.collection('parts').doc(legacyVersion + '_' + index));
      }
    }
    return { legacyVersion: legacyCount > BATCH_LIMIT - 1 ? legacyVersion : '', legacyCount };
  });

  if (result.legacyVersion) {
    try {
      await deleteChunkVersion(ref, result.legacyVersion, result.legacyCount);
    } catch (error) {
      console.warn('[chat-sync] Old Firestore chat parts need cleanup:', String(error?.message || error));
    }
  }
  return true;
}

async function readChatDocument(snapshot, uid) {
  const record = snapshot.data();
  if (!isObject(record) || (record.userId && record.userId !== uid)) return null;
  const chatId = String(record.chatId || '');
  if (!chatId) return null;

  let payload;
  if (record.storageMode === 'chunks-v2') {
    const hashes = Array.isArray(record.chunkHashes) ? record.chunkHashes.map(String) : [];
    if (!hashes.length || hashes.length > 10000 || hashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))) {
      throw new Error('Stored chat chunk metadata is invalid.');
    }
    const uniqueHashes = [...new Set(hashes)];
    const snapshots = await Promise.all(uniqueHashes.map(hash => snapshot.ref.collection('parts').doc(hash).get()));
    const buffersByHash = new Map();
    for (let index = 0; index < snapshots.length; index++) {
      const partSnapshot = snapshots[index];
      const hash = uniqueHashes[index];
      if (!partSnapshot.exists) {
        throw Object.assign(new Error('A stored chat part is missing.'), { missingChatPart: true });
      }
      const part = partSnapshot.data();
      const bytes = bufferFromFirestore(part?.data);
      if (part?.sha256 !== hash || hashBuffer(bytes) !== hash) {
        throw new Error('Stored chat part failed integrity validation.');
      }
      buffersByHash.set(hash, bytes);
    }
    payload = Buffer.concat(hashes.map(hash => buffersByHash.get(hash)));
  } else if (record.storageMode === 'chunks') {
    // Backward compatibility for Firestore records created by the previous
    // storage format. They are converted to content-addressed parts on next save.
    const version = String(record.storageVersion || '');
    const count = Number(record.chunkCount);
    if (!version || !Number.isSafeInteger(count) || count < 1 || count > 10000) {
      throw new Error('Stored chat chunk metadata is invalid.');
    }
    const refs = [];
    for (let index = 0; index < count; index++) refs.push(snapshot.ref.collection('parts').doc(version + '_' + index));
    const parts = await Promise.all(refs.map(ref => ref.get()));
    const buffers = [];
    for (let index = 0; index < parts.length; index++) {
      if (!parts[index].exists) throw Object.assign(new Error('A stored chat part is missing.'), { missingChatPart: true });
      const part = parts[index].data();
      if (part?.storageVersion !== version || Number(part?.index) !== index) {
        throw new Error('Stored chat part metadata does not match.');
      }
      buffers.push(bufferFromFirestore(part.data));
    }
    payload = Buffer.concat(buffers);
  } else {
    payload = bufferFromFirestore(record.payload);
  }

  const expanded = await gunzip(payload);
  const chat = JSON.parse(expanded.toString('utf8'));
  if (!isPersistableChat(chat)) return null;
  return { chatId, chat, savedAt: String(record.savedAt || '') };
}

async function deleteChatWithData(ref) {
  // Serialize a delete with concurrent saves to this chat. Parent and current
  // chunk references change atomically, so a stale cleanup cannot break a new save.
  let oldChunkVersion = '';
  let oldChunkCount = 0;
  await firestore().runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return;
    const data = snapshot.data() || {};
    transaction.delete(ref);

    if (data.storageMode === 'chunks-v2') {
      for (const hash of new Set(Array.isArray(data.chunkHashes) ? data.chunkHashes.map(String) : [])) {
        if (/^[a-f0-9]{64}$/.test(hash)) transaction.delete(ref.collection('parts').doc(hash));
      }
    } else if (data.storageMode === 'chunks' && data.storageVersion) {
      oldChunkVersion = String(data.storageVersion);
      oldChunkCount = Math.max(0, Number(data.chunkCount) || 0);
      if (oldChunkCount <= BATCH_LIMIT - 1) {
        for (let index = 0; index < oldChunkCount; index++) {
          transaction.delete(ref.collection('parts').doc(oldChunkVersion + '_' + index));
        }
        oldChunkVersion = '';
      }
    }
  });

  if (oldChunkVersion) {
    try { await deleteChunkVersion(ref, oldChunkVersion, oldChunkCount); }
    catch (error) {
      console.warn('[chat-sync] Deleted chat left orphaned parts:', String(error?.message || error));
    }
  }
}

async function deleteAllFirestoreChats(uid) {
  const snapshot = await chatCollection(uid).get();
  const deletes = [];
  for (const doc of snapshot.docs) {
    const data = doc.data();
    deletes.push(doc.ref);
    if (data?.storageMode === 'chunks-v2') {
      for (const hash of new Set(Array.isArray(data.chunkHashes) ? data.chunkHashes.map(String) : [])) {
        if (/^[a-f0-9]{64}$/.test(hash)) deletes.push(doc.ref.collection('parts').doc(hash));
      }
    } else if (data?.storageMode === 'chunks' && data.storageVersion) {
      const count = Math.min(Number(data.chunkCount) || 0, 10000);
      for (let index = 0; index < count; index++) {
        deletes.push(doc.ref.collection('parts').doc(data.storageVersion + '_' + index));
      }
    }
  }
  await commitDeletes(deletes);
  return snapshot.size;
}

export async function onRequestGet({ request, env }) {
  const user = await requireFirebaseUser(request, env);
  const uid = user.uid;
  const docs = await chatCollection(uid).get();

  const chats = {};
  let savedAt = null;
  let latestChatId = null;
  let latestChatSavedAt = '';
  let unreadableRecords = 0;
  let missingRecords = 0;

  for (const snapshot of docs.docs) {
    try {
      const record = await readChatDocument(snapshot, uid);
      if (!record) continue;
      chats[record.chatId] = record.chat;
      if (record.savedAt && (!savedAt || record.savedAt > savedAt)) savedAt = record.savedAt;
      if (record.savedAt && (!latestChatSavedAt || record.savedAt > latestChatSavedAt)) {
        latestChatSavedAt = record.savedAt;
        latestChatId = record.chatId;
      }
    } catch (error) {
      if (error?.missingChatPart) missingRecords++;
      else unreadableRecords++;
      console.warn('[chat-sync] Keeping an unreadable Firestore chat record for recovery:', snapshot.id,
        String(error?.message || error));
    }
  }

  // Do not report a completely unreadable history as a successful empty
  // snapshot. Otherwise the client treats stored-but-undecodable records as
  // deleted chats after refresh. Preserve those records and return a retryable
  // error when there is no readable chat to show.
  if (docs.size > 0 && Object.keys(chats).length === 0 &&
      (unreadableRecords > 0 || missingRecords > 0)) {
    return jsonResponse({
      ok: false,
      code: 'CHAT_HISTORY_UNREADABLE',
      error: 'Saved chats exist but could not be decoded. No chat records were deleted.',
      found: true,
      storedRecords: docs.size,
      unreadableRecords,
      missingRecords,
      savedAt: null,
      latestChatId: null,
      chats: {}
    }, 503);
  }

  return jsonResponse({
    ok: true,
    found: docs.size > 0,
    userId: uid,
    savedAt,
    latestChatId,
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
    if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
      return jsonResponse({ error: 'A single chat sync request is too large.' }, 413);
    }
    body = JSON.parse(raw || '{}');
  } catch (error) {
    if (error?.status) throw error;
    return jsonResponse({ error: 'Chat data is not valid JSON.' }, 400);
  }

  if (body?.incognito === true) return jsonResponse({ ok: true, skipped: true });

  if (body?.action === 'clear') {
    const deleted = await deleteAllFirestoreChats(uid);
    return jsonResponse({
      ok: true,
      cleared: true,
      deleted,
      savedAt: new Date().toISOString()
    });
  }

  const chats = body?.chats;
  if (chats !== undefined && !isObject(chats)) {
    return jsonResponse({ error: 'Chat data is invalid.' }, 400);
  }

  let saved = 0;
  const savedIds = new Set();
  if (typeof body?.chatId === 'string' && body.chatId && isPersistableChat(body.chat)) {
    if (await writeChat(uid, body.chatId, body.chat)) {
      saved++;
      savedIds.add(body.chatId);
    }
  }
  if (isObject(chats)) {
    for (const [chatId, chat] of Object.entries(chats)) {
      if (await writeChat(uid, chatId, chat)) {
        saved++;
        savedIds.add(chatId);
      }
    }
  }

  const deletedIds = Array.isArray(body?.deletedChatIds) ? body.deletedChatIds.slice() : [];
  if (body?.action === 'delete' && typeof body.chatId === 'string') deletedIds.push(body.chatId);
  const idsToDelete = new Set(deletedIds.map(id => String(id || '')).filter(Boolean));
  for (const id of savedIds) idsToDelete.delete(id);
  if (isObject(chats)) {
    for (const id of Object.keys(chats)) idsToDelete.delete(id);
  }
  for (const id of idsToDelete) {
    const ref = chatDocument(uid, id);
    await deleteChatWithData(ref);
  }



  return jsonResponse({
    ok: true,
    saved,
    deleted: idsToDelete.size,
    savedAt: new Date().toISOString(),
    storage: 'firestore'
  });
}
