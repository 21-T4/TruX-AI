/*
 * POST /api/chat — one conversational turn, streamed over SSE.
 * The answer is persisted to RTDB as it streams and generation is NOT tied
 * to the HTTP connection: closing the tab or refreshing keeps it running
 * and the client picks it up from RTDB. Stop is signalled through RTDB.
 */
import { getDb, requireUser } from '../lib/firebase.js';
import { HttpError, readJson, sseResponse } from '../lib/http.js';
import { contextBlock, MODE_HINTS, PERSONA, toolManifest } from '../lib/prompts.js';
import { memoryPrompt } from '../lib/memory.js';
import { personalizationPrompt, presetTemperature } from '../lib/personalization.js';
import { normalizeDevice } from '../chat/device.js';
import { getProcessedText } from '../lib/storage.js';
import { notifyUser } from '../lib/push.js';
import { addUsage, checkQuota, limitFor } from '../lib/usage.js';
import { generateOnce, MODELS, pickModel } from '../lib/vertex.js';
import { historyToContents, loadTurnContext, sanitizeClientHistory } from '../chat/context.js';
import { MessageWriter } from '../chat/writer.js';
import { Toolbox } from '../chat/tools.js';
import { runAgent } from '../chat/agent.js';

const KEY_RE = /^[-_A-Za-z0-9]{6,40}$/;
const MODES = new Set(['chat', 'deep-research', 'image', 'video']);
const INLINE_MIME = /^(image\/(png|jpeg|webp|heic|heif|gif)|audio\/|video\/|application\/pdf$)/;

function queryTokens(query) {
  return String(query || '').toLowerCase().replace(/[^a-z0-9_]+/g, ' ').split(/\s+/).filter(x => x.length >= 3).slice(0, 32);
}

