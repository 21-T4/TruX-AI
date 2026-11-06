/* Read aloud with Gemini text-to-speech.
 * /api/tts streams raw 24 kHz mono PCM16; chunks are scheduled back to back
 * on one AudioContext so playback starts on the first chunk with no gaps. */
/* All 30 prebuilt Gemini voices; the same voice is used by read aloud and Live. */
const TRUX_GEMINI_VOICES = [
  ["Zephyr", "Bright", "f"], ["Puck", "Upbeat", "m"], ["Charon", "Informative", "m"], ["Kore", "Firm", "f"], ["Fenrir", "Excitable", "m"],
  ["Leda", "Youthful", "f"], ["Orus", "Firm", "m"], ["Aoede", "Breezy", "f"], ["Callirrhoe", "Easy-going", "f"], ["Autonoe", "Bright", "f"],
  ["Enceladus", "Breathy", "m"], ["Iapetus", "Clear", "m"], ["Umbriel", "Easy-going", "m"], ["Algieba", "Smooth", "m"], ["Despina", "Smooth", "f"],
  ["Erinome", "Clear", "f"], ["Algenib", "Gravelly", "m"], ["Rasalgethi", "Informative", "m"], ["Laomedeia", "Upbeat", "f"], ["Achernar", "Soft", "f"],
  ["Alnilam", "Firm", "m"], ["Schedar", "Even", "m"], ["Gacrux", "Mature", "f"], ["Pulcherrima", "Forward", "f"], ["Achird", "Friendly", "m"],
  ["Zubenelgenubi", "Casual", "m"], ["Vindemiatrix", "Gentle", "f"], ["Sadachbia", "Lively", "m"], ["Sadaltager", "Knowledgeable", "m"], ["Sulafat", "Warm", "f"]
];
const TRUX_TTS_VOICES = TRUX_GEMINI_VOICES.map(([id, style]) => [id, id + " · " + style]);
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

async function speakText(text, button, options = {}) {
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
      body: JSON.stringify({ text: content.slice(0, 6000), voice: options.voice || truxSelectedVoice() })
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
  renderTruxVoiceGrid();
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
  const select = getEl("truxSpeechVoiceSelect"); if (select) select.value = voice;
  syncTruxVoiceGrid();
  toast(voice + " is now TruX's voice for Live and read aloud.", "ok");
}

function truxVoicePreviewLine(voice) {
  const style = (TRUX_GEMINI_VOICES.find(([id]) => id === voice) || [])[1] || "";
  return `Hi, I'm TruX, speaking as ${voice}${style ? ", my " + style.toLowerCase() + " voice" : ""}. This is how I'll sound in Live and when I read answers aloud.`;
}

function previewSpeechVoice(voice, button) {
  const id = voice || getEl("truxSpeechVoiceSelect")?.value || truxSelectedVoice();
  speakText(truxVoicePreviewLine(id), button || null, { voice: id });
}

/* Voice cards in Personalization: tap a card to choose, the play button to preview. */
function renderTruxVoiceGrid() {
  const host = getEl("truxVoiceGrid");
  if (!host) return;
  if (!host.childElementCount) {
    for (const [id, style, kind] of TRUX_GEMINI_VOICES) {
      const card = document.createElement("div");
      card.className = "voice-card"; card.dataset.voice = id; card.dataset.kind = kind;
      card.innerHTML = `<button type="button" class="voice-pick" role="radio" aria-checked="false"><span class="voice-avatar" aria-hidden="true">${escapeHtml(id[0])}</span><span class="voice-copy"><b>${escapeHtml(id)}</b><small>${escapeHtml(style)}</small></span></button><button type="button" class="voice-play" aria-label="Preview ${escapeHtml(id)}"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg></button>`;
      card.querySelector(".voice-pick").onclick = () => saveSpeechVoice(id);
      const play = card.querySelector(".voice-play");
      play.onclick = () => previewSpeechVoice(id, play);
      host.appendChild(card);
    }
  }
  syncTruxVoiceGrid();
}

function syncTruxVoiceGrid() {
  const current = truxSelectedVoice();
  document.querySelectorAll("#truxVoiceGrid .voice-card").forEach(card => {
    const on = card.dataset.voice === current;
    card.classList.toggle("active", on);
    card.querySelector(".voice-pick")?.setAttribute("aria-checked", String(on));
  });
  const label = getEl("truxVoiceCurrent"); if (label) label.textContent = current;
}
