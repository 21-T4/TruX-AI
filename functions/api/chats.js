import { requireFirebaseUser } from '../firebase-auth.js';
import { deleteFirebaseChat, getFirebaseChatSession, listFirebaseChatSummaries, updateFirebaseChatMetadata } from '../trux-chat-store.js';

function errorResponse(error) {
  const status = Number(error?.status) || 500;
  const message = status >= 500
    ? (status === 503 ? String(error?.message || 'Chat storage is temporarily unavailable.') : 'Chat request failed.')
    : String(error?.message || 'Invalid chat request.');
  return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store, private, max-age=0' } });
}
export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const user = await requireFirebaseUser(request, env);
    const chatId = new URL(request.url).searchParams.get('chatId');
    if (chatId) {
      const chat = await getFirebaseChatSession(user.uid, chatId, env);
      if (!chat) return Response.json({ error: 'Chat not found.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
      return Response.json({ chat }, { headers: { 'Cache-Control': 'no-store, private, max-age=0' } });
    }
    const chats = await listFirebaseChatSummaries(user.uid, env);
    return Response.json({ chats }, { headers: { 'Cache-Control': 'no-store, private, max-age=0' } });
  } catch (error) {
    console.error('[chat-storage] GET failed:', error?.message || error);
    return errorResponse(error);
  }
}
export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const user = await requireFirebaseUser(request, env);
    const body = await request.json();
    if (body?.action !== 'metadata') return Response.json({ error: 'Unsupported chat operation.' }, { status: 400 });
    const chat = await updateFirebaseChatMetadata(user.uid, body.chatId, body.metadata, env);
    return Response.json({ ok: true, chat }, { headers: { 'Cache-Control': 'no-store, private, max-age=0' } });
  } catch (error) {
    console.error('[chat-storage] POST failed:', error?.message || error);
    return errorResponse(error);
  }
}
export async function onRequestDelete(context) {
  const { request, env } = context;
  try {
    const user = await requireFirebaseUser(request, env);
    const chatId = new URL(request.url).searchParams.get('chatId');
    if (!chatId) return Response.json({ error: 'chatId is required.' }, { status: 400 });
    await deleteFirebaseChat(user.uid, chatId, env);
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store, private, max-age=0' } });
  } catch (error) {
    console.error('[chat-storage] DELETE failed:', error?.message || error);
    return errorResponse(error);
  }
}
