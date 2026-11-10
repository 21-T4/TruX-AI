/* Account data over the server (Admin SDK).
 *
 * The browser normally talks to Realtime Database directly, which only works when database.rules.json is deployed.
 * These routes read and write the very same paths on the caller's behalf, so chats, personalization and memories keep
 * working when the rules are missing or stale (the same way TruX Code, which has no client-side database rules).
 * Every path is scoped to the verified caller's uid and every write is validated here.
 */
import { requireUser, getDb } from '../lib/firebase.js';
import { HttpError, json, readJson } from '../lib/http.js';
import { normalizePersonalization } from '../lib/personalization.js';

const LIMIT = { name: 'data', capacity: 120, refillPerSecond: 4 };
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const META_KEYS = new Set(['title', 'mode', 'notebookId', 'pinned', 'archived']);

const asId = value => {
  const id = String(value ?? '');
  if (!ID.test(id)) throw new HttpError(400, 'Invalid id.');
  return id;
};

async function getPersonalization(request) {
  const user = await requireUser(request, { limit: LIMIT });
  const snap = await (await getDb()).ref(`users/${user.uid}/personalization`).get();
  return json({ personalization: normalizePersonalization(snap.val() || {}) });
}

async function setPersonalization(request) {
  const user = await requireUser(request, { limit: LIMIT });
  const body = await readJson(request, 16 * 1024);
  const patch = body?.patch && typeof body.patch === 'object' ? body.patch : {};
  const db = await getDb();
  const ref = db.ref(`users/${user.uid}/personalization`);
  const merged = normalizePersonalization({ ...((await ref.get()).val() || {}), ...patch });
  const update = {};
  for (const key of Object.keys(patch)) if (key in merged) update[key] = merged[key];
  if (Object.keys(update).length) await ref.update(update);
  return json({ personalization: merged });
}

async function listMemories(request) {
  const user = await requireUser(request, { limit: LIMIT });
  const snap = await (await getDb()).ref(`users/${user.uid}/memories`).orderByChild('createdAt').limitToLast(200).get();
  const memories = Object.entries(snap.val() || {}).map(([id, m]) => ({
    id, text: String(m?.text || ''), topic: String(m?.topic || ''), kind: String(m?.kind || ''), createdAt: Number(m?.createdAt) || 0
  })).sort((a, b) => b.createdAt - a.createdAt);
  return json({ memories });
}

async function changeMemories(request) {
  const user = await requireUser(request, { limit: LIMIT });
  const body = await readJson(request, 4096);
  const base = (await getDb()).ref(`users/${user.uid}/memories`);
  if (body.action === 'clear') await base.remove();
  else if (body.action === 'delete') await base.child(asId(body.id)).remove();
  else throw new HttpError(400, 'Unknown action.');
  return json({ ok: true });
}

async function listChats(request) {
  const user = await requireUser(request, { limit: LIMIT });
  const snap = await (await getDb()).ref(`users/${user.uid}/chats`).get();
  return json({ chats: snap.val() || {} });
}

async function listMessages(request, { url }) {
  const user = await requireUser(request, { limit: LIMIT });
  const chatId = asId(url.searchParams.get('chatId'));
  const snap = await (await getDb()).ref(`users/${user.uid}/messages/${chatId}`).orderByKey().limitToLast(300).get();
  return json({ messages: snap.val() || {} });
}

/* Same edits the browser makes itself: chat meta, deletions and the stop flag. */
function checkedUpdates(raw) {
  const out = {};
  for (const [path, value] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    const parts = path.split('/');
    const [kind, chatId, a, b] = parts;
    if (!['chats', 'messages'].includes(kind) || !ID.test(chatId || '')) throw new HttpError(400, 'Unsupported update.');
    if (kind === 'chats' && parts.length === 2 && value === null) out[path] = null;
    else if (kind === 'chats' && parts.length === 3 && META_KEYS.has(a)) {
      if (a === 'pinned' || a === 'archived') out[path] = value === true;
      else if (a === 'notebookId') out[path] = value ? String(value).slice(0, 80) : null;
      else out[path] = String(value ?? '').slice(0, a === 'title' ? 120 : 20);
    }
    else if (kind === 'messages' && parts.length === 2 && value === null) out[path] = null;
    else if (kind === 'messages' && parts.length === 3 && ID.test(a) && value === null) out[path] = null;
    else if (kind === 'messages' && parts.length === 4 && ID.test(a) && b === 'stopRequested') out[path] = value === true;
    else throw new HttpError(400, 'Unsupported update.');
  }
  return out;
}

async function updateChats(request) {
  const user = await requireUser(request, { limit: LIMIT });
  const body = await readJson(request, 64 * 1024);
  const updates = checkedUpdates(body.updates);
  if (Object.keys(updates).length) await (await getDb()).ref(`users/${user.uid}`).update(updates);
  return json({ ok: true });
}

export const routes = {
  'GET /api/data/personalization': getPersonalization,
  'POST /api/data/personalization': setPersonalization,
  'GET /api/data/memories': listMemories,
  'POST /api/data/memories': changeMemories,
  'GET /api/data/chats': listChats,
  'GET /api/data/messages': listMessages,
  'POST /api/data/chats': updateChats
};
