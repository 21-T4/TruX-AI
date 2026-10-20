import { getDatabase } from 'firebase-admin/database';
import { getFirebaseAdminApp } from './firebase-auth.js';

const CHAT_ROOT = 'truxChatStorage/v1/users';
const CHAT_MODES = new Set(['chat', 'coding', 'deep-research']);
const CHAT_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function statusError(message, status = 500, cause = null) {
  const error = new Error(message);
  error.status = status;
  if (cause) error.cause = cause;
  return error;
}

function validateKey(value, label) {
  const key = String(value || '').trim();
  if (!CHAT_KEY_PATTERN.test(key)) throw statusError('Invalid ' + label + '.', 400);
  return key;
}
function safeMode(value) {
  const mode = String(value || 'chat');
  return CHAT_MODES.has(mode) ? mode : 'chat';
}
function safeTitle(value, fallback = 'New chat') {
  const title = String(value || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return (title || fallback).slice(0, 80);
}
function safeAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    const attachment = item && typeof item === 'object' ? item : {};
    return {
      name: String(attachment.name || 'attachment').slice(0, 240),
      size: Number.isFinite(Number(attachment.size)) ? Number(attachment.size) : null,
      mimeType: String(attachment.mimeType || '').slice(0, 160),
      kind: String(attachment.kind || 'file').slice(0, 32),
      objectKey: typeof attachment.objectKey === 'string' ? attachment.objectKey.slice(0, 1024) : null,
      processedKey: typeof attachment.processedKey === 'string' ? attachment.processedKey.slice(0, 1024) : null
    };
  });
}
function safeMetadata(value = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    title: safeTitle(input.title, 'New chat'),
    mode: safeMode(input.mode),
    pinned: input.pinned === true,
    notebookId: typeof input.notebookId === 'string' && input.notebookId.trim()
      ? input.notebookId.trim().slice(0, 128) : null,
    notebookUnassigned: input.notebookUnassigned === true
  };
}
function getDatabaseForEnv(env = {}) {
  const projectId = String(env.FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || 'trux-ai').trim();
  const databaseURL = String(
    env.FIREBASE_DATABASE_URL ||
    process.env.FIREBASE_DATABASE_URL ||
    ('https://' + projectId + '-default-rtdb.firebaseio.com')
  ).trim().replace(/\/+$/, '');
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(databaseURL)) {
    throw statusError('Firebase Realtime Database URL is not configured correctly.', 503);
  }
  try { return getDatabase(getFirebaseAdminApp(env), databaseURL); }
  catch (error) { throw statusError('Firebase Realtime Database is unavailable.', 503, error); }
}
function userRoot(uid, env = {}) {
  const value = String(uid || '');
  if (!value) throw statusError('Authentication required.', 401);
  const encodedUid = Buffer.from(value, 'utf8').toString('base64url');
  return getDatabaseForEnv(env).ref(CHAT_ROOT + '/u_' + encodedUid);
}
function getChatRef(root, chatId) {
  return root.child('chats').child(validateKey(chatId, 'chat ID'));
}
function messageKey(turnId, role) {
  return 'm_' + validateKey(turnId, 'turn ID') + '_' + role;
}

export function getFirebaseAssistantRefs(uid, chatId, turnId, env = {}) {
  const chatRef = getChatRef(userRoot(uid, env), chatId);
  const assistantRef = chatRef.child('messages').child(messageKey(turnId, 'assistant'));
  return {
    assistantRef, chunksRef: assistantRef.child('chunks'),
    statusRef: assistantRef.child('status'), countRef: assistantRef.child('chunkCount')
  };
}