/** For big files, keep the blocks most relevant to the question. */
function selectRelevant(text, query, maxChars = 120_000) {
  const source = String(text || '');
  if (source.length <= maxChars) return source;
  const tokens = queryTokens(query);
  const blocks = source.split(/(?=--- FILE: )/g).filter(Boolean);
  const candidates = blocks.length > 1 ? blocks : (source.match(/[\s\S]{1,7000}/g) || [source]);
  const ranked = candidates.map((block, index) => {
    const lower = block.toLowerCase();
    let score = index === 0 ? 1 : 0;
    for (const token of tokens) { let at = 0; while ((at = lower.indexOf(token, at)) >= 0) { score++; at += token.length; } }
    return { block, score, index };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const picked = [];
  let used = 0;
  for (const item of ranked) {
    if (used + item.block.length > maxChars) continue;
    picked.push(item); used += item.block.length;
    if (used >= maxChars * 0.9) break;
  }
  return picked.sort((a, b) => a.index - b.index).map(x => x.block).join('\n\n') + '\n\n[Large file: only the most relevant sections were loaded.]';
}

function cleanAttachments(uid, list) {
  return (Array.isArray(list) ? list : []).slice(0, 10).map(a => ({
    objectKey: String(a?.objectKey || ''),
    name: String(a?.name || 'file').slice(0, 200),
    mimeType: String(a?.mimeType || 'application/octet-stream').slice(0, 100),
    size: Number(a?.size) || 0
  })).filter(a => a.objectKey.startsWith(`users/${uid}/files/`) && !a.objectKey.includes('..'));
}

async function userParts({ uid, bucket, message, attachments }) {
  const parts = [];
  const texts = await Promise.all(attachments.map(async a => {
    if (INLINE_MIME.test(a.mimeType)) {
      parts.push({ fileData: { fileUri: `gs://${bucket}/${a.objectKey}`, mimeType: a.mimeType } });
      return '';
    }
    try { return `--- ATTACHED FILE: ${a.name} ---\n${selectRelevant(await getProcessedText(uid, a.objectKey), message)}`; }
    catch { return `[Attached file ${a.name} could not be read.]`; }
  }));
  const fileText = texts.filter(Boolean).join('\n\n');
  if (fileText) parts.push({ text: fileText });
  parts.push({ text: message || (attachments.length ? 'Please look at the attached file(s).' : '') });
  return parts;
}

async function generateTitle(message) {
  try {
    const { text } = await generateOnce({
      model: MODELS.fast,
      contents: [{ role: 'user', parts: [{ text: 'Write a short, specific title (3-6 words, no quotes, no trailing punctuation) for a chat that starts with:\n\n' + String(message).slice(0, 2000) }] }],
      config: { maxOutputTokens: 30, temperature: 0.4, thinkingConfig: { thinkingBudget: 0 } }
    });
    return text.replace(/^["'\s]+|["'.\s]+$/g, '').slice(0, 80) || '';
  } catch { return ''; }
}

async function chat(request, { env, url }) {
  const user = await requireUser(request, { limit: { name: 'chat', capacity: 20, refillPerSecond: 0.3 } });
  const body = await readJson(request, 256 * 1024);
  const incognito = body.incognito === true;
  const chatId = String(body.chatId || '');
  if (!incognito && !KEY_RE.test(chatId)) throw new HttpError(400, 'Invalid chat id.');
  const mode = MODES.has(body.mode) ? body.mode : 'chat';
  const message = String(body.message || '').slice(0, 100_000).trim();
  const attachments = cleanAttachments(user.uid, body.attachments);
  if (!message && !attachments.length) throw new HttpError(400, 'Message is empty.');
  const thinking = ['low', 'medium', 'high'].includes(body.thinking) ? body.thinking : 'low';
  const canVideo = limitFor(user, 'videos') === Infinity;
  if (mode === 'video' && !canVideo) throw new HttpError(403, 'Video generation is available on the Pro plan.');
  if (mode === 'deep-research') {
    const quota = await checkQuota(user, 'deepResearch');
    if (!quota.ok) throw new HttpError(429, `You have used all ${quota.limit} Deep Research runs this month.`);
  }

  const db = await getDb();
  const messagesRef = db.ref(`users/${user.uid}/messages/${chatId || '_incognito'}`);
  const userMessageId = messagesRef.push().key;
  const messageId = messagesRef.push().key;
  const location = body.location && Number.isFinite(+body.location.latitude) && Number.isFinite(+body.location.longitude)
    ? { latitude: +body.location.latitude, longitude: +body.location.longitude } : null;

  const contextPromise = loadTurnContext({ env, uid: user.uid, chatId, incognito });
  const controller = new AbortController();
  // Incognito turns are not stored, so they stop with the connection.
  if (incognito) request.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  return sseResponse(async rawSend => {
    let clientGone = false;
    const send = payload => { if (!rawSend(payload)) clientGone = true; };
    send({ type: 'start', chatId, userMessageId, messageId });

    const ctx = await contextPromise;
    const isFirstTurn = !incognito && ctx.history.length === 0;
    const titlePromise = isFirstTurn ? generateTitle(message || attachments[0]?.name) : null;
    const writer = new MessageWriter({ uid: user.uid, chatId, messageId, enabled: !incognito });

    if (!incognito) {
      const now = Date.now();
      const chatMeta = { updatedAt: now, mode, lastStatus: 'streaming' };
      if (isFirstTurn) Object.assign(chatMeta, { createdAt: now, title: (message || attachments[0]?.name || 'New chat').slice(0, 60) });
      await Promise.all([
        messagesRef.child(userMessageId).set({ role: 'user', text: message, attachments, createdAt: now, mode }),
        db.ref(`users/${user.uid}/chats/${chatId}`).update(chatMeta),
        writer.start({ createdAt: now + 1, mode })
      ]);
    }
    const unwatch = writer.watchStop(() => controller.abort());

    const firstImage = attachments.find(a => a.mimeType.startsWith('image/'));
    const toolbox = new Toolbox({
      env, user, memories: ctx.memories, personalization: ctx.personalization, connectedSlugs: ctx.connectedSlugs,
      attachedImageKey: firstImage?.objectKey, attachedImageMime: firstImage?.mimeType,
      origin: url.origin, writer, send, canVideo, device: normalizeDevice(body.device)
    });

    const systemInstruction = [
      PERSONA,
      toolManifest(toolbox.capabilities),
      MODE_HINTS[mode] || '',
      contextBlock({ user, location, timeZone: String(body.timeZone || 'UTC').slice(0, 60) }),
      ctx.personalization.memoryEnabled ? memoryPrompt(ctx.memories) : '',
      // Last, so the chosen personality is the freshest instruction.
      personalizationPrompt(ctx.personalization, 'chat')
    ].filter(Boolean).join('\n\n');

    const history = incognito ? sanitizeClientHistory(body.history) : ctx.history;
    const contents = [
      ...historyToContents(history, env.TRUX_BUCKET_NAME),
      { role: 'user', parts: await userParts({ uid: user.uid, bucket: env.TRUX_BUCKET_NAME, message, attachments }) }
    ];
    const ownerModel = user.owner && /^[a-z0-9][a-z0-9.\-]{2,80}$/i.test(String(body.ownerModel || '')) && body.ownerModel !== 'auto'
      ? String(body.ownerModel) : '';
    const model = ownerModel || pickModel({ message, hasMedia: attachments.length > 0, thinking, mode });
    writer.update({ model });
    send({ type: 'status', status: mode === 'deep-research' ? 'Researching…' : 'Thinking…', model });

    let status = 'done';
    let errorText = '';
    try {
      const result = await runAgent({ model, thinking, contents, systemInstruction, toolbox, writer, send, signal: controller.signal, temperature: presetTemperature(ctx.personalization) });
      if (!result.text && !writer.state.media.length) {
        writer.appendText('I could not produce a response. Please try again.');
      }
      send({ type: 'final', text: writer.state.text, sources: result.sources, media: writer.state.media });
      if (result.usage?.totalTokenCount) addUsage(user.uid, 'tokens', result.usage.totalTokenCount).catch(() => {});
      if (mode === 'deep-research') addUsage(user.uid, 'deepResearch').catch(() => {});
    } catch (error) {
      if (controller.signal.aborted) {
        status = 'stopped';
        send({ type: 'stopped' });
      } else {
        status = 'error';
        errorText = Number(error?.status) < 500 ? String(error.message) : 'The response could not be completed. Please try again.';
        console.error('[chat]', error?.stack || error?.message || error);
        send({ type: 'error', error: errorText });
      }
    } finally {
      unwatch();
    }
    await writer.finish(status, errorText ? { error: errorText } : {});

    if (titlePromise) {
      const title = await titlePromise;
      if (title) {
        await db.ref(`users/${user.uid}/chats/${chatId}/title`).set(title).catch(() => {});
        send({ type: 'title', chatId, title });
      }
    }
    if (clientGone && status === 'done' && body.notify !== false && !incognito) {
      notifyUser(user.uid, 'TruX finished your answer', writer.state.text.slice(0, 140), { chatId });
    }
  });
}

export const routes = { 'POST /api/chat': chat };
