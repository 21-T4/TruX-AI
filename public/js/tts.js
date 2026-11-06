/* Read aloud with Gemini text-to-speech.
 * /api/tts streams raw 24 kHz mono PCM16; chunks are scheduled back to back
 * on one AudioContext so playback starts on the first chunk with no gaps. */
const TRUX_TTS_VOICES = [
  ["Kore", "Kore - firm"], ["Puck", "Puck - upbeat"], ["Aoede", "Aoede - breezy"], ["Charon", "Charon - informative"],
  ["Zephyr", "Zephyr - bright"], ["Leda", "Leda - youthful"], ["Fenrir", "Fenrir - excitable"], ["Orus", "Orus - steady"],
  ["Sulafat", "Sulafat - warm"], ["Achernar", "Achernar - soft"]
];
let truxTtsSession = null;

function truxSelectedVoice() {
  const v = store.getItem("trux_speech_voice") || "";
  return TRUX_TTS_VOICES.some(([id]) => id === v) ? v : "Kore";
}

function stopSpeaking() {
  const s = truxTtsSession;
  truxTtsSession = null;
  if (!s) return;
  try { s.controller.abort(); } catch {}
  try { s.ctx.close(); } catch {}
  s.button?.classList.remove("speaking");
}

async function speakText(text, button) {
  if (truxTtsSession) {
    const sameButton = truxTtsSession.button && truxTtsSession.button === button;
    stopSpeaking();
    if (sameButton) return; // second tap = stop
  }
  const content = String(text || "").trim();
  if (!content) return;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) { toast("Audio playback is not supported here.", "err"); return; }
  const ctx = new AudioCtx({ sampleRate: 24000 });
  const controller = new AbortController();
  const session = { ctx, controller, button };
  truxTtsSession = session;
  button?.classList.add("speaking");
  const rate = Math.min(2, Math.max(0.5, parseFloat(store.getItem("trux_tts_rate") || "1") || 1));
  let playhead = 0;
  let leftover = null;
  let lastSource = null;
  try {
    const res = await truxAuthenticatedFetch("/api/tts", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: content.slice(0, 6000), voice: truxSelectedVoice() })
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || "Read aloud failed."); }
    const reader = res.body.getReader();
    while (truxTtsSession === session) {
      const { value, done } = await reader.read();
      if (done) break;
      let bytes = value;
      if (leftover) { const merged = new Uint8Array(leftover.length + bytes.length); merged.set(leftover); merged.set(bytes, leftover.length); bytes = merged; leftover = null; }
      if (bytes.length % 2) { leftover = bytes.slice(-1); bytes = bytes.slice(0, -1); }
      if (!bytes.length) continue;
      const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
      const buffer = ctx.createBuffer(1, pcm.length, 24000);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;
      src.connect(ctx.destination);
      if (playhead < ctx.currentTime + 0.05) playhead = ctx.currentTime + 0.05;
      src.start(playhead);
      playhead += buffer.duration / rate;
      lastSource = src;
    }
    if (lastSource && truxTtsSession === session) lastSource.onended = () => { if (truxTtsSession === session) stopSpeaking(); };
    else if (truxTtsSession === session) stopSpeaking();
  } catch (error) {
    if (truxTtsSession === session) {
      stopSpeaking();
      if (error?.name !== "AbortError") toast(error?.message || "Read aloud failed.", "err");
    }
  }
}

function populateTruxSpeechVoices() {
  const select = getEl("truxSpeechVoiceSelect");
  if (!select) return;
  const current = truxSelectedVoice();
  select.innerHTML = "";
  for (const [id, label] of TRUX_TTS_VOICES) {
    const option = document.createElement("option");
    option.value = id; option.textContent = label; option.selected = id === current;
    select.appendChild(option);
  }
}

function saveSpeechVoice(value) {
  const voice = TRUX_TTS_VOICES.some(([id]) => id === value) ? value : "Kore";
  store.setItem("trux_speech_voice", voice);
  // The same voice is used by Live; keep it with the personalization profile.
  try { saveTruxPersonalization({ voice }, { quiet: true }); } catch {}
  toast("Voice updated.", "ok");
}

function previewSpeechVoice() {
  speakText("Hi, I'm TruX. This is how I sound when I read answers aloud.");
}