export async function beginFirebaseChatTurn({
  uid, chatId, turnId, text, title, mode, metadata, attachments, env = {}
}) {
  const safeChatId = validateKey(chatId, 'chat ID');
  const safeTurnId = validateKey(turnId, 'turn ID');
  const root = userRoot(uid, env);
  const chatRef = getChatRef(root, safeChatId);
  const userMessageKey = messageKey(safeTurnId, 'user');
  const assistantMessageKey = messageKey(safeTurnId, 'assistant');
  const userMessageRef = chatRef.child('messages').child(userMessageKey);
  const assistantRef = chatRef.child('messages').child(assistantMessageKey);
  const turnReservationRef = chatRef.child('turns').child(safeTurnId);
  const [userSnapshot, assistantSnapshot, metadataSnapshot] = await Promise.all([
    userMessageRef.once('value'), assistantRef.once('value'), chatRef.child('metadata').once('value')
  ]);
  if (userSnapshot.exists() || assistantSnapshot.exists()) {
    throw statusError('This chat turn was already accepted. Reload the chat before retrying.', 409);
  }
  const reservation = await turnReservationRef.transaction(current => {
    if (current) return;
    return { status: 'starting', createdAt: Date.now() };
  });
  if (!reservation.committed) throw statusError('This chat turn was already accepted. Reload the chat before retrying.', 409);

  try {
    const oldMetadata = metadataSnapshot.val() || {};
    const supplied = safeMetadata({
      ...(metadata && typeof metadata === 'object' ? metadata : {}),
      title: title || metadata?.title, mode: mode || metadata?.mode
    });
    const now = Date.now();
    const createdAt = Number(oldMetadata.createdAt) || now;
    const chatTitle = safeTitle(oldMetadata.title || supplied.title || text);
    const chatMode = safeMode(oldMetadata.mode || supplied.mode || mode);
    const notebookId = supplied.notebookId || oldMetadata.notebookId || null;
    const pinned = oldMetadata.pinned === true || supplied.pinned;
    const notebookUnassigned = supplied.notebookUnassigned;
    // A transaction allocates an ordered pair of messages across concurrent tabs.
    const transaction = await chatRef.child('metadata/nextSequence').transaction(
      current => (Number(current) || 0) + 2
    );
    if (!transaction.committed) throw statusError('Could not allocate a chat message sequence.', 503);
    const assistantSequence = Number(transaction.snapshot.val()) || 2;
    const userSequence = assistantSequence - 1;

    await root.update({
      ['chats/' + safeChatId + '/metadata/id']: safeChatId,
      ['chats/' + safeChatId + '/metadata/title']: chatTitle,
      ['chats/' + safeChatId + '/metadata/mode']: chatMode,
      ['chats/' + safeChatId + '/metadata/createdAt']: createdAt,
      ['chats/' + safeChatId + '/metadata/updatedAt']: now,
      ['chats/' + safeChatId + '/metadata/lastMessageAt']: now,
      ['chats/' + safeChatId + '/metadata/pinned']: pinned,
      ['chats/' + safeChatId + '/metadata/notebookId']: notebookId,
      ['chats/' + safeChatId + '/metadata/notebookUnassigned']: notebookUnassigned,
      ['chats/' + safeChatId + '/messages/' + userMessageKey]: {
        id: userMessageKey, turnId: safeTurnId, sequence: userSequence, role: 'user',
        text: String(text || ''), attachments: safeAttachments(attachments),
        status: 'complete', createdAt: now, updatedAt: now
      },
      ['chats/' + safeChatId + '/messages/' + assistantMessageKey]: {
        id: assistantMessageKey, turnId: safeTurnId, sequence: assistantSequence, role: 'trux',
        text: '', status: 'streaming', chunkCount: 0, chunks: null,
        createdAt: now, updatedAt: now
      },
      ['chats/' + safeChatId + '/turns/' + safeTurnId]: {
        status: 'streaming', userMessageKey, assistantMessageKey, createdAt: now, updatedAt: now
      },
      ['chatIndex/' + safeChatId]: {
        id: safeChatId, title: chatTitle, mode: chatMode, createdAt, updatedAt: now,
        lastMessageAt: now, pinned, notebookId, notebookUnassigned
      }
    });
    return {
      uid: String(uid), chatId: safeChatId, turnId: safeTurnId, userRoot: root,
      assistantRef, assistantMessageKey, assistantText: '', chunkCount: 0, status: 'streaming', env
    };
  } catch (error) {
    try { await turnReservationRef.remove(); } catch {}
    throw error?.status ? error : statusError('Could not save the new chat turn to Firebase Realtime Database.', 503, error);
  }
}

