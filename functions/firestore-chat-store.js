import crypto from 'node:crypto';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const INLINE_LIMIT_BYTES = 700 * 1024;
const CHUNK_BYTES = 400 * 1024;
const MAX_CHAT_BYTES = 32 * 1024 * 1024;
const CHUNK_COLLECTION = 'chunks';

let firestoreInstance = null;

export function getChatFirestore() {
  if (firestoreInstance) return firestoreInstance;
  const app = getApps()[0] || initializeApp({ credential: applicationDefault() });
  firestoreInstance = getFirestore(app);
  return firestoreInstance;
}

function assertAccountId(uid) {
  const value = String(uid || '');
  if (!value || value.includes('/')) throw new Error('Invalid account ID for chat storage.');
  return value;
}

function normalizeChatId(chatId) {
  const value = String(chatId || '');
  if (!value || value.length > 512) throw new Error('Invalid chat ID.');
  return value;
}

function chatKey(chatId) {
  return crypto.createHash('sha256').update(String(chatId)).digest('hex');
}

function hashBytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function accountChatCollection(uid) {
  return getChatFirestore().collection('users').doc(assertAccountId(uid)).collection('chats');
}

function chatDocument(uid, chatId) {
  return accountChatCollection(uid).doc(chatKey(normalizeChatId(chatId)));
}

function chunkDocument(ref, index) {
  return ref.collection(CHUNK_COLLECTION).doc(String(index).padStart(6, '0'));
}

function splitBytes(buffer) {
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += CHUNK_BYTES) {
    chunks.push(buffer.subarray(offset, Math.min(offset + CHUNK_BYTES, buffer.length)));
  }
  return chunks;
}

async function decodeStoredChat(uid, ref, record) {
  let json;
  if (record.storageMode === 'chunked') {
    const count = Number(record.chunkCount);
    if (!Number.isInteger(count) || count < 1 || count > Math.ceil(MAX_CHAT_BYTES / CHUNK_BYTES) + 1) {
      throw new Error('Stored chat has an invalid chunk count.');
    }
    const snapshot = await ref.collection(CHUNK_COLLECTION).get();
    if (snapshot.size !== count) throw new Error('Stored chat is incomplete; one or more chunks are missing.');
    const chunks = new Array(count);
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const index = Number(data.index);
      if (!Number.isInteger(index) || index < 0 || index >= count || chunks[index]) {
        throw new Error('Stored chat has an invalid chunk index.');
      }
      const bytes = Buffer.from(String(data.data || ''), 'base64');
      const expectedHash = String(record.chunkHashes?.[index] || '');
      if (!expectedHash || hashBytes(bytes) !== expectedHash || (data.sha256 && data.sha256 !== expectedHash)) {
        throw new Error('Stored chat chunk failed integrity validation.');
      }
      chunks[index] = bytes;
    }
    if (chunks.some(chunk => !chunk)) throw new Error('Stored chat is incomplete; one or more chunks are missing.');
    const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (totalBytes > MAX_CHAT_BYTES) throw new Error('Stored chat exceeds the supported size.');
    json = Buffer.concat(chunks).toString('utf8');
  } else {
    json = String(record.payload || '');
    if (Buffer.byteLength(json, 'utf8') > INLINE_LIMIT_BYTES) {
      throw new Error('Stored chat exceeds the inline document limit.');
    }
  }

  const chat = JSON.parse(json);
  if (!chat || typeof chat !== 'object' || Array.isArray(chat) || chat.incognito === true) {
    throw new Error('Stored chat payload is invalid.');
  }
  return chat;
}

export async function readAccountChats(uid) {
  const snapshot = await accountChatCollection(uid).get();
  const chats = {};
  let savedAt = null;
  let latestChatId = null;
  let latestChatSavedAt = '';

  for (const doc of snapshot.docs) {
    const record = doc.data();
    const id = String(record.chatId || '');
    if (!id || record.userId !== uid || record.deleted === true) continue;
    const chat = await decodeStoredChat(uid, doc.ref, record);
    chats[id] = chat;
    const timestamp = typeof record.savedAt === 'string'
      ? record.savedAt
      : (record.savedAt?.toDate ? record.savedAt.toDate().toISOString() : '');
    if (timestamp && (!savedAt || timestamp > savedAt)) savedAt = timestamp;
    if (timestamp && (!latestChatSavedAt || timestamp > latestChatSavedAt)) {
      latestChatSavedAt = timestamp;
      latestChatId = id;
    }
  }

  return { chats, savedAt, latestChatId, found: snapshot.size > 0 };
}

