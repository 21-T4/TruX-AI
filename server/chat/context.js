/* Everything a chat turn needs, loaded in parallel: history, memories,
   personalization and connected apps (cached briefly). */
import { getDb } from '../lib/firebase.js';
import { listConnectedAccounts } from '../lib/composio.js';
import { loadMemories } from '../lib/memory.js';
import { normalizePersonalization } from '../lib/personalization.js';

const HISTORY_MESSAGES = 40;
const HISTORY_CHARS = 160_000;
const appsCache = new Map(); // uid -> { slugs, at }

export function invalidateConnectedApps(uid) { appsCache.delete(uid); }

async function connectedApps(env, uid) {
  if (!env.COMPOSIO_API_KEY) return [];
  const cached = appsCache.get(uid);
  if (cached && Date.now() - cached.at < 60_000) return cached.slugs;
  try {
    const accounts = await listConnectedAccounts(env, uid);
    const slugs = [...new Set((accounts || []).map(a => String(a?.toolkit?.slug || a?.toolkit_slug || '').trim()).filter(Boolean))];
    appsCache.set(uid, { slugs, at: Date.now() });
    return slugs;
  } catch (error) {
    console.warn('[chat] connected apps unavailable:', error?.message);
    return [];
  }
}

async function loadHistory(uid, chatId) {
  const snapshot = await (await getDb()).ref(`users/${uid}/messages/${chatId}`).orderByKey().limitToLast(HISTORY_MESSAGES).get();
  const items = [];
  snapshot.forEach(child => {
    const m = child.val() || {};
    if (m.role !== 'user' && m.role !== 'model') return;
    if (!String(m.text || '').trim() && !m.attachments) return;
    items.push({ id: child.key, role: m.role, text: String(m.text || ''), attachments: Array.isArray(m.attachments) ? m.attachments : [], media: Array.isArray(m.media) ? m.media : [] });
  });
  return items;
}

export function sanitizeClientHistory(history) {
  return (Array.isArray(history) ? history : []).slice(-30).map(m => ({
    role: m?.role === 'model' || m?.role === 'trux' ? 'model' : 'user',
    text: String(m?.text ?? m?.content ?? '').slice(0, 40_000),
    attachments: [],
    media: []
  })).filter(m => m.text.trim());
}

/** Converts stored messages into Gemini contents; recent images go by gs:// reference. */
export function historyToContents(messages, bucket) {
  const out = [];
  let budget = HISTORY_CHARS;
  let imageTurns = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const parts = [];
    let text = m.text;
    if (text.length > budget) text = '…' + text.slice(-Math.max(0, budget));
    budget -= text.length;
    const files = [...(m.attachments || []), ...(m.media || [])];
    if (files.length) {
      const names = files.map(f => f.name || f.kind || 'file').join(', ');
      text = (text ? text + '\n' : '') + `[${m.role === 'user' ? 'Attached' : 'Generated'}: ${names}]`;
      if (imageTurns < 3 && bucket) {
        for (const f of files) {
          if (/^image\//.test(f.mimeType || '') && f.objectKey) parts.push({ fileData: { fileUri: `gs://${bucket}/${f.objectKey}`, mimeType: f.mimeType } });
        }
        if (parts.length) imageTurns++;
      }
    }
    if (text) parts.push({ text });
    if (parts.length) out.unshift({ role: m.role, parts });
    if (budget <= 0) break;
  }
  // Gemini expects the first turn to be from the user.
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

export async function loadTurnContext({ env, uid, chatId, incognito }) {
  const db = await getDb();
  const [history, memories, personalizationSnap, slugs] = await Promise.all([
    incognito ? Promise.resolve([]) : loadHistory(uid, chatId),
    loadMemories(uid).catch(() => []),
    db.ref(`users/${uid}/personalization`).get().catch(() => null),
    connectedApps(env, uid)
  ]);
  return {
    history,
    memories,
    personalization: normalizePersonalization(personalizationSnap?.val() || {}),
    connectedSlugs: slugs
  };
}
