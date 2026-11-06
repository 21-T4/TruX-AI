/*
 * /api/live WebSocket bridge to Gemini Live.
 * - Audio travels as binary frames (raw PCM16) in both directions: no base64
 *   or JSON overhead, which removes most of the old latency and crackle.
 * - Built-in Google Search grounding; the model decides when to search.
 * - Screen/camera frames arrive as JSON {type:'video', data: base64 jpeg}.
 * - Session resumption + context compression keep long calls alive.
 */
import { GoogleGenAI, Modality } from '@google/genai';
import { WebSocketServer, WebSocket } from 'ws';
import { getProjectId, LIVE_LOCATION } from './lib/config.js';
import { getDb, verifyToken } from './lib/firebase.js';
import { rateLimit } from './lib/ratelimit.js';
import { LIVE_PERSONA } from './lib/prompts.js';
import { loadMemories, memoryPrompt, saveMemory, MEMORY_TOOL_DECLARATIONS } from './lib/memory.js';
import { normalizePersonalization, personalizationPrompt, presetTemperature } from './lib/personalization.js';
import { DEVICE_TOOL, deviceManifest, normalizeDevice, prepareDeviceAction } from './chat/device.js';
import { executeTruxWebTool, TRUX_WEB_TOOL_DECLARATIONS } from './lib/web-tools.js';
import { MODELS, TTS_VOICES } from './lib/vertex.js';

const MAX_SESSION_MS = 30 * 60 * 1000;
let clientPromise = null;
function liveClient() {
  if (!clientPromise) {
    clientPromise = getProjectId()
      .then(project => new GoogleGenAI({ vertexai: true, project, location: LIVE_LOCATION }))
      .catch(error => { clientPromise = null; throw error; });
  }
  return clientPromise;
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });

function sendJson(socket, packet) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(packet));
}