export async function appendFirebaseAssistantChunk(context, piece) {
  const chunkText = String(piece || '');
  if (!context || context.status !== 'streaming' || !chunkText) return;
  const sequence = Number(context.chunkCount || 0) + 1;
  const now = Date.now();
  const chunkKey = 'c_' + String(sequence).padStart(12, '0');
  const messagePath = 'chats/' + context.chatId + '/messages/' + context.assistantMessageKey;
  try {
    await context.userRoot.update({
      [messagePath + '/chunks/' + chunkKey]: { sequence, text: chunkText, createdAt: now },
      [messagePath + '/chunkCount']: sequence,
      [messagePath + '/updatedAt']: now
    });
    context.assistantText += chunkText;
    context.chunkCount = sequence;
  } catch (error) {
    throw statusError('Firebase Realtime Database could not save a response chunk.', 503, error);
  }
}

export async function finishFirebaseAssistantTurn(context, finalText, status = 'complete', errorMessage = '') {
  if (!context || context.status !== 'streaming') return;
  const validStatus = new Set(['complete', 'error', 'stopped']).has(status) ? status : 'error';
  const storedText = typeof finalText === 'string' ? finalText : String(context.assistantText || '');
  const now = Date.now();
  const messagePath = 'chats/' + context.chatId + '/messages/' + context.assistantMessageKey;
  const errorText = validStatus === 'error'
    ? String(errorMessage || 'Generation failed.').replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, 600) : null;
  try {
    await context.userRoot.update({
      [messagePath + '/text']: storedText,
      [messagePath + '/status']: validStatus,
      [messagePath + '/updatedAt']: now,
      [messagePath + '/completedAt']: now,
      [messagePath + '/error']: errorText,
      ['chats/' + context.chatId + '/metadata/updatedAt']: now,
      ['chats/' + context.chatId + '/metadata/lastMessageAt']: now,
      ['chats/' + context.chatId + '/turns/' + context.turnId + '/status']: validStatus,
      ['chats/' + context.chatId + '/turns/' + context.turnId + '/updatedAt']: now,
      ['chatIndex/' + context.chatId + '/updatedAt']: now,
      ['chatIndex/' + context.chatId + '/lastMessageAt']: now
    });
    context.assistantText = storedText;
    context.status = validStatus;
  } catch (error) {
    throw statusError('Firebase Realtime Database could not finalize the response.', 503, error);
  }
}

export async function listFirebaseChatSummaries(uid, env = {}) {
  try {
    const snapshot = await userRoot(uid, env).child('chatIndex').once('value');
    const values = snapshot.val() || {};
    return Object.values(values)
      .filter(item => item && typeof item.id === 'string')
      .map(item => ({
        id: item.id, title: safeTitle(item.title), mode: safeMode(item.mode),
        createdAt: Number(item.createdAt) || 0, updatedAt: Number(item.updatedAt) || 0,
        lastMessageAt: Number(item.lastMessageAt) || Number(item.updatedAt) || 0,
        pinned: item.pinned === true,
        notebookId: typeof item.notebookId === 'string' ? item.notebookId : null,
        notebookUnassigned: item.notebookUnassigned === true,
        cloudStored: true, messagesLoaded: false, messages: []
      }))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastMessageAt - a.lastMessageAt);
  } catch (error) {
    throw error?.status ? error : statusError('Could not fetch saved chats from Firebase Realtime Database.', 503, error);
  }
}

