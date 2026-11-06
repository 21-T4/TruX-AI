/* Circle to search.
 * 1. Grab one frame of the screen (getDisplayMedia on computers; on phones,
 *    where browsers can't capture the screen, pick a screenshot instead).
 * 2. Freeze it full screen with a glowing Gemini-style border.
 * 3. The user circles (lasso) or taps something; the outside dims and the
 *    selection gets corner brackets.
 * 4. A bar slides up from the bottom: thumbnail + "Ask about this…" + mic.
 *    Sending attaches the cropped picture and text to the chat and sends it.
 */
window.truxCircle = (() => {
  "use strict";
  let root = null, shot = null, points = [], drawing = false, box = null, recog = null;
  const $ = sel => root?.querySelector(sel);

  async function captureBrowserFrame() {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("unsupported");
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1, displaySurface: "monitor" }, audio: false, preferCurrentTab: false, selfBrowserSurface: "include" });
    try {
      const video = document.createElement("video");
      video.muted = true; video.playsInline = true; video.srcObject = stream;
      await video.play();
      await new Promise(r => setTimeout(r, 350));
      const c = document.createElement("canvas");
      c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext("2d").drawImage(video, 0, 0);
      return c.toDataURL("image/jpeg", 0.92);
    } finally { stream.getTracks().forEach(t => t.stop()); }
  }

  async function start() {
    if (root) return;
    if (!auth?.currentUser) { openLoginWall("signin"); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) { pickScreenshot(); return; }
    let dataUrl;
    try { dataUrl = await captureBrowserFrame(); }
    catch (error) { if (error?.name !== "NotAllowedError") toast("Couldn't capture the screen.", "err"); return; }
    open(dataUrl);
  }

  function pickScreenshot() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => open(String(reader.result));
      reader.readAsDataURL(file);
    };
    toast("Pick a screenshot, then circle what you want to search.", "ok");
    input.click();
  }

  function open(dataUrl, presetText = "") {
    close();
    shot = new Image();
    shot.onload = () => layout();
    shot.src = dataUrl;
    root = document.createElement("div");
    root.className = "trux-circle";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Circle to search");
    root.innerHTML = `
      <div class="tc-stage"><img class="tc-shot" alt="Your screen"><canvas class="tc-ink"></canvas></div>
      <div class="tc-glow" aria-hidden="true"></div>
      <div class="tc-top"><button type="button" class="tc-x" aria-label="Close">×</button><span class="tc-hint">Circle or tap anything to search</span></div>
      <form class="tc-bar" autocomplete="off">
        <img class="tc-thumb" alt="" hidden>
        <input class="tc-input" type="text" placeholder="Ask about your screen…" aria-label="Ask about this">
        <button type="button" class="tc-mic" aria-label="Speak your question"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>
        <button type="submit" class="tc-send" aria-label="Search"><svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6"/></svg></button>
      </form>`;
    document.body.appendChild(root);
    $(".tc-shot").src = dataUrl;
    $(".tc-input").value = presetText;
    $(".tc-x").onclick = close;
    $(".tc-mic").onclick = dictate;
    $(".tc-bar").onsubmit = e => { e.preventDefault(); submit(); };
    const ink = $(".tc-ink");
    ink.addEventListener("pointerdown", down);
    ink.addEventListener("pointermove", move);
    ink.addEventListener("pointerup", up);
    ink.addEventListener("pointercancel", up);
    window.addEventListener("resize", layout);
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => root?.classList.add("open"));
    if (navigator.vibrate) navigator.vibrate(12);
  }

  function onKey(e) { if (e.key === "Escape") close(); }

  // Image is shown with object-fit: contain; this maps screen → image pixels.
  function fit() {
    const img = $(".tc-shot"); if (!img || !shot?.naturalWidth) return null;
    const r = img.getBoundingClientRect();
    const s = Math.min(r.width / shot.naturalWidth, r.height / shot.naturalHeight);
    const w = shot.naturalWidth * s, h = shot.naturalHeight * s;
    return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, s };
  }

  function layout() {
    const ink = $(".tc-ink"); if (!ink) return;
    const dpr = window.devicePixelRatio || 1;
    ink.width = innerWidth * dpr; ink.height = innerHeight * dpr;
    ink.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
    paint();
  }

  function down(e) {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drawing = true; points = [[e.clientX, e.clientY]]; box = null;
    root.classList.remove("selected");
    paint();
  }
  function move(e) {
    if (!drawing) return;
    const last = points[points.length - 1];
    if (Math.hypot(e.clientX - last[0], e.clientY - last[1]) > 2) { points.push([e.clientX, e.clientY]); paint(); }
  }
  function up() {
    if (!drawing) return;
    drawing = false;
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (x1 - x0 < 24 && y1 - y0 < 24) {
      // A tap selects a generous box around the point.
      const half = Math.min(innerWidth, innerHeight) * 0.18;
      x0 = points[0][0] - half; x1 = points[0][0] + half; y0 = points[0][1] - half * 0.7; y1 = points[0][1] + half * 0.7;
      points = [];
    }
    const pad = 10;
    box = { x0: Math.max(0, x0 - pad), y0: Math.max(0, y0 - pad), x1: Math.min(innerWidth, x1 + pad), y1: Math.min(innerHeight, y1 + pad) };
    root.classList.add("selected");
    $(".tc-hint").textContent = "Ask anything, or circle again";
    paint();
    const thumb = $(".tc-thumb"); const crop = cropDataUrl(360);
    if (thumb && crop) { thumb.src = crop; thumb.hidden = false; }
    $(".tc-input").placeholder = "Ask about this…";
    if (navigator.vibrate) navigator.vibrate(8);
    if (matchMedia("(hover: hover)").matches) $(".tc-input").focus();
  }

  function paint() {
    const ink = $(".tc-ink"); if (!ink) return;
    const g = ink.getContext("2d");
    g.clearRect(0, 0, innerWidth, innerHeight);
    if (box && !drawing) {
      g.fillStyle = "rgba(4,6,14,.55)";
      g.fillRect(0, 0, innerWidth, innerHeight);
      g.clearRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
      brackets(g, box);
    }
    if (points.length > 1) {
      const grad = g.createLinearGradient(0, 0, innerWidth, innerHeight);
      grad.addColorStop(0, "#4f8cff"); grad.addColorStop(.4, "#9b6bff"); grad.addColorStop(.7, "#ff5fa2"); grad.addColorStop(1, "#ffb347");
      g.lineCap = "round"; g.lineJoin = "round";
      g.shadowColor = "rgba(150,120,255,.9)"; g.shadowBlur = 18;
      g.strokeStyle = grad; g.lineWidth = drawing ? 7 : 5;
      g.globalAlpha = drawing ? 1 : .85;
      g.beginPath(); g.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) {
        const [x, y] = points[i], [px, py] = points[i - 1];
        g.quadraticCurveTo(px, py, (x + px) / 2, (y + py) / 2);
      }
      g.stroke();
      g.shadowBlur = 0; g.globalAlpha = 1;
      g.strokeStyle = "rgba(255,255,255,.85)"; g.lineWidth = 1.5; g.stroke();
    }
  }

  function brackets(g, b) {
    const len = Math.min(28, (b.x1 - b.x0) / 3, (b.y1 - b.y0) / 3);
    g.strokeStyle = "#fff"; g.lineWidth = 4; g.lineCap = "round";
    g.shadowColor = "rgba(120,140,255,.9)"; g.shadowBlur = 12;
    const c = [[b.x0, b.y0, 1, 1], [b.x1, b.y0, -1, 1], [b.x0, b.y1, 1, -1], [b.x1, b.y1, -1, -1]];
    for (const [x, y, dx, dy] of c) {
      g.beginPath(); g.moveTo(x, y + dy * len); g.lineTo(x, y); g.lineTo(x + dx * len, y); g.stroke();
    }
    g.shadowBlur = 0;
  }

  function cropDataUrl(maxSide = 1600) {
    const f = fit(); if (!f || !shot) return null;
    const b = box || { x0: f.x, y0: f.y, x1: f.x + shot.naturalWidth * f.s, y1: f.y + shot.naturalHeight * f.s };
    const sx = Math.max(0, (b.x0 - f.x) / f.s), sy = Math.max(0, (b.y0 - f.y) / f.s);
    const sw = Math.min(shot.naturalWidth - sx, (b.x1 - b.x0) / f.s), sh = Math.min(shot.naturalHeight - sy, (b.y1 - b.y0) / f.s);
    if (sw < 4 || sh < 4) return null;
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const c = document.createElement("canvas");
    c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
    c.getContext("2d").drawImage(shot, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.9);
  }

  function dictate() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast("Voice input isn't supported in this browser.", "err"); return; }
    if (recog) { try { recog.stop(); } catch {} return; }
    recog = new SR();
    recog.lang = navigator.language || "en-US"; recog.interimResults = true;
    const mic = $(".tc-mic"); mic?.classList.add("on");
    try { window.truxWake?.pause("circle"); } catch {}
    recog.onresult = e => { let t = ""; for (const r of e.results) t += r[0].transcript; const input = $(".tc-input"); if (input) input.value = t; };
    recog.onend = () => {
      mic?.classList.remove("on"); recog = null;
      try { window.truxWake?.resume("circle"); } catch {}
      if ($(".tc-input")?.value.trim()) submit();
    };
    try { recog.start(); } catch { recog = null; mic?.classList.remove("on"); }
  }

  function submit() {
    const crop = cropDataUrl();
    if (!crop) { toast("Circle something first.", "err"); return; }
    const text = $(".tc-input")?.value.trim() || "What is this? Search it and tell me what matters.";
    close();
    attachAndSend(crop, text);
  }

  function attachAndSend(dataUrl, text) {
    try {
      selectedImageBase64 = dataUrl;
      const prev = getEl("imagePreview"); if (prev) prev.src = dataUrl;
      getEl("imagePreviewContainer")?.classList.add("visible");
      updateComposerAttachments?.();
    } catch {}
    const input = getEl("promptInput");
    if (input) input.value = text;
    try { handleInputChange?.(); } catch {}
    setTimeout(() => { try { sendPrompt(); } catch (e) { toast("Couldn't send. Tap send to try again.", "err"); } }, 30);
  }

  function close() {
    try { recog?.abort(); } catch {}
    recog = null;
    window.removeEventListener("resize", layout);
    document.removeEventListener("keydown", onKey);
    const el = root; root = null; shot = null; points = []; box = null; drawing = false;
    if (!el) return;
    el.classList.remove("open");
    el.classList.add("closing");
    setTimeout(() => el.remove(), 260);
  }

  return { start, open, close, attachAndSend };
})();