wss.on('connection', (socket, request) => {
  let user = null;
  let session = null;
  let closed = false;
  let resumeHandle = null;
  let memories = [];
  let config = null;
  let reconnecting = false;
  let device = null;
  const authTimer = setTimeout(() => { if (!user) socket.close(1008, 'Authentication timed out'); }, 10_000);
  const lifetime = setTimeout(() => { sendJson(socket, { type: 'ended', reason: 'Session time limit reached.' }); socket.close(1000); }, MAX_SESSION_MS);

  const close = () => {
    closed = true;
    clearTimeout(authTimer);
    clearTimeout(lifetime);
    try { session?.close(); } catch {}
    session = null;
  };

  async function handleToolCalls(calls) {
    const current = session;
    const functionResponses = await Promise.all(calls.map(async call => {
      let response;
      try {
        sendJson(socket, { type: 'tool', name: call.name, phase: 'start' });
        if (call.name === 'trux_memory_save') response = await saveMemory(user.uid, call.args?.text, memories);
        else if (call.name === 'trux_web_open') response = await executeTruxWebTool({ name: call.name, args: call.args || {} });
        else if (call.name === 'trux_device_action') {
          const prepared = prepareDeviceAction(call.args || {}, device);
          if (prepared.ok) sendJson(socket, { type: 'action', action: prepared.action });
          response = prepared.ok ? { ok: true, status: 'sent_to_device', note: prepared.note } : prepared;
        }
        else response = { error: 'Unknown tool.' };
      } catch (error) {
        response = { error: String(error?.message || 'Tool failed').slice(0, 300) };
      }
      sendJson(socket, { type: 'tool', name: call.name, phase: 'complete' });
      return { id: call.id, name: call.name, response: { output: response } };
    }));
    if (!closed && session === current) session.sendToolResponse({ functionResponses });
  }

  async function connect() {
    const ai = await liveClient();
    session = await ai.live.connect({
      model: MODELS.live,
      config: {
        ...config,
        sessionResumption: resumeHandle ? { handle: resumeHandle } : {}
      },
      callbacks: {
        onmessage(message) {
          if (closed) return;
          if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
            resumeHandle = message.sessionResumptionUpdate.newHandle;
          }
          if (message.goAway) { void reconnect(); return; }
          const calls = message.toolCall?.functionCalls;
          if (calls?.length) void handleToolCalls(calls).catch(e => console.error('[live] tool', e?.message));
          const content = message.serverContent;
          if (!content) return;
          for (const part of content.modelTurn?.parts || []) {
            if (part.inlineData?.data && socket.readyState === WebSocket.OPEN) {
              socket.send(Buffer.from(part.inlineData.data, 'base64'), { binary: true });
            }
          }
          if (content.inputTranscription?.text) sendJson(socket, { type: 'transcript', role: 'user', text: content.inputTranscription.text });
          if (content.outputTranscription?.text) sendJson(socket, { type: 'transcript', role: 'assistant', text: content.outputTranscription.text });
          if (content.groundingMetadata?.groundingChunks?.length) {
            sendJson(socket, { type: 'sources', sources: content.groundingMetadata.groundingChunks.map(c => c.web).filter(Boolean).slice(0, 6).map(w => ({ title: w.title, uri: w.uri })) });
          }
          if (content.interrupted) sendJson(socket, { type: 'interrupted' });
          if (content.turnComplete) sendJson(socket, { type: 'turnComplete' });
        },
        onerror(error) {
          console.error('[live] session error:', error?.message || error);
          sendJson(socket, { type: 'error', message: 'Live connection error. Reconnecting…' });
        },
        onclose(event) {
          if (closed || reconnecting) return;
          if (resumeHandle) { void reconnect(); return; }
          sendJson(socket, { type: 'ended', reason: String(event?.reason || '') });
          try { socket.close(1000); } catch {}
        }
      }
    });
  }

  async function reconnect() {
    if (reconnecting || closed) return;
    reconnecting = true;
    const previous = session;
    try {
      await connect();
      try { previous?.close(); } catch {}
      sendJson(socket, { type: 'resumed' });
    } catch (error) {
      console.error('[live] resume failed:', error?.message);
      sendJson(socket, { type: 'ended', reason: 'Live connection was lost.' });
      try { socket.close(1011); } catch {}
    } finally {
      reconnecting = false;
    }
  }

  socket.on('message', async (data, isBinary) => {
    try {
      if (isBinary) {
        if (session && user) session.sendRealtimeInput({ audio: { data: Buffer.from(data).toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
        return;
      }
      const packet = JSON.parse(String(data));
      if (!user) {
        if (packet.type !== 'auth') throw new Error('Authenticate first.');
        user = await verifyToken(String(packet.token || ''), { checkRevoked: true });
        clearTimeout(authTimer);
        if (!rateLimit(user.uid + ':live', { capacity: 6, refillPerSecond: 1 / 60 })) {
          sendJson(socket, { type: 'error', message: 'Too many Live sessions. Please wait a minute.' });
          return socket.close(1008);
        }
        sendJson(socket, { type: 'connecting' });
        const db = await getDb();
        const [mem, snap] = await Promise.all([loadMemories(user.uid).catch(() => []), db.ref(`users/${user.uid}/personalization`).get().catch(() => null)]);
        memories = mem;
        const personalization = normalizePersonalization(snap?.val() || {});
        const voice = TTS_VOICES.includes(packet.voice) ? packet.voice : personalization.voice;
        device = normalizeDevice(packet.device);
        const declarations = [...TRUX_WEB_TOOL_DECLARATIONS];
        if (personalization.memoryEnabled) declarations.push(MEMORY_TOOL_DECLARATIONS[0]);
        if (device) declarations.push(DEVICE_TOOL);
        config = {
          responseModalities: [Modality.AUDIO],
          temperature: presetTemperature(personalization),
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          contextWindowCompression: { slidingWindow: {} },
          tools: [{ googleSearch: {} }, { functionDeclarations: declarations }],
          systemInstruction: [
            LIVE_PERSONA,
            'Current date/time: ' + new Date().toUTCString(),
            device ? deviceManifest(device) : '',
            personalization.memoryEnabled ? memoryPrompt(memories) + '\nSave durable new facts about the user with trux_memory_save, silently.' : '',
            personalizationPrompt(personalization, 'live')
          ].filter(Boolean).join('\n\n')
        };
        await connect();
        if (closed) { try { session?.close(); } catch {} return; }
        sendJson(socket, { type: 'ready', model: MODELS.live, location: LIVE_LOCATION });
        return;
      }
      if (!session) return;
      if (packet.type === 'video' && typeof packet.data === 'string' && packet.data.length < 1_500_000) {
        session.sendRealtimeInput({ video: { data: packet.data, mimeType: 'image/jpeg' } });
      } else if (packet.type === 'text' && typeof packet.text === 'string') {
        session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: packet.text.slice(0, 4000) }] }], turnComplete: true });
      } else if (packet.type === 'audioEnd') {
        session.sendRealtimeInput({ audioStreamEnd: true });
      } else if (packet.type === 'stop') {
        sendJson(socket, { type: 'ended', reason: 'Stopped.' });
        close();
        socket.close(1000);
      }
    } catch (error) {
      console.error('[live]', error?.message || error);
      sendJson(socket, { type: 'error', message: user ? 'Live session failed.' : 'Could not verify your account. Please sign in again.' });
      if (!user) socket.close(1008);
    }
  });
  socket.on('close', close);
  socket.on('error', close);
  void request;
});

export function handleLiveUpgrade(req, socket, head) {
  const origin = String(req.headers.origin || '');
  const host = String(req.headers.host || '');
  try {
    if (origin && new URL(origin).host !== host) throw new Error('origin');
  } catch {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, client => wss.emit('connection', client, req));
}
