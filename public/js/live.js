/* TruX Live: real-time voice (plus camera or screen) with Gemini Live.
 *
 * Latency and audio quality:
 *  - Mic audio is captured in an AudioWorklet (off the main thread) and sent
 *    as raw 16 kHz PCM16 binary frames every ~40 ms. No base64, no
 *    ScriptProcessor, so UI work can't cause gaps.
 *  - Replies arrive as raw 24 kHz PCM16 binary frames and are scheduled back
 *    to back on one AudioContext with a small lead, which removes the
 *    crackle/"voice break" between chunks. Barge-in flushes queued audio.
 *  - Screen share / camera send one JPEG frame per second, at most 768 px.
 * Web search and memory are tools the model decides to use on its own.
 */
(() => {
  "use strict";
  const byId = id => document.getElementById(id);
  const LEAD_SECONDS = 0.06;
  let state = "idle"; // idle | connecting | live | error
  let socket = null;
  let micStream = null;
  let micContext = null;
  let micNode = null;
  let playContext = null;
  let playGain = null;
  let playhead = 0;
  const playing = new Set();
  let videoStream = null;
  let videoKind = "";
  let frameTimer = null;
  let muted = false;
  let attempt = 0;
  let lines = { user: null, assistant: null };
  let levelRaf = 0;
  let outLevel = 0;

  function setState(next) {
    state = next;
    window.__truxLiveState = next;
    const panel = byId("truxPwaLivePanel");
    if (panel) panel.dataset.state = next;
    if (typeof handleInputChange === "function") handleInputChange();
  }

  function setStatus(text) {
    const el = byId("truxPwaLiveStatus");
    if (el) el.textContent = text || "";
  }

  function openPanel() {
    const panel = byId("truxPwaLivePanel");
    if (!panel) return null;
    panel.hidden = false;
    document.body.classList.add("trux-live-open");
    return panel;
  }

  function closePanel() {
    const panel = byId("truxPwaLivePanel");
    if (panel) { panel.hidden = true; panel.classList.remove("trux-live-heard-user"); }
    document.body.classList.remove("trux-live-open");
  }

  function closeMenu() {
    const menu = byId("truxPwaLiveMenu");
    if (menu) menu.hidden = true;
    byId("truxPwaLiveMenuButton")?.setAttribute("aria-expanded", "false");
  }

  function toggleTranscript() {
    const el = byId("truxPwaLiveTranscript");
    if (!el) return;
    el.hidden = !el.hidden;
    const visible = !el.hidden;
    byId("truxPwaLiveTranscriptToggle")?.setAttribute("aria-pressed", String(visible));
    const menuItem = byId("truxPwaLiveMenuTranscript");
    if (menuItem) menuItem.textContent = visible ? "Hide transcript" : "Show transcript";
    if (visible) el.scrollTop = el.scrollHeight;
  }

  function syncButtons() {
    const set = (id, pressed, label, text) => {
      const b = byId(id); if (!b) return;
      b.setAttribute("aria-pressed", String(pressed)); b.setAttribute("aria-label", label);
      const span = byId(id + "Label"); if (span && text) span.textContent = text;
    };
    set("truxPwaLiveCamera", videoKind === "camera", videoKind === "camera" ? "Turn camera off" : "Turn camera on", videoKind === "camera" ? "Camera on" : "Camera");
    set("truxPwaLiveScreen", videoKind === "screen", videoKind === "screen" ? "Stop sharing screen" : "Share screen", videoKind === "screen" ? "Sharing" : "Share");
    set("truxPwaLiveMic", muted, muted ? "Unmute microphone" : "Mute microphone", muted ? "Mic muted" : "Mic on");
    const mc = byId("truxPwaLiveMenuCamera"); if (mc) mc.textContent = videoKind === "camera" ? "Turn camera off" : "Turn camera on";
    const mm = byId("truxPwaLiveMenuMic"); if (mm) mm.textContent = muted ? "Unmute microphone" : "Mute microphone";
  }

  /* Transcripts arrive in small pieces; append to the current line per role. */
  function addTranscript(role, text) {
    if (!text) return;
    const host = byId("truxPwaLiveTranscript");
    if (role === "user") {
      byId("truxPwaLivePanel")?.classList.add("trux-live-heard-user");
      lines.assistant = null;
    } else lines.user = null;
    if (!host) return;
    let line = lines[role];
    if (!line) {
      line = document.createElement("div");
      line.className = "trux-live-line " + (role === "user" ? "is-user" : "is-assistant");
      const who = document.createElement("b"); who.textContent = role === "user" ? "You" : "TruX";
      const body = document.createElement("div");
      line.append(who, body);
      host.appendChild(line);
      lines[role] = line;
      while (host.children.length > 80) host.firstElementChild?.remove();
    }
    line.lastElementChild.textContent += text;
    if (!host.hidden) host.scrollTop = host.scrollHeight;
  }

  function addSources(sources) {
    const host = byId("truxPwaLiveTranscript");
    if (!host || !sources?.length) return;
    const row = document.createElement("div");
    row.className = "trux-live-line trux-live-sources";
    for (const s of sources.slice(0, 4)) {
      if (!/^https?:\/\//i.test(s?.uri || "")) continue;
      const a = document.createElement("a");
      a.href = s.uri; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.textContent = s.title || new URL(s.uri).hostname;
      row.appendChild(a);
    }
    if (row.childElementCount) host.appendChild(row);
  }

  /* ---------- Playback ---------- */

  function ensurePlayback() {
    if (playContext && playContext.state !== "closed") return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    playContext = new Ctx({ sampleRate: 24000, latencyHint: "interactive" });
    playGain = playContext.createGain();
    playGain.connect(playContext.destination);
    playhead = 0;
  }

  function playPcm(arrayBuffer) {
    if (!playContext) return;
    const pcm = new Int16Array(arrayBuffer, 0, Math.floor(arrayBuffer.byteLength / 2));
    if (!pcm.length) return;
    const buffer = playContext.createBuffer(1, pcm.length, 24000);
    const ch = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) { const v = pcm[i] / 32768; ch[i] = v; const a = v < 0 ? -v : v; if (a > peak) peak = a; }
    outLevel = Math.max(outLevel, peak);
    const src = playContext.createBufferSource();
    src.buffer = buffer;
    src.connect(playGain);
    const now = playContext.currentTime;
    if (playhead < now + 0.005) playhead = now + LEAD_SECONDS; // underrun: re-prime the lead
    src.start(playhead);
    playhead += buffer.duration;
    playing.add(src);
    src.onended = () => playing.delete(src);
  }

  function flushPlayback() {
    for (const src of playing) { try { src.stop(); } catch {} }
    playing.clear();
    playhead = 0;
  }

  /* ---------- Microphone ---------- */

  async function startMic() {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    micContext = new Ctx({ latencyHint: "interactive" });
    await micContext.audioWorklet.addModule("/js/live-mic-worklet.js");
    const source = micContext.createMediaStreamSource(micStream);
    micNode = new AudioWorkletNode(micContext, "trux-mic", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
    micNode.port.onmessage = e => {
      const { pcm, level } = e.data || {};
      setLevel(level || 0);
      if (state === "live" && socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 256 * 1024) socket.send(pcm);
    };
    micNode.port.postMessage({ muted });
    source.connect(micNode);
  }

  function setLevel(inLevel) {
    if (levelRaf) return;
    levelRaf = requestAnimationFrame(() => {
      levelRaf = 0;
      const level = Math.min(1, Math.max(inLevel * 2.2, outLevel * 1.6));
      outLevel *= 0.6;
      const pill = byId("truxPwaLivePanel");
      pill?.style.setProperty("--trux-live-level", level.toFixed(2));
    });
  }

  function stopMic() {
    try { micNode?.port.close(); micNode?.disconnect(); } catch {}
    micNode = null;
    micStream?.getTracks().forEach(t => t.stop());
    micStream = null;
    try { micContext?.close(); } catch {}
    micContext = null;
  }

  function toggleMic() {
    muted = !muted;
    micNode?.port.postMessage({ muted });
    micStream?.getAudioTracks().forEach(t => { t.enabled = !muted; });
    if (muted && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "audioEnd" }));
    setStatus(muted ? "Microphone muted" : (state === "live" ? "Listening" : "Connecting…"));
    syncButtons();
  }

  /* ---------- Camera / screen ---------- */

  function stopVideo() {
    clearInterval(frameTimer); frameTimer = null;
    videoStream?.getTracks().forEach(t => t.stop());
    videoStream = null; videoKind = "";
    const wrap = byId("truxPwaLivePreviewWrap"); if (wrap) wrap.hidden = true;
    const video = byId("truxPwaLivePreview"); if (video) video.srcObject = null;
    syncButtons();
  }

  const frameCanvas = document.createElement("canvas");
  function sendFrame() {
    const video = byId("truxPwaLivePreview");
    if (!video || state !== "live" || socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 512 * 1024) return;
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return;
    const scale = Math.min(1, 768 / Math.max(w, h));
    frameCanvas.width = Math.round(w * scale); frameCanvas.height = Math.round(h * scale);
    frameCanvas.getContext("2d").drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
    frameCanvas.toBlob(blob => {
      if (!blob || socket?.readyState !== WebSocket.OPEN) return;
      const reader = new FileReader();
      reader.onload = () => {
        const data = String(reader.result || "").split(",")[1];
        if (data) socket.send(JSON.stringify({ type: "video", data }));
      };
      reader.readAsDataURL(blob);
    }, "image/jpeg", 0.7);
  }

  async function toggleVideo(kind) {
    if (videoKind === kind) { stopVideo(); return; }
    if (state !== "live" && state !== "connecting") { toast("Start Live first.", "err"); return; }
    stopVideo();
    try {
      if (kind === "screen") {
        if (!navigator.mediaDevices?.getDisplayMedia) { toast("Screen sharing isn't supported in this browser.", "err"); return; }
        videoStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
      } else {
        videoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 } }, audio: false });
      }
    } catch (error) {
      if (error?.name !== "NotAllowedError") toast((kind === "screen" ? "Screen sharing" : "Camera") + " could not start.", "err");
      return;
    }
    videoKind = kind;
    videoStream.getVideoTracks()[0]?.addEventListener("ended", () => { if (videoKind === kind) stopVideo(); });
    const video = byId("truxPwaLivePreview");
    video.srcObject = videoStream;
    await video.play().catch(() => {});
    const label = byId("truxPwaLivePreviewLabel"); if (label) label.textContent = kind === "screen" ? "Screen" : "Camera";
    const wrap = byId("truxPwaLivePreviewWrap"); if (wrap) wrap.hidden = false;
    frameTimer = setInterval(sendFrame, 1000);
    setTimeout(sendFrame, 300);
    syncButtons();
  }

  /* ---------- Session ---------- */

  async function start() {
    if (state === "live" || state === "connecting") { openPanel(); return; }
    const user = auth?.currentUser;
    if (!user) { openLoginWall("signin"); return; }
    if (typeof truxUserVerified === "function" && !truxUserVerified(user)) { openLoginWall("verify"); return; }
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) { toast("Live needs microphone support (try the latest Chrome, Edge or Safari).", "err"); return; }
    const myAttempt = ++attempt;
    openPanel();
    byId("truxPwaLiveRetry").hidden = true;
    byId("truxPwaLiveTranscript")?.replaceChildren();
    lines = { user: null, assistant: null };
    const greet = byId("truxPwaLiveGreeting");
    if (greet) greet.textContent = "Hi" + (user.displayName ? ", " + user.displayName.split(" ")[0] : "") + ". What's on your mind?";
    setState("connecting");
    setStatus("Connecting…");
    try {
      ensurePlayback();
      await playContext.resume().catch(() => {});
      const [token] = await Promise.all([user.getIdToken(), startMic()]);
      if (myAttempt !== attempt) return;
      const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/live");
      ws.binaryType = "arraybuffer";
      socket = ws;
      const timeout = setTimeout(() => { if (socket === ws && state === "connecting") fail("Live took too long to connect. Try again."); }, 15000);
      ws.onopen = () => {
        const voice = (typeof truxSelectedVoice === "function" ? truxSelectedVoice() : "") || "Kore";
        ws.send(JSON.stringify({ type: "auth", token, voice }));
      };
      ws.onmessage = event => {
        if (socket !== ws) return;
        if (typeof event.data !== "string") { playPcm(event.data); return; }
        let msg; try { msg = JSON.parse(event.data); } catch { return; }
        switch (msg.type) {
          case "connecting": setStatus("Connecting to Gemini Live…"); break;
          case "ready": clearTimeout(timeout); setState("live"); setStatus(muted ? "Microphone muted" : "Listening"); break;
          case "transcript": addTranscript(msg.role === "user" ? "user" : "assistant", msg.text); break;
          case "sources": addSources(msg.sources); break;
          case "interrupted": flushPlayback(); lines.assistant = null; break;
          case "turnComplete": lines.assistant = null; lines.user = null; break;
          case "tool": if (msg.phase === "start") setStatus(msg.name === "trux_memory_save" ? "Saving to memory…" : "Looking that up…"); else setStatus("Listening"); break;
          case "resumed": setStatus("Listening"); break;
          case "error": setStatus(msg.message || "Live hit a problem."); break;
          case "ended": stop("ended", msg.reason); break;
          default: break;
        }
      };
      ws.onclose = () => { if (socket === ws && state !== "idle") fail(state === "live" ? "Live disconnected." : "Could not connect to Live."); };
      ws.onerror = () => {};
    } catch (error) {
      if (myAttempt !== attempt) return;
      const denied = error?.name === "NotAllowedError";
      fail(denied ? "Microphone permission is needed for Live." : (error?.message || "Could not start Live."));
    }
  }

  function teardown() {
    const ws = socket;
    socket = null;
    if (ws) {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" })); } catch {}
      try { ws.close(1000); } catch {}
    }
    stopVideo();
    stopMic();
    flushPlayback();
    try { playContext?.close(); } catch {}
    playContext = null;
  }

  function fail(message) {
    teardown();
    setState("error");
    setStatus(message);
    const retry = byId("truxPwaLiveRetry"); if (retry) retry.hidden = false;
  }

  function stop(reason, detail) {
    attempt++;
    teardown();
    setState("idle");
    closePanel();
    if (reason === "ended" && detail && !/stopped/i.test(detail)) toast(detail);
  }

  function bind() {
    const on = (id, fn) => byId(id)?.addEventListener("click", fn);
    on("truxPwaLiveEnd", () => stop("stopped"));
    on("truxPwaLiveMenuButton", () => {
      const menu = byId("truxPwaLiveMenu"); if (!menu) return;
      menu.hidden = !menu.hidden;
      byId("truxPwaLiveMenuButton").setAttribute("aria-expanded", String(!menu.hidden));
    });
    on("truxPwaLiveTranscriptToggle", toggleTranscript);
    on("truxPwaLiveMenuTranscript", () => { toggleTranscript(); closeMenu(); });
    on("truxPwaLiveMenuCamera", () => { toggleVideo("camera"); closeMenu(); });
    on("truxPwaLiveMenuMic", () => { toggleMic(); closeMenu(); });
    on("truxPwaLiveCamera", () => toggleVideo("camera"));
    on("truxPwaLiveScreen", () => toggleVideo("screen"));
    on("truxPwaLiveMic", toggleMic);
    on("truxPwaLiveRetry", start);
    document.addEventListener("keydown", e => { if (e.key === "Escape" && state !== "idle" && !byId("truxPwaLivePanel")?.hidden) stop("stopped"); });

    // An empty composer turns the send button into "start Live".
    const action = byId("actionBtn");
    if (action && action.dataset.truxLiveBound !== "true") {
      action.dataset.truxLiveBound = "true";
      action.addEventListener("click", event => {
        if (action.classList.contains("stop")) return;
        const draft = byId("promptInput");
        const hasDraft = !!(draft?.value.trim() || action.classList.contains("ready"));
        const active = state === "live" || state === "connecting";
        if (active && hasDraft) { event.preventDefault(); event.stopImmediatePropagation(); toast("End the Live session before sending a chat message.", "err"); return; }
        if (hasDraft) return;
        event.preventDefault(); event.stopImmediatePropagation();
        start();
      }, true);
    }
    window.addEventListener("pagehide", () => { if (state !== "idle") stop("stopped"); });
    syncButtons();
  }

  window.startTruxLiveAssistant = start;
  window.stopTruxLiveAssistant = () => stop("stopped");
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind, { once: true });
  else bind();
})();
