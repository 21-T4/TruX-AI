/* Long-term memory written by the model itself via tools.
   Stored at users/{uid}/memories/{id} = { text, createdAt }. */
import { getDb } from './firebase.js';

const MAX_MEMORIES = 200;

export const MEMORY_TOOL_DECLARATIONS = [
  {
    name: 'trux_memory_save',
    description: 'Save one durable fact about the user for future conversations (preference, goal, project, personal detail they shared, correction). One short sentence, written in third person, e.g. "Prefers TypeScript over JavaScript."',
    parameters: { type: 'object', properties: { text: { type: 'string', description: 'The memory, max 300 characters.' } }, required: ['text'] }
  },
  {
    name: 'trux_memory_forget',
    description: 'Delete a saved memory that is wrong, outdated, or the user asked you to forget. Pass the memory id shown in the MEMORIES list.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  }
];

export async function loadMemories(uid) {
  const snapshot = await (await getDb()).ref(`users/${uid}/memories`).orderByChild('createdAt').limitToLast(MAX_MEMORIES).get();
  const items = [];
  snapshot.forEach(child => {
    const value = child.val();
    if (value?.text) items.push({ id: child.key, text: String(value.text), createdAt: Number(value.createdAt) || 0 });
  });
  return items;
}

export function memoryPrompt(memories) {
  if (!memories.length) return 'MEMORIES\n(none saved yet)';
  return 'MEMORIES (what you know about this user from earlier chats; use naturally, never recite the list)\n' +
    memories.map(m => `- [${m.id}] ${m.text}`).join('\n');
}

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export async function saveMemory(uid, text, existing = []) {
  const value = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (value.length < 3) return { ok: false, error: 'Memory text is empty.' };
  if (existing.some(m => normalize(m.text) === normalize(value))) return { ok: true, duplicate: true };
  const db = await getDb();
  if (existing.length >= MAX_MEMORIES) {
    const oldest = existing.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
    await db.ref(`users/${uid}/memories/${oldest.id}`).remove();
  }
  const ref = db.ref(`users/${uid}/memories`).push();
  await ref.set({ text: value, createdAt: Date.now(), source: 'ai' });
  existing.push({ id: ref.key, text: value, createdAt: Date.now() });
  return { ok: true, id: ref.key, text: value };
}

export async function forgetMemory(uid, id) {
  const key = String(id || '').replace(/[.#$\[\]\/]/g, '');
  if (!key) return { ok: false, error: 'Missing memory id.' };
  await (await getDb()).ref(`users/${uid}/memories/${key}`).remove();
  return { ok: true, id: key };
}