export async function getFirebaseChatSession(uid, chatId, env = {}) {
  const safeChatId = validateKey(chatId, 'chat ID');
  try {
    const snapshot = await getChatRef(userRoot(uid, env), safeChatId).once('value');
    if (!snapshot.exists()) return null;
    const record = snapshot.val() || {};
    const metadata = record.metadata || {};
    const messages = Object.values(record.messages || {})
      .filter(message => message && typeof message === 'object')
      .sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0))
      .map(message => {
        const chunkText = Object.values(message.chunks || {})
          .filter(chunk => chunk && typeof chunk === 'object')
          .sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0))
          .map(chunk => String(chunk.text || '')).join('');
        return {
          role: message.role === 'user' ? 'user' : 'trux',
          text: typeof message.text === 'string' && message.text.length ? message.text : (chunkText || ''),
          attachments: safeAttachments(message.attachments),
          status: String(message.status || 'complete'),
          incomplete: ['streaming', 'stopped', 'error'].includes(String(message.status || '')),
          ...(message.error ? { error: String(message.error).slice(0, 600) } : {}),
          createdAt: Number(message.createdAt) || 0,
          updatedAt: Number(message.updatedAt) || 0,
          turnId: String(message.turnId || ''),
          sequence: Number(message.sequence) || 0
        };
      });
    return {
      id: safeChatId, title: safeTitle(metadata.title), mode: safeMode(metadata.mode),
      createdAt: Number(metadata.createdAt) || 0, updatedAt: Number(metadata.updatedAt) || 0,
      lastMessageAt: Number(metadata.lastMessageAt) || Number(metadata.updatedAt) || 0,
      pinned: metadata.pinned === true,
      notebookId: typeof metadata.notebookId === 'string' ? metadata.notebookId : null,
      notebookUnassigned: metadata.notebookUnassigned === true,
      cloudStored: true, messagesLoaded: true, messages
    };
  } catch (error) {
    throw error?.status ? error : statusError('Could not load this chat from Firebase Realtime Database.', 503, error);
  }
}

export async function updateFirebaseChatMetadata(uid, chatId, input = {}, env = {}) {
  const safeChatId = validateKey(chatId, 'chat ID');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw statusError('Invalid chat metadata.', 400);
  const root = userRoot(uid, env);
  const chatRef = getChatRef(root, safeChatId);
  const snapshot = await chatRef.child('metadata').once('value');
  if (!snapshot.exists()) throw statusError('Chat not found.', 404);
  const current = snapshot.val() || {};
  const next = {};
  if (Object.prototype.hasOwnProperty.call(input, 'title')) next.title = safeTitle(input.title);
  if (Object.prototype.hasOwnProperty.call(input, 'mode')) next.mode = safeMode(input.mode);
  if (Object.prototype.hasOwnProperty.call(input, 'pinned')) next.pinned = input.pinned === true;
  if (Object.prototype.hasOwnProperty.call(input, 'notebookId')) {
    next.notebookId = typeof input.notebookId === 'string' && input.notebookId.trim()
      ? input.notebookId.trim().slice(0, 128) : null;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'notebookUnassigned')) next.notebookUnassigned = input.notebookUnassigned === true;
  if (!Object.keys(next).length) return current;
  const now = Date.now();
  next.updatedAt = now;
  const updates = {};
  for (const [key, value] of Object.entries(next)) {
    updates['chats/' + safeChatId + '/metadata/' + key] = value;
    updates['chatIndex/' + safeChatId + '/' + key] = value;
  }
  updates['chats/' + safeChatId + '/metadata/updatedAt'] = now;
  updates['chatIndex/' + safeChatId + '/updatedAt'] = now;
  try { await root.update(updates); }
  catch (error) { throw statusError('Could not update chat details in Firebase Realtime Database.', 503, error); }
  return { ...current, ...next, id: safeChatId };
}

export async function deleteFirebaseChat(uid, chatId, env = {}) {
  const safeChatId = validateKey(chatId, 'chat ID');
  const root = userRoot(uid, env);
  const turns = await root.child('chats').child(safeChatId).child('turns').once('value');
  const active = Object.values(turns.val() || {}).some(turn => turn?.status === 'streaming' || turn?.status === 'starting');
  if (active) throw statusError('This chat still has a live response. Stop generation and retry deletion.', 409);
  try {
    await root.update({ ['chats/' + safeChatId]: null, ['chatIndex/' + safeChatId]: null });
  } catch (error) {
    throw statusError('Could not delete this chat from Firebase Realtime Database.', 503, error);
  }
}
