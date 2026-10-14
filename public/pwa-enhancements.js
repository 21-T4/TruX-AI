(() => {
  "use strict";

  let deferredInstallPrompt = null;
  const byId = id => document.getElementById(id);

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredInstallPrompt = event;
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    window.toast?.("TruX-Omni is installed.", "ok");
  });

  function closeInstallHelp() {
    byId("truxPwaInstallHelp")?.remove();
  }

  function showInstallHelp() {
    let modal = byId("truxPwaInstallHelp");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "truxPwaInstallHelp";
      modal.className = "modal active";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-label", "Install TruX-Omni PWA");
      modal.innerHTML =
        '<div class="card" style="width:min(520px,100%);max-height:82vh;overflow:auto;text-align:left">' +
          '<button class="close" type="button" aria-label="Close">×</button>' +
          '<div class="mtitle">Install TruX-Omni</div>' +
          '<div class="msub">Add the complete TruX-Omni workspace to your device as a PWA. No separate app download is required.</div>' +
          '<div style="display:grid;gap:12px;margin-top:18px;font-size:13px;line-height:1.55;color:var(--txt-2)">' +
            '<div><b style="color:var(--txt)">Android / Chrome</b><br>Open the browser menu, then choose Install app or Add to Home screen.</div>' +
            '<div><b style="color:var(--txt)">iPhone / iPad</b><br>In Safari, open Share and choose Add to Home Screen.</div>' +
            '<div><b style="color:var(--txt)">Desktop</b><br>Use the install icon in the address bar, or choose Install TruX-Omni from the browser menu.</div>' +
          '</div>' +
          '<button type="button" class="mbtn" style="width:100%;margin-top:20px">Close</button>' +
        '</div>';
      modal.querySelector(".close").addEventListener("click", closeInstallHelp);
      modal.querySelector(".mbtn").addEventListener("click", closeInstallHelp);
      modal.addEventListener("click", event => { if (event.target === modal) closeInstallHelp(); });
      document.body.appendChild(modal);
    }
  }

  async function installPwa() {
    if (window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true) {
      window.toast?.("TruX-Omni is already installed.", "ok");
      return;
    }
    if (!deferredInstallPrompt) {
      showInstallHelp();
      return;
    }
    const prompt = deferredInstallPrompt;
    deferredInstallPrompt = null;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice?.outcome === "accepted") window.toast?.("TruX-Omni is being installed.", "ok");
      else showInstallHelp();
    } catch {
      showInstallHelp();
    }
  }

  function bindInstallButton() {
    const button = byId("sidebarInstallBtn");
    if (!button || button.dataset.pwaInstallBound === "true") return;
    button.dataset.pwaInstallBound = "true";
    button.removeAttribute("onclick");
    button.setAttribute("aria-label", "Install TruX-Omni");
    button.title = "Install TruX-Omni";
    button.addEventListener("click", installPwa);
  }

  function removeAndroidUi() {
    byId("contextMenuAndroidAssistantBtn")?.remove();
    byId("contextMenuAssistantSeparator")?.remove();
    byId("androidCompanionInstallModal")?.remove();
    if (location.search.includes("truxNativeMissing=")) {
      const url = new URL(location.href);
      url.searchParams.delete("truxNativeMissing");
      history.replaceState(history.state, "", url.toString());
    }
  }

  function makeDiagramStatic(stage, svg, cursor) {
    if (cursor) {
      cursor.hidden = true;
      cursor.style.setProperty("display", "none", "important");
    }
    if (stage) {
      stage.style.setProperty("width", "100%", "important");
      stage.style.setProperty("min-width", "0", "important");
      stage.style.setProperty("min-height", "0", "important");
      stage.style.setProperty("height", "auto", "important");
    }
    if (!svg) return;
    ["width", "min-width", "max-width", "height", "min-height"].forEach((prop, index) => {
      const value = ["100%", "0", "100%", "auto", "0"][index];
      svg.style.setProperty(prop, value, "important");
    });
    svg.style.setProperty("display", "block", "important");
    svg.style.setProperty("overflow", "visible", "important");
    svg.style.setProperty("background", "#151515", "important");
    svg.style.setProperty("background-color", "#151515", "important");
    svg.querySelectorAll("text,foreignObject,.edgeLabel,.nodeLabel,.cluster-label").forEach(label => {
      label.style.visibility = "";
    });
  }

  function stabilizeDiagramCard(card) {
    if (!card?.matches?.(".trux-diagram")) return;
    const stage = card.querySelector(".trux-diagram-stage");
    const slot = card.querySelector(".trux-diagram-svg");
    const svg = slot?.querySelector("svg");
    const cursor = card.querySelector(".trux-diagram-cursor");
    makeDiagramStatic(stage, svg, cursor);
    const toolbar = card.querySelector(".trux-diagram-toolbar");
    if (toolbar) toolbar.style.position = "static";
  }

  function bindDiagramRendering() {
    const style = document.createElement("style");
    style.id = "trux-pwa-static-diagrams";
    style.textContent =
      '.trux-diagram{width:100%!important;max-width:100%!important;min-width:0!important;overflow:hidden!important;background:#151515!important}' +
      '.trux-diagram-stage{display:block!important;width:100%!important;min-width:0!important;min-height:0!important;height:auto!important;background:#151515!important}' +
      '.trux-diagram-svg{display:block!important;width:100%!important;min-width:0!important;max-width:100%!important;background:#151515!important}' +
      '.trux-diagram-svg svg{display:block!important;width:100%!important;min-width:0!important;max-width:100%!important;height:auto!important;min-height:0!important;background:#151515!important}' +
      '.trux-diagram-cursor{display:none!important}' +
      '.trux-diagram-toolbar{position:static!important}' +
      '@media(prefers-reduced-motion:reduce){.trux-diagram *{animation:none!important;transition:none!important}}';
    document.head.appendChild(style);

    // The existing renderer calls this after inserting SVG. Replace only the
    // drawing animation; the AI's SVG geometry and arbitrary labels stay intact.
    window.animateTruxDiagramDrawing = makeDiagramStatic;

    const scan = node => {
      if (!(node instanceof Element)) return;
      if (node.matches(".trux-diagram")) stabilizeDiagramCard(node);
      node.querySelectorAll?.(".trux-diagram").forEach(stabilizeDiagramCard);
    };
    scan(document.body);
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === "childList") record.addedNodes.forEach(scan);
        else if (record.target instanceof Element) scan(record.target.closest(".trux-diagram") || record.target);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function installLiveUi() {
    let panel;
    function ensurePanel() {
      panel = byId("truxPwaLivePanel");
      if (!panel) {
        panel = document.createElement("section");
        panel.id = "truxPwaLivePanel";
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", "TruX Live");
        panel.innerHTML =
          '<div class="trux-live-head"><div><b>TruX Live</b><div id="truxPwaLiveStatus">Connecting…</div></div>' +
          '<button type="button" id="truxPwaLiveStop">Stop</button></div>' +
          '<div id="truxPwaLiveTranscript" class="trux-live-transcript" aria-live="polite"></div>';
        document.body.appendChild(panel);
        panel.querySelector("#truxPwaLiveStop").addEventListener("click", () => stop("stopped"));
      }
      panel.hidden = false;
      return panel;
    }

    let socket = null;
    let stream = null;
    let audioContext = null;
    let sourceNode = null;
    let processor = null;
    let mute = null;
    let playbackAt = 0;
    const playback = new Set();

    function status(value) {
      const el = byId("truxPwaLiveStatus");
      if (el) el.textContent = value;
    }
    function transcript(role, text) {
      const value = String(text || "").trim();
      if (!value) return;
      const el = byId("truxPwaLiveTranscript");
      if (!el) return;
      const line = document.createElement("div");
      line.className = "trux-live-line " + (role === "user" ? "is-user" : "is-assistant");
      const who = document.createElement("b");
      who.textContent = role === "user" ? "You" : "TruX";
      const body = document.createElement("div");
      body.textContent = value;
      line.append(who, body);
      el.appendChild(line);
      while (el.children.length > 80) el.firstElementChild?.remove();
      el.scrollTop = el.scrollHeight;
    }
    function pcmBase64(samples, inputRate) {
      const ratio = inputRate / 16000;
      const len = Math.floor(samples.length / ratio);
      if (!len) return "";
      const pcm = new Int16Array(len);
      for (let i = 0; i < len; i++) {
        const n = Math.max(-1, Math.min(1, samples[Math.min(samples.length - 1, Math.floor(i * ratio))] || 0));
        pcm[i] = n < 0 ? n * 32768 : n * 32767;
      }
      const bytes = new Uint8Array(pcm.buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x8000)));
      return btoa(binary);
    }
    function startMic(forSocket) {
      const src = audioContext.createMediaStreamSource(stream);
      const proc = audioContext.createScriptProcessor(4096, 1, 1);
      const gain = audioContext.createGain();
      gain.gain.value = 0;
      proc.onaudioprocess = event => {
        if (socket !== forSocket || forSocket.readyState !== WebSocket.OPEN || forSocket.bufferedAmount > 1048576) return;
        const data = pcmBase64(event.inputBuffer.getChannelData(0), audioContext.sampleRate);
        if (data) {
          try { forSocket.send(JSON.stringify({ type: "audio", data })); } catch {}
        }
      };
      src.connect(proc);
      proc.connect(gain);
      gain.connect(audioContext.destination);
      sourceNode = src; processor = proc; mute = gain;
    }
    function playAudio(packet) {
      if (!audioContext || !packet?.data) return;
      try {
        const binary = atob(packet.data);
        const len = Math.floor(binary.length / 2);
        if (!len) return;
        const samples = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          let v = binary.charCodeAt(i*2) | (binary.charCodeAt(i*2+1) << 8);
          if (v >= 32768) v -= 65536;
          samples[i] = v / 32768;
        }
        const match = String(packet.mimeType || "").match(/rate=(\d+)/i);
        const rate = match ? Number(match[1]) || 24000 : 24000;
        const buffer = audioContext.createBuffer(1, len, rate);
        buffer.copyToChannel(samples, 0);
        const node = audioContext.createBufferSource();
        node.buffer = buffer;
        node.connect(audioContext.destination);
        node.onended = () => { playback.delete(node); try { node.disconnect(); } catch {} };
        const startAt = Math.max(audioContext.currentTime + 0.02, playbackAt);
        node.start(startAt);
        playbackAt = startAt + buffer.duration;
        playback.add(node);
      } catch (error) { console.warn("TruX Live audio playback failed", error); }
    }
    function stop(nextState) {
      const old = socket;
      socket = null;
      if (old) {
        if (old.readyState === WebSocket.OPEN) { try { old.send(JSON.stringify({ type: "stop" })); } catch {} }
        try { old.close(1000, "Stopped"); } catch {}
      }
      try { if (processor) { processor.onaudioprocess = null; processor.disconnect(); } } catch {}
      try { sourceNode?.disconnect(); } catch {}
      try { mute?.disconnect(); } catch {}
      processor = null; sourceNode = null; mute = null;
      if (stream) stream.getTracks().forEach(track => { try { track.stop(); } catch {} });
      stream = null;
      for (const node of playback) { try { node.stop(); } catch {} }
      playback.clear(); playbackAt = 0;
      const oldContext = audioContext;
      audioContext = null;
      if (oldContext && oldContext.state !== "closed") oldContext.close().catch(() => {});
      if (panel) panel.hidden = true;
      window.__truxLiveState = nextState || "stopped";
      if (typeof window.handleInputChange === "function") window.handleInputChange();
      if (nextState === "error") window.toast?.("TruX Live could not connect. Check network, microphone permission, and sign-in.", "err");
      else if (nextState === "live") window.toast?.("TruX Live connected inside this workspace.", "ok");
    }
    async function start() {
      if (socket || window.__truxLiveState === "connecting") { stop("stopped"); return; }
      const auth = window.auth || window.firebase?.auth?.();
      const user = auth?.currentUser;
      if (!user) { window.openLoginWall?.(); window.toast?.("Sign in to use TruX Live.", "err"); return; }
      if (!navigator.mediaDevices?.getUserMedia) { window.toast?.("Microphone access is not available in this browser.", "err"); return; }

      ensurePanel();
      byId("truxPwaLiveTranscript").replaceChildren();
      status("Connecting…");
      window.__truxLiveState = "connecting";
      let requestStream;
      try {
        requestStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (window.__truxLiveState !== "connecting") { requestStream.getTracks().forEach(t => t.stop()); return; }
        const Context = window.AudioContext || window.webkitAudioContext;
        if (!Context) throw new Error("Web Audio is unavailable in this browser.");
        stream = requestStream;
        audioContext = new Context();
        await audioContext.resume();
        const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/live";
        const ws = new WebSocket(url);
        socket = ws;
        ws.addEventListener("open", async () => {
          try {
            const currentUser = (window.auth || window.firebase?.auth?.())?.currentUser;
            if (!currentUser) throw new Error("Sign in again to use Live.");
            const token = await currentUser.getIdToken();
            if (socket === ws && ws.readyState === WebSocket.OPEN && token) ws.send(JSON.stringify({ type: "auth", token }));
          } catch (error) {
            if (socket === ws) { status("Authentication failed"); window.toast?.(error.message || "Live authentication failed.", "err"); stop("error"); }
          }
        });
        ws.addEventListener("message", event => {
          if (socket !== ws) return;
          let packet;
          try { packet = JSON.parse(String(event.data || "{}")); } catch { return; }
          if (packet.type === "connecting") status("Connecting to Gemini…");
          else if (packet.type === "ready") {
            try { startMic(ws); window.__truxLiveState = "live"; status("Listening · connected"); window.toast?.("TruX Live connected inside this workspace.", "ok"); }
            catch (error) { window.toast?.(error.message || "Could not open microphone stream.", "err"); stop("error"); }
          } else if (packet.type === "audio") playAudio(packet);
          else if (packet.type === "transcript") transcript(packet.role, packet.text);
          else if (packet.type === "interrupted") {
            for (const node of playback) { try { node.stop(); } catch {} }
            playback.clear(); playbackAt = audioContext?.currentTime || 0;
          } else if (packet.type === "error") { status("Connection failed"); window.toast?.(packet.message || "Gemini Live failed.", "err"); stop("error"); }
          else if (packet.type === "ended") stop("stopped");
        });
        ws.addEventListener("close", () => { if (socket === ws) stop("stopped"); });
        ws.addEventListener("error", () => { if (socket === ws) { status("Connection failed"); stop("error"); } });
      } catch (error) {
        if (requestStream && requestStream !== stream) requestStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
        status("Could not connect");
        window.toast?.(error?.message || "Could not start TruX Live.", "err");
        stop("error");
      }
    }

    const style = document.createElement("style");
    style.id = "trux-pwa-live-style";
    style.textContent =
      '#truxPwaLivePanel{position:fixed;right:16px;bottom:88px;z-index:9999;display:flex;flex-direction:column;width:min(420px,calc(100vw - 32px));max-height:min(62vh,540px);overflow:hidden;background:#151515;border:1px solid #3b3b3b;border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.42);color:#ededed}' +
      '#truxPwaLivePanel[hidden]{display:none!important}.trux-live-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:13px 14px;border-bottom:1px solid #343434}' +
      '#truxPwaLivePanel .trux-live-head b{font-size:14px;font-weight:600}#truxPwaLiveStatus{margin-top:4px;color:#999;font-size:12px}' +
      '#truxPwaLivePanel .trux-live-head button{border:1px solid #4a4a4a;border-radius:8px;padding:7px 12px;background:#222;color:#eee;font-size:12px}' +
      '#truxPwaLiveTranscript{min-height:70px;overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.45}' +
      '#truxPwaLivePanel .trux-live-line b{display:block;margin-bottom:3px;color:#aaa;font-size:11px;font-weight:600}#truxPwaLivePanel .trux-live-line div{white-space:pre-wrap;overflow-wrap:anywhere}' +
      '@media(max-width:640px){#truxPwaLivePanel{left:12px;right:12px;bottom:78px;width:auto;max-height:54vh}}';
    document.head.appendChild(style);

    const action = byId("actionBtn");
    if (action) {
      action.addEventListener("click", event => {
        if (action.classList.contains("stop")) return;
        const draft = byId("promptInput");
        const hasDraft = !!(draft?.value.trim() || action.classList.contains("ready"));
        if (!hasDraft) {
          event.preventDefault();
          event.stopImmediatePropagation();
          start();
        } else if (socket) {
          event.preventDefault();
          event.stopImmediatePropagation();
          window.toast?.("Stop TruX Live before sending a regular message.", "err");
        }
      }, true);
    }
    window.startTruxLiveAssistant = start;
    window.stopTruxLiveAssistant = () => stop("stopped");
    window.addEventListener("pagehide", () => stop("stopped"));
  }

  function run() {
    bindInstallButton();
    removeAndroidUi();
    bindDiagramRendering();
    installLiveUi();
    const observer = new MutationObserver(() => {
      bindInstallButton();
      removeAndroidUi();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
})();