export async function saveAccountChat(uid, chatId, chat, options = {}) {
  const accountId = assertAccountId(uid);
  const id = normalizeChatId(chatId);
  if (!chat || typeof chat !== 'object' || Array.isArray(chat) || chat.incognito === true) {
    throw new Error('Invalid chat data.');
  }

  const json = JSON.stringify(chat);
  const bytes = Buffer.from(json, 'utf8');
  if (bytes.length > MAX_CHAT_BYTES) {
    const error = new Error('This chat is too large to store safely.');
    error.status = 413;
    throw error;
  }

  const ref = chatDocument(accountId, id);
  const previous = await ref.get();
  if (options.onlyIfMissing && previous.exists) return { saved: false, existing: true };

  const old = previous.exists ? previous.data() : {};
  const oldCount = old.storageMode === 'chunked' ? Math.max(0, Number(old.chunkCount) || 0) : 0;
  const savedAt = String(options.savedAt || new Date().toISOString());
  const batch = getChatFirestore().batch();

  if (bytes.length <= INLINE_LIMIT_BYTES) {
    batch.set(ref, {
      schemaVersion: 1,
      userId: accountId,
      chatId: id,
      storageMode: 'inline',
      payload: json,
      chunkCount: 0,
      chunkHashes: [],
      savedAt
    });
    for (let index = 0; index < oldCount; index++) batch.delete(chunkDocument(ref, index));
    await batch.commit();
    return { saved: true, chunkCount: 0, bytes: bytes.length };
  }

  const pieces = splitBytes(bytes);
  const hashes = pieces.map(hashBytes);
  const oldHashes = Array.isArray(old.chunkHashes) ? old.chunkHashes : [];
  batch.set(ref, {
    schemaVersion: 1,
    userId: accountId,
    chatId: id,
    storageMode: 'chunked',
    chunkCount: pieces.length,
    chunkHashes: hashes,
    savedAt,
    byteLength: bytes.length
  });

  for (let index = 0; index < pieces.length; index++) {
    if (oldHashes[index] === hashes[index] && oldCount > index) continue;
    batch.set(chunkDocument(ref, index), {
      index,
      data: pieces[index].toString('base64'),
      sha256: hashes[index]
    });
  }
  for (let index = pieces.length; index < oldCount; index++) batch.delete(chunkDocument(ref, index));

  await batch.commit();
  return { saved: true, chunkCount: pieces.length, bytes: bytes.length };
}

export async function deleteAccountChat(uid, chatId) {
  const accountId = assertAccountId(uid);
  const id = normalizeChatId(chatId);
  const ref = chatDocument(accountId, id);
  const snapshot = await ref.get();
  const count = snapshot.exists && snapshot.data().storageMode === 'chunked'
    ? Math.max(0, Number(snapshot.data().chunkCount) || 0)
    : 0;
  const db = getChatFirestore();

  // Chunk count is stored with the parent record, so normal deletes do not need
  // an extra collection scan. A 400-operation batch leaves room below Firestore's cap.
  let batch = db.batch();
  let operations = 0;
  const commitIfFull = async () => {
    if (operations < 400) return;
    await batch.commit();
    batch = db.batch();
    operations = 0;
  };

  batch.delete(ref);
  operations++;
  for (let index = 0; index < count; index++) {
    batch.delete(chunkDocument(ref, index));
    operations++;
    await commitIfFull();
  }
  if (operations) await batch.commit();
  return { deleted: snapshot.exists };
}

export async function clearAccountChats(uid) {
  const snapshot = await accountChatCollection(uid).get();
  const db = getChatFirestore();
  let batch = db.batch();
  let operations = 0;

  const flush = async () => {
    if (!operations) return;
    await batch.commit();
    batch = db.batch();
    operations = 0;
  };
  const addDelete = async ref => {
    batch.delete(ref);
    operations++;
    if (operations >= 400) await flush();
  };

  for (const doc of snapshot.docs) {
    const record = doc.data();
    const count = record.storageMode === 'chunked'
      ? Math.max(0, Number(record.chunkCount) || 0)
      : 0;
    await addDelete(doc.ref);
    for (let index = 0; index < count; index++) await addDelete(chunkDocument(doc.ref, index));
  }
  await flush();
  return { deleted: snapshot.size };
}

export function chatStorageMigrationRef(uid) {
  return getChatFirestore().collection('users').doc(assertAccountId(uid))
    .collection('_meta').doc('chatStorageV1');
}

export async function isLegacyChatMigrationComplete(uid) {
  const snapshot = await chatStorageMigrationRef(uid).get();
  return snapshot.exists && snapshot.data()?.legacyGcsMigrationComplete === true;
}

export async function setLegacyChatMigrationState(uid, values) {
  await chatStorageMigrationRef(uid).set({
    ...values,
    updatedAt: new Date().toISOString()
  }, { merge: true });
}
