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
    let panel = null;
    let socket = null;
    let audioStream = null;
    let videoStream = null;
    let videoKind = null;
    let audioContext = null;
    let sourceNode = null;
    let processor = null;
    let monitorGain = null;
    let playbackAt = 0;
    let connectTimer = null;
    let frameTimer = null;
    let frameBusy = false;
    let muted = false;
    let startToken = 0;
    let isStarting = false;
    const playback = new Set();
    const byId = id => document.getElementById(id);

    function ensurePanel() {
      panel = byId("truxPwaLivePanel");
      if (!panel) {
        panel = document.createElement("section");
        panel.id = "truxPwaLivePanel";
        panel.className = "trux-live-overlay";
        panel.hidden = true;
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-modal", "true");
        panel.setAttribute("aria-label", "TruX Live one-to-one conversation");
        panel.innerHTML =
          '<div class="trux-live-glow" aria-hidden="true"></div>' +
          '<header class="trux-live-topbar">' +
            '<button type="button" class="trux-live-top-button" id="truxPwaLiveMenuButton" aria-label="Live options" aria-expanded="false">' +
              '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>' +
            '</button>' +
            '<div class="trux-live-brand"><b>TruX Live</b><span>Private 1:1 conversation</span></div>' +
            '<button type="button" class="trux-live-top-button" id="truxPwaLiveTranscriptToggle" aria-label="Show transcript" aria-pressed="false" title="Transcript">' +
              '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4" width="17" height="16" rx="4"/><path d="M7.5 9h9M7.5 13h6"/></svg>' +
            '</button>' +
          '</header>' +
          '<nav class="trux-live-menu" id="truxPwaLiveMenu" hidden aria-label="Live options">' +
            '<button type="button" id="truxPwaLiveMenuCamera">Turn camera on</button>' +
            '<button type="button" id="truxPwaLiveMenuMic">Mute microphone</button>' +
            '<button type="button" id="truxPwaLiveMenuTranscript">Show transcript</button>' +
          '</nav>' +
          '<main class="trux-live-stage">' +
            '<h1 id="truxPwaLiveGreeting">Hi, let us get into it</h1>' +
            '<p id="truxPwaLiveStatus">Requesting microphone permission…</p>' +
            '<button type="button" id="truxPwaLiveRetry" class="trux-live-retry" hidden>Retry connection</button>' +
            '<div class="trux-live-camera-preview" id="truxPwaLivePreviewWrap" hidden>' +
              '<video id="truxPwaLivePreview" autoplay muted playsinline></video><span id="truxPwaLivePreviewLabel">Camera</span>' +
            '</div>' +
            '<div id="truxPwaLiveTranscript" class="trux-live-transcript" aria-live="polite" hidden></div>' +
          '</main>' +
          '<footer class="trux-live-controls">' +
            '<button type="button" class="trux-live-control" id="truxPwaLiveCamera" aria-label="Turn camera on" aria-pressed="false" title="Camera">' +
              '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="3"/><path d="m16 10 5-3v10l-5-3z"/></svg><span id="truxPwaLiveCameraLabel">Camera</span>' +
            '</button>' +
            '<button type="button" class="trux-live-control" id="truxPwaLiveScreen" aria-label="Share screen" aria-pressed="false" title="Share screen">' +
              '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2.5"/><path d="M8 21h8M12 17v4M12 13V7m-3 3 3-3 3 3"/></svg><span id="truxPwaLiveScreenLabel">Share</span>' +
            '</button>' +
            '<div class="trux-live-center-pill" aria-hidden="true"><div class="trux-live-voice-color"></div><span id="truxPwaLiveActivityText">Mic on</span></div>' +
            '<button type="button" class="trux-live-control" id="truxPwaLiveMic" aria-label="Mute microphone" aria-pressed="false" title="Microphone">' +
              '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7"/></svg><span id="truxPwaLiveMicLabel">Mic on</span>' +
            '</button>' +
            '<button type="button" class="trux-live-control trux-live-end" id="truxPwaLiveEnd" aria-label="End Live session" title="End Live session">' +
              '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg><span>End</span>' +
            '</button>' +
          '</footer>';
        document.body.appendChild(panel);

        const style = document.createElement("style");
        style.id = "trux-pwa-live-style";
        style.textContent =
          '#truxPwaLivePanel{position:fixed!important;inset:0!important;z-index:10050!important;display:flex;flex-direction:column;width:100vw;height:100vh;height:100dvh;max-width:none;max-height:none;margin:0;padding:calc(18px + env(safe-area-inset-top,0px)) 20px calc(18px + env(safe-area-inset-bottom,0px));overflow:hidden;border:0;border-radius:0;background:#000;color:#ededed;box-shadow:none;font-family:var(--font-body,Arial,sans-serif);isolation:isolate}' +
          '#truxPwaLivePanel[hidden],#truxPwaLivePanel [hidden]{display:none!important}' +
          '#truxPwaLivePanel .trux-live-glow{position:absolute;z-index:-1;pointer-events:none;inset:24% -30% -15%;background:radial-gradient(ellipse at 50% 100%,rgba(25,55,145,.84) 0%,rgba(18,35,93,.54) 36%,rgba(0,0,0,0) 72%)}' +
          '#truxPwaLivePanel .trux-live-topbar{position:relative;z-index:3;display:flex;align-items:center;gap:16px;min-height:52px;flex:0 0 auto}' +
          '#truxPwaLivePanel .trux-live-top-button{display:grid;place-items:center;width:46px;height:46px;flex:0 0 46px;border:0;border-radius:50%;background:transparent;color:#e7e7ec;cursor:pointer}' +
          '#truxPwaLivePanel .trux-live-top-button svg{width:25px;height:25px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}' +
          '#truxPwaLivePanel .trux-live-top-button:hover,#truxPwaLivePanel .trux-live-top-button[aria-pressed="true"]{background:rgba(255,255,255,.09)}' +
          '#truxPwaLivePanel .trux-live-brand{display:flex;flex:1;min-width:0;flex-direction:column;gap:3px}' +
          '#truxPwaLivePanel .trux-live-brand b{font-size:15px;font-weight:600;letter-spacing:.01em}' +
          '#truxPwaLivePanel .trux-live-brand span{font-size:11px;color:#a4a8ba}' +
          '#truxPwaLivePanel .trux-live-menu{position:absolute;z-index:5;top:calc(18px + env(safe-area-inset-top,0px) + 52px);left:20px;width:min(260px,calc(100vw - 40px));padding:8px;border:1px solid rgba(255,255,255,.12);border-radius:16px;background:rgba(22,23,31,.97);box-shadow:0 14px 50px rgba(0,0,0,.5);backdrop-filter:blur(18px)}' +
          '#truxPwaLivePanel .trux-live-menu button{display:block;width:100%;padding:12px 13px;border:0;border-radius:9px;background:transparent;color:#e9e9ef;text-align:left;font:inherit;font-size:13px;cursor:pointer}' +
          '#truxPwaLivePanel .trux-live-menu button:hover{background:rgba(255,255,255,.08)}' +
          '#truxPwaLivePanel .trux-live-stage{position:relative;display:flex;flex:1;min-height:0;flex-direction:column;align-items:center;justify-content:center;padding:18px 0 24px;text-align:center}' +
          '#truxPwaLivePanel .trux-live-stage h1{max-width:620px;margin:0 14px 10px;color:#eeeef4;font-size:clamp(28px,5.5vw,54px);font-weight:400;line-height:1.15;letter-spacing:-.035em}' +
          '#truxPwaLivePanel .trux-live-stage>p{max-width:min(540px,90vw);min-height:18px;margin:0;color:#a8adc1;font-size:13px;line-height:1.45;overflow-wrap:anywhere}' +
          '#truxPwaLivePanel .trux-live-retry{margin-top:20px;padding:11px 18px;border:1px solid rgba(205,215,255,.24);border-radius:999px;background:rgba(255,255,255,.08);color:#f5f5ff;font:inherit;font-size:13px;cursor:pointer}' +
          '#truxPwaLivePanel .trux-live-camera-preview{position:absolute;top:16px;right:4px;width:clamp(94px,22vw,164px);aspect-ratio:3/4;overflow:hidden;border:1px solid rgba(255,255,255,.25);border-radius:18px;background:#080a13;box-shadow:0 10px 32px rgba(0,0,0,.4)}' +
          '#truxPwaLivePanel .trux-live-camera-preview video{display:block;width:100%;height:100%;object-fit:cover}' +
          '#truxPwaLivePanel .trux-live-camera-preview span{position:absolute;left:8px;bottom:7px;padding:3px 6px;border-radius:6px;background:rgba(0,0,0,.45);color:#fff;font-size:10px}' +
          '#truxPwaLivePanel .trux-live-transcript{width:min(620px,100%);max-height:min(28vh,250px);margin-top:18px;padding:14px 16px;overflow:auto;border:1px solid rgba(255,255,255,.10);border-radius:16px;background:rgba(3,5,14,.48);text-align:left;backdrop-filter:blur(14px);font-size:13px;line-height:1.45}' +
          '#truxPwaLivePanel .trux-live-line{margin:0 0 12px;overflow-wrap:anywhere;white-space:pre-wrap}#truxPwaLivePanel .trux-live-line:last-child{margin-bottom:0}' +
          '#truxPwaLivePanel .trux-live-line b{display:block;margin-bottom:4px;color:#aebdfb;font-size:11px;font-weight:600}' +
          '#truxPwaLivePanel .trux-live-controls{position:relative;z-index:2;display:flex;flex:0 0 auto;align-items:center;justify-content:center;gap:clamp(6px,2.4vw,20px);padding:10px 0 4px}' +
          '#truxPwaLivePanel .trux-live-control{display:flex;flex:0 0 clamp(48px,6vw,66px);flex-direction:column;align-items:center;justify-content:center;gap:5px;width:clamp(48px,6vw,66px);height:clamp(58px,7vw,78px);padding:0;border:0;border-radius:999px;background:rgba(33,34,40,.96);color:#ededf3;cursor:pointer;transition:background .15s ease,transform .15s ease}' +
          '#truxPwaLivePanel .trux-live-control svg{width:25px;height:25px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}' +
          '#truxPwaLivePanel .trux-live-control span{font-size:10px;line-height:1;color:#c4c6d0}' +
          '#truxPwaLivePanel .trux-live-control:hover{background:#343644;transform:translateY(-1px)}' +
          '#truxPwaLivePanel .trux-live-control[aria-pressed="true"]{background:#3a4164;color:#fff}' +
          '#truxPwaLivePanel .trux-live-control.trux-live-end{background:#242428;color:#f5dfe2}' +
          '#truxPwaLivePanel .trux-live-control.trux-live-end:hover{background:#632e3a}' +
          '#truxPwaLivePanel .trux-live-center-pill{display:flex;flex:0 1 210px;min-width:88px;max-width:210px;height:76px;align-items:center;justify-content:center;flex-direction:column;gap:7px;overflow:hidden;border:1px solid rgba(203,216,255,.10);border-radius:999px;background:linear-gradient(180deg,#020307 0%,#050917 48%,#263868 77%,#dde6ff 100%);box-shadow:0 9px 28px rgba(4,10,38,.35),inset 0 1px 8px rgba(255,255,255,.05);color:#e8ecff}' +
          '#truxPwaLivePanel .trux-live-center-pill span{font-size:10px;line-height:1;color:#d8def3}' +
          '#truxPwaLivePanel .trux-live-center-pill{position:relative;background:#03050c!important}' +
          '#truxPwaLivePanel .trux-live-voice-color{position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:var(--trux-live-level,0);background:radial-gradient(ellipse at var(--trux-live-tone,50%) 110%,rgba(74,118,255,.96) 0%,rgba(41,75,190,.74) 36%,rgba(6,12,38,0) 76%);transition:opacity .08s linear,background .08s linear}' +
          '#truxPwaLivePanel .trux-live-center-pill span{position:relative;z-index:1}' +
          '#truxPwaLivePanel .trux-live-stage h1:empty{display:none!important}' +
          '#truxPwaLivePanel.trux-live-heard-user .trux-live-stage h1,#truxPwaLivePanel.trux-live-heard-user .trux-live-stage>p{display:none!important}' +
          '@media(max-width:480px){#truxPwaLivePanel{padding-left:12px;padding-right:12px}#truxPwaLivePanel .trux-live-topbar{gap:10px}#truxPwaLivePanel .trux-live-top-button{width:42px;height:42px;flex-basis:42px}#truxPwaLivePanel .trux-live-brand b{font-size:14px}#truxPwaLivePanel .trux-live-brand span{font-size:10px}#truxPwaLivePanel .trux-live-stage h1{font-size:clamp(28px,8vw,42px)}#truxPwaLivePanel .trux-live-controls{gap:5px}#truxPwaLivePanel .trux-live-control{flex-basis:clamp(44px,12vw,58px);width:clamp(44px,12vw,58px);height:62px}#truxPwaLivePanel .trux-live-control svg{width:23px;height:23px}#truxPwaLivePanel .trux-live-control span{font-size:9px}#truxPwaLivePanel .trux-live-center-pill{flex:1 1 92px;min-width:72px;height:70px}#truxPwaLivePanel .trux-live-camera-preview{top:0;right:0;width:clamp(78px,21vw,110px);border-radius:12px}#truxPwaLivePanel .trux-live-transcript{max-height:24vh;padding:10px 12px}}' +
          '@media(prefers-reduced-motion:reduce){#truxPwaLivePanel *,#truxPwaLivePanel *:before{animation:none!important;transition:none!important}}';
        document.head.appendChild(style);

        byId("truxPwaLiveEnd").addEventListener("click", () => stop("stopped"));
        byId("truxPwaLiveMenuButton").addEventListener("click", () => {
          const menu = byId("truxPwaLiveMenu");
          menu.hidden = !menu.hidden;
          byId("truxPwaLiveMenuButton").setAttribute("aria-expanded", String(!menu.hidden));
        });
        byId("truxPwaLiveTranscriptToggle").addEventListener("click", toggleTranscript);
        byId("truxPwaLiveMenuTranscript").addEventListener("click", () => { toggleTranscript(); closeMenu(); });
        byId("truxPwaLiveMenuCamera").addEventListener("click", () => { toggleVideo("camera"); closeMenu(); });
        byId("truxPwaLiveMenuMic").addEventListener("click", () => { toggleMic(); closeMenu(); });
        byId("truxPwaLiveCamera").addEventListener("click", () => toggleVideo("camera"));
        byId("truxPwaLiveScreen").addEventListener("click", () => toggleVideo("screen"));
        byId("truxPwaLiveMic").addEventListener("click", toggleMic);
        byId("truxPwaLiveRetry").addEventListener("click", start);
        panel.addEventListener("click", event => {
          const menu = byId("truxPwaLiveMenu");
          const button = byId("truxPwaLiveMenuButton");
          if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) closeMenu();
        });
      }
      panel.hidden = false;
      panel.setAttribute("aria-modal", "true");
      return panel;
    }

    function closeMenu() {
      const menu = byId("truxPwaLiveMenu");
      if (menu) menu.hidden = true;
      byId("truxPwaLiveMenuButton")?.setAttribute("aria-expanded", "false");
    }

    function setStatus(value) {
      const statusEl = byId("truxPwaLiveStatus");
      const activity = byId("truxPwaLiveActivityText");
      if (statusEl) statusEl.textContent = value;
      if (activity) activity.textContent = value.toLowerCase().includes("connect") ? "Connecting" :
        value.toLowerCase().includes("error") || value.toLowerCase().includes("failed") ? "Retry needed" :
        value.toLowerCase().includes("muted") ? "Mic muted" : "Listening";
    }

    function toggleTranscript() {
      const transcriptEl = byId("truxPwaLiveTranscript");
      if (!transcriptEl) return;
      transcriptEl.hidden = !transcriptEl.hidden;
      const visible = !transcriptEl.hidden;
      byId("truxPwaLiveTranscriptToggle").setAttribute("aria-pressed", String(visible));
      byId("truxPwaLiveTranscriptToggle").setAttribute("aria-label", visible ? "Hide transcript" : "Show transcript");
      byId("truxPwaLiveMenuTranscript").textContent = visible ? "Hide transcript" : "Show transcript";
      if (visible) transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }

    function syncMenuLabels() {
      if (!byId("truxPwaLiveCamera")) return;
      const isCamera = videoKind === "camera";
      const isScreen = videoKind === "screen";
      byId("truxPwaLiveCamera").setAttribute("aria-pressed", String(isCamera));
      byId("truxPwaLiveCamera").setAttribute("aria-label", isCamera ? "Turn camera off" : "Turn camera on");
      byId("truxPwaLiveCameraLabel").textContent = isCamera ? "Camera on" : "Camera";
      byId("truxPwaLiveScreen").setAttribute("aria-pressed", String(isScreen));
      byId("truxPwaLiveScreen").setAttribute("aria-label", isScreen ? "Stop screen sharing" : "Share screen");
      byId("truxPwaLiveScreenLabel").textContent = isScreen ? "Sharing" : "Share";
      byId("truxPwaLiveMic").setAttribute("aria-pressed", String(muted));
      byId("truxPwaLiveMic").setAttribute("aria-label", muted ? "Unmute microphone" : "Mute microphone");
      byId("truxPwaLiveMicLabel").textContent = muted ? "Mic muted" : "Mic on";
      byId("truxPwaLiveMenuCamera").textContent = isCamera ? "Turn camera off" : "Turn camera on";
      byId("truxPwaLiveMenuMic").textContent = muted ? "Unmute microphone" : "Mute microphone";
    }

    function transcript(role, text) {
      const value = String(text || "").trim();
      if (!value) return;
      if (role === "user") {
        const greeting = byId("truxPwaLiveGreeting");
        if (greeting) greeting.textContent = "";
        panel?.classList.add("trux-live-heard-user");
      }
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
      if (!el.hidden) el.scrollTop = el.scrollHeight;
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
      if (!audioContext || !audioStream) throw new Error("Microphone stream is not ready.");
      const src = audioContext.createMediaStreamSource(audioStream);
      const proc = audioContext.createScriptProcessor(2048, 1, 1);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = .72;
      const frequencyData = new Uint8Array(analyser.frequencyBinCount);
      const gain = audioContext.createGain();
      gain.gain.value = 0;
      proc.onaudioprocess = event => {
        if (socket !== forSocket || forSocket.readyState !== WebSocket.OPEN) return;
        const samples = event.inputBuffer.getChannelData(0);
        let power = 0;
        for (let i = 0; i < samples.length; i++) power += samples[i] * samples[i];
        const rms = Math.sqrt(power / Math.max(1, samples.length));
        const voiceActive = !muted && rms >= .014;
        const level = voiceActive ? Math.min(.92, rms * 5.5) : 0;
        let tone = 50;
        if (voiceActive) {
          analyser.getByteFrequencyData(frequencyData);
          const maxBin = Math.min(24, frequencyData.length - 1);
          let magnitude = 0;
          let weightedFrequency = 0;
          for (let i = 1; i <= maxBin; i++) {
            magnitude += frequencyData[i];
            weightedFrequency += i * frequencyData[i];
          }
          if (magnitude > 0 && maxBin > 1) {
            const centroid = weightedFrequency / magnitude;
            tone = Math.max(0, Math.min(100, ((centroid - 1) / (maxBin - 1)) * 100));
          }
          const greeting = byId("truxPwaLiveGreeting");
          if (greeting) greeting.textContent = "";
          panel?.classList.add("trux-live-heard-user");
        }
        panel?.style.setProperty("--trux-live-level", level.toFixed(3));
        panel?.style.setProperty("--trux-live-tone", tone.toFixed(1) + "%");
        panel?.classList.toggle("trux-live-user-speaking", voiceActive);
        if (muted || forSocket.bufferedAmount > 1048576) return;
        const data = pcmBase64(samples, audioContext.sampleRate);
        if (data) {
          try { forSocket.send(JSON.stringify({ type: "audio", data })); } catch {}
        }
      };
      src.connect(proc);
      src.connect(analyser);
      analyser.connect(gain);
      proc.connect(gain);
      gain.connect(audioContext.destination);
      sourceNode = src;
      processor = proc;
      monitorGain = gain;
    }

    function playAudio(packet) {
      if (!audioContext || !packet?.data) return;
      try {
        const binary = atob(packet.data);
        const len = Math.floor(binary.length / 2);
        if (!len) return;
        const samples = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          let value = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
          if (value >= 32768) value -= 65536;
          samples[i] = value / 32768;
        }
        const match = String(packet.mimeType || "").match(/rate=(\d+)/i);
        const rate = match ? Number(match[1]) || 24000 : 24000;
        const buffer = audioContext.createBuffer(1, len, rate);
        buffer.copyToChannel(samples, 0);
        const node = audioContext.createBufferSource();
        node.buffer = buffer;
        node.connect(audioContext.destination);
        node.onended = () => {
          playback.delete(node);
          try { node.disconnect(); } catch {}
          if (!playback.size) panel?.classList.remove("trux-live-assistant-speaking");
        };
        const startAt = Math.max(audioContext.currentTime + .02, playbackAt);
        node.start(startAt);
        playbackAt = startAt + buffer.duration;
        playback.add(node);
        panel?.classList.add("trux-live-assistant-speaking");
      } catch (error) {
        console.warn("TruX Live audio playback failed", error);
      }
    }

    function stopVideoSharing() {
      if (frameTimer) clearInterval(frameTimer);
      frameTimer = null;
      frameBusy = false;
      if (videoStream) videoStream.getTracks().forEach(track => { try { track.stop(); } catch {} });
      videoStream = null;
      videoKind = null;
      const preview = byId("truxPwaLivePreview");
      if (preview) preview.srcObject = null;
      const wrap = byId("truxPwaLivePreviewWrap");
      if (wrap) wrap.hidden = true;
      panel?.classList.remove("trux-live-camera-active");
      if (byId("truxPwaLiveCamera")) syncMenuLabels();
    }

    function sendVideoFrame() {
      if (frameBusy || !videoStream || !socket || socket.readyState !== WebSocket.OPEN ||
          window.__truxLiveState !== "live" || socket.bufferedAmount > 1000000) return;
      const video = byId("truxPwaLivePreview");
      if (!video || !video.videoWidth || !video.videoHeight) return;
      frameBusy = true;
      try {
        const canvas = document.createElement("canvas");
        const ratio = Math.min(1, 768 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.max(1, Math.round(video.videoWidth * ratio));
        canvas.height = Math.max(1, Math.round(video.videoHeight * ratio));
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const data = canvas.toDataURL("image/jpeg", .68).split(",")[1];
        if (data) socket.send(JSON.stringify({ type: "video", data }));
      } catch (error) {
        console.warn("TruX Live could not send a video frame", error);
      } finally {
        frameBusy = false;
      }
    }

    async function toggleVideo(kind) {
      if (videoStream && videoKind === kind) {
        stopVideoSharing();
        setStatus(window.__truxLiveState === "live" ? "Live and connected" : "Connecting to Gemini Live…");
        return;
      }
      if (!navigator.mediaDevices) {
        window.toast?.("Camera and screen sharing are not available in this browser.", "err");
        return;
      }
      if (!["live", "connecting"].includes(window.__truxLiveState)) {
        window.toast?.("Connect Live first, then enable the camera.", "err");
        return;
      }
      stopVideoSharing();
      try {
        let nextStream;
        if (kind === "screen") {
          if (!navigator.mediaDevices.getDisplayMedia) {
            window.toast?.("Screen sharing is not supported by this browser. Use the camera instead.", "err");
            return;
          }
          nextStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 1, max: 5 } }, audio: false });
        } else {
          nextStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 5, max: 10 } },
            audio: false
          });
        }
        if (!["live", "connecting"].includes(window.__truxLiveState)) {
          nextStream.getTracks().forEach(track => { try { track.stop(); } catch {} });
          return;
        }
        videoStream = nextStream;
        videoKind = kind;
        const preview = byId("truxPwaLivePreview");
        preview.srcObject = videoStream;
        byId("truxPwaLivePreviewLabel").textContent = kind === "screen" ? "Screen share" : "Camera";
        byId("truxPwaLivePreviewWrap").hidden = false;
        await preview.play().catch(() => {});
        panel?.classList.add("trux-live-camera-active");
        const videoTrack = videoStream.getVideoTracks()[0];
        if (videoTrack) videoTrack.addEventListener("ended", () => {
          if (videoStream && videoStream.getVideoTracks().includes(videoTrack)) stopVideoSharing();
        }, { once: true });
        frameTimer = setInterval(sendVideoFrame, 1000);
        syncMenuLabels();
      } catch (error) {
        window.toast?.((kind === "screen" ? "Screen sharing could not start: " : "Camera could not start: ") + String(error?.message || "permission was not granted."), "err");
      }
    }

    function toggleMic() {
      muted = !muted;
      if (audioStream) audioStream.getAudioTracks().forEach(track => { track.enabled = !muted; });
      if (muted) {
        panel?.classList.remove("trux-live-user-speaking");
        panel?.style.setProperty("--trux-live-level", "0");
        setStatus("Microphone muted");
      } else {
        setStatus(window.__truxLiveState === "live" ? "Live and connected" : "Connecting to Gemini Live…");
      }
      syncMenuLabels();
    }

    function stop(nextState, detail) {
      startToken++;
      isStarting = false;
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = null;
      const oldSocket = socket;
      socket = null;
      if (oldSocket) {
        if (oldSocket.readyState === WebSocket.OPEN) {
          try { oldSocket.send(JSON.stringify({ type: "stop" })); } catch {}
        }
        try { oldSocket.close(1000, nextState === "stopped" ? "User closed Live" : "Live cleanup"); } catch {}
      }
      try { if (processor) { processor.onaudioprocess = null; processor.disconnect(); } } catch {}
      try { sourceNode?.disconnect(); } catch {}
      try { monitorGain?.disconnect(); } catch {}
      processor = null;
      sourceNode = null;
      monitorGain = null;
      if (audioStream) audioStream.getTracks().forEach(track => { try { track.stop(); } catch {} });
      audioStream = null;
      stopVideoSharing();
      for (const node of playback) { try { node.stop(); } catch {} }
      playback.clear();
      playbackAt = 0;
      panel?.classList.remove("trux-live-connected", "trux-live-user-speaking", "trux-live-assistant-speaking", "trux-live-heard-user");
      panel?.style.setProperty("--trux-live-level", "0");
      panel?.style.setProperty("--trux-live-tone", "50%");
      const oldContext = audioContext;
      audioContext = null;
      if (oldContext && oldContext.state !== "closed") oldContext.close().catch(() => {});
      muted = false;
      window.__truxLiveState = nextState || "stopped";
      if (panel) {
        panel.hidden = nextState === "stopped";
        panel.dataset.state = nextState || "stopped";
      }
      if (nextState === "error") {
        const message = String(detail || "The Live connection was interrupted. Retry or close the session.");
        const greeting = byId("truxPwaLiveGreeting");
        if (greeting) greeting.textContent = "Connection interrupted";
        setStatus(message);
        if (byId("truxPwaLiveRetry")) byId("truxPwaLiveRetry").hidden = false;
        window.toast?.(message, "err");
      } else if (nextState === "stopped") {
        setStatus("Live session closed");
        if (byId("truxPwaLiveRetry")) byId("truxPwaLiveRetry").hidden = true;
      }
      syncMenuLabels();
      if (typeof window.handleInputChange === "function") window.handleInputChange();
    }

    function fail(message, ws) {
      if (ws && socket !== ws) return;
      stop("error", message);
    }

    async function start() {
      if (window.__truxLiveState === "live" || window.__truxLiveState === "connecting") {
        ensurePanel();
        return;
      }
      const auth = window.auth || window.firebase?.auth?.();
      const user = auth?.currentUser;
      if (!user) {
        window.openLoginWall?.();
        window.toast?.("Sign in to use TruX Live.", "err");
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        window.toast?.("Microphone access is not available in this browser.", "err");
        return;
      }

      ensurePanel();
      closeMenu();
      if (window.__truxLiveState !== "error") byId("truxPwaLiveTranscript").replaceChildren();
      byId("truxPwaLiveRetry").hidden = true;
      byId("truxPwaLiveGreeting").textContent = "Hi, let us get into it";
      panel.dataset.state = "connecting";
      panel.classList.remove("trux-live-connected", "trux-live-user-speaking", "trux-live-assistant-speaking", "trux-live-heard-user");
      panel.style.setProperty("--trux-live-level", "0");
      panel.style.setProperty("--trux-live-tone", "50%");
      setStatus("Requesting microphone permission…");
      window.__truxLiveState = "connecting";
      isStarting = true;
      const token = ++startToken;
      let requestStream = null;
      try {
        const Context = window.AudioContext || window.webkitAudioContext;
        if (!Context) throw new Error("Web Audio is not available in this browser.");
        audioContext = new Context();
        await audioContext.resume();
        requestStream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false
        });
        if (token !== startToken || window.__truxLiveState !== "connecting") {
          requestStream.getTracks().forEach(track => { try { track.stop(); } catch {} });
          return;
        }
        audioStream = requestStream;
        const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/live";
        const ws = new WebSocket(url);
        socket = ws;
        setStatus("Opening secure Live connection…");
        connectTimer = setTimeout(() => {
          if (socket === ws && window.__truxLiveState === "connecting") fail("Gemini Live did not finish connecting in time. Check the connection and retry.", ws);
        }, 30000);

        ws.addEventListener("open", async () => {
          try {
            const currentUser = (window.auth || window.firebase?.auth?.())?.currentUser;
            if (!currentUser) throw new Error("Sign in again to use Live.");
            const idToken = await currentUser.getIdToken();
            if (socket === ws && ws.readyState === WebSocket.OPEN && idToken) {
              ws.send(JSON.stringify({ type: "auth", token: idToken }));
            } else if (socket === ws && !idToken) {
              throw new Error("Firebase did not provide a sign-in token.");
            }
          } catch (error) {
            if (socket === ws) fail(String(error?.message || "Live authentication failed."), ws);
          }
        });

        ws.addEventListener("message", event => {
          if (socket !== ws) return;
          let packet;
          try { packet = JSON.parse(String(event.data || "{}")); } catch { return; }
          if (packet.type === "connecting") {
            setStatus("Connecting to Gemini Live…");
          } else if (packet.type === "ready") {
            try {
              if (connectTimer) clearTimeout(connectTimer);
              connectTimer = null;
              startMic(ws);
              isStarting = false;
              window.__truxLiveState = "live";
              panel.dataset.state = "live";
              panel.classList.add("trux-live-connected");
              byId("truxPwaLiveGreeting").textContent = "I am here. Start speaking.";
              byId("truxPwaLiveRetry").hidden = true;
              setStatus("Live and connected");
              syncMenuLabels();
              if (typeof window.handleInputChange === "function") window.handleInputChange();
            } catch (error) {
              fail(String(error?.message || "Could not start the microphone stream."), ws);
            }
          } else if (packet.type === "audio") {
            playAudio(packet);
          } else if (packet.type === "transcript") {
            transcript(packet.role, packet.text);
          } else if (packet.type === "interrupted") {
            for (const node of playback) { try { node.stop(); } catch {} }
            playback.clear();
            playbackAt = audioContext?.currentTime || 0;
            panel?.classList.remove("trux-live-assistant-speaking");
          } else if (packet.type === "error") {
            fail(String(packet.message || "Gemini Live could not connect."), ws);
          } else if (packet.type === "ended") {
            fail(String(packet.reason || "Gemini Live ended the connection unexpectedly. Retry or close the session."), ws);
          }
        });

        ws.addEventListener("close", event => {
          if (socket === ws) fail("Live connection closed unexpectedly (" + (event.code || "no code") + "). Retry or close the session.", ws);
        });
        ws.addEventListener("error", () => {
          if (socket === ws) fail("The Live WebSocket failed. Check network access and retry.", ws);
        });
      } catch (error) {
        if (requestStream && requestStream !== audioStream) requestStream.getTracks().forEach(track => { try { track.stop(); } catch {} });
        if (token !== startToken) return;
        fail(String(error?.message || "Could not start TruX Live."));
      } finally {
        if (token === startToken) isStarting = false;
      }
    }

    const action = byId("actionBtn");
    if (action && action.dataset.truxLiveBound !== "true") {
      action.dataset.truxLiveBound = "true";
      action.addEventListener("click", event => {
        if (action.classList.contains("stop")) return;
        const draft = byId("promptInput");
        const hasDraft = !!(draft?.value.trim() || action.classList.contains("ready"));
        const active = window.__truxLiveState === "live" || window.__truxLiveState === "connecting";
        if (active && hasDraft) {
          event.preventDefault();
          event.stopImmediatePropagation();
          window.toast?.("Close the Live session with the X button before sending a regular chat message.", "err");
          return;
        }
        if (hasDraft) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (active) {
          ensurePanel();
          return;
        }
        start();
      }, true);
    }
    window.startTruxLiveAssistant = start;
    window.stopTruxLiveAssistant = () => stop("stopped");
    window.addEventListener("pagehide", () => stop("stopped"), { once: true });
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