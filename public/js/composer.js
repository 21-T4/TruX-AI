/* Incognito, new chat, attachments, uploads and voice dictation. */

function launchIncognitoChat() {
  /* Incognito is a memory-only Chat workspace.
     It stays in memory only and is removed on exit. */
  if (isGenerating || activeTurnContext) detachActiveTurn();

  incognitoMode = true;
  workspaceMode = "chat";
  currentChatId = "incognito_" + Date.now() + "_" + Math.random().toString(36).slice(2);

  // Keep this turn completely outside persistent chat state.
  chatSessions[currentChatId] = {
    title: "Incognito",
    mode: "chat",
    incognito: true,
    messages: []
  };

  activeAbortController = null;
  activeStreamer = null;
  isGenerating = false;
  activeTurnContext = null;
  generationStopRequested = false;
  pastedTextBlocks = [];
  fileAttachments = [];
  selectedImageBase64 = null;

  closeSidebar();
  closeAttachmentMenu();
  closeModelDropdown();

  document.body.classList.remove("plugins-page-active","home-active");
  document.body.classList.add("chat-session-active","incognito-mode");
  document.body.dataset.workspaceMode = "chat";
  document.body.removeAttribute("data-media-mode");
  handleInputChange();

  const chat = getEl("chatContainer");
  if (chat) { chat.innerHTML = ""; chat.style.display = "block"; }
  getEl("welcomeScreen")?.style.setProperty("display","none","important");

  const input = getEl("promptInput");
  if (input) {
    input.value = "";
    input.placeholder = "Ask privately…";
  }

  const incognitoNotice = document.createElement("div");
  incognitoNotice.className = "incognito-session-banner";
  incognitoNotice.innerHTML = "<span class=\"incognito-session-dot\"></span><span><b>Incognito</b><small>This chat stays in memory only and is not saved to history.</small></span>";
  chat.appendChild(incognitoNotice);
  chat.scrollTop = chat.scrollHeight;

  renderFileChips();
  handleInputChange();
  renderSidebar();
}

function closeIncognitoChat() {
  const input = getEl("promptInput");
  if (input) {
    input.value = "";
    input.placeholder = "Message TruX…";
  }
  startNewChat();
}

function startNewChat() {
  if(currentChatId && chatSessions[currentChatId]?.incognito) delete chatSessions[currentChatId];
  const user = auth?.currentUser;
  if(user) {


  }
  incognitoMode = false;
  document.body.classList.remove("plugins-page-active","incognito-mode","notebook-open");
  closeSidebar();
  closeAttachmentMenu();
  closeModelDropdown();

  // Reset the active Chat workspace and restore the normal home UI.
  setWorkspaceMode("chat", {reload:false,preserveSession:false,forceReset:true});

  isScrolledUp = false;
  getEl("scrollDownBtn")?.classList.remove("visible");
  document.body.classList.remove("scrolled");
}
function quickPrompt(txt) { getEl("promptInput").value = txt; getEl("promptInput").focus(); handleInputChange(); }

function handleInputChange() {
  const p = getEl("promptInput");
  if (!p) return;
  const minComposerHeight = 44;
  const maxComposerHeight = 200
  p.style.setProperty("height", "auto", "important");
  const contentHeight = p.scrollHeight;
  p.style.setProperty("height", Math.max(minComposerHeight, Math.min(contentHeight, maxComposerHeight)) + "px", "important");
  p.style.removeProperty("overflow-y");
  const bar = p.closest(".bar");
  if (bar) bar.classList.remove("multiline");

  const btn = getEl("actionBtn");
  const hasDraft = !!(p.value.trim() || selectedImageBase64 || pastedTextBlocks.length || fileAttachments.length);

  // While a request is live, always show a real Stop action. Stale idle/live
  // classes after mode switches used to override this button's visual state.
  if (btn && isGenerating) {
    btn.classList.remove("live", "live-active", "ready");
    btn.classList.add("stop");
    btn.dataset.actionMode = "stop";
    btn.title = "Stop generation";
    btn.setAttribute("aria-label", btn.title);
    const icon = getEl("btnIcon");
    if (icon) {
      icon.innerHTML = '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>';
      icon.style.opacity = "1";
      icon.style.transform = "translateY(0) scale(1)";
    }
  } else if (btn) {
    const wasStopping = btn.classList.contains("stop");
    btn.classList.remove("stop");
    if (wasStopping || btn.dataset.actionMode === "stop") btn.dataset.actionMode = "";
    const liveActive = window.__truxLiveState === "live" || window.__truxLiveState === "connecting";
    const nextMode = hasDraft ? "send" : (liveActive ? "live-stop" : "live")
    btn.classList.toggle("ready", hasDraft);
    btn.classList.toggle("live", !hasDraft)
    btn.classList.toggle("live-active", !hasDraft && liveActive)
    btn.title = hasDraft ? "Send message" : (liveActive ? "Stop Live assistant" : "Start Live assistant");
    btn.setAttribute("aria-label", btn.title);
    const icon = getEl("btnIcon");
    if (icon && btn.dataset.actionMode !== nextMode) {
      btn.dataset.actionMode = nextMode;
      const icons = {
        send: '<path fill="currentColor" d="M2 21 23 12 2 3 2 10l15 2-15 2z"/>',
        live: '<path d="M6 9v6 M12 4v16 M18 9v6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
        "live-stop": '<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none"/>'
      };
      icon.style.opacity = "0";
      icon.style.transform = nextMode === "send" ? "translateY(3px) scale(.78)" : "translateY(-3px) scale(.78)";
      requestAnimationFrame(() => {
        if (!btn.isConnected || btn.dataset.actionMode !== nextMode) return;
        icon.innerHTML = icons[nextMode];
        requestAnimationFrame(() => {
          if (!btn.isConnected || btn.dataset.actionMode !== nextMode) return;
          icon.style.opacity = "1";
          icon.style.transform = "translateY(0) scale(1)";
        });
      });
    }
  }
  // Code is only auto-attached on PASTE now. Doing it while typing used to
  // swallow long normal messages into a “file” chip mid-sentence.
}
function positionAttachmentMenu(menu, button) {
  if (!menu || !button || window.innerWidth <= 768) {
    if (menu) ["left", "right", "bottom", "width"].forEach(property => menu.style.removeProperty(property));
    return;
  }
  const anchor = button.getBoundingClientRect();
  const width = Math.min(380, Math.max(260, window.innerWidth - 24));
  const left = Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12));
  const bottom = Math.max(12, window.innerHeight - anchor.top + 10);
  menu.style.left = left + "px";
  menu.style.right = "auto";
  menu.style.bottom = bottom + "px";
  menu.style.width = width + "px";
}

function toggleAttachmentMenu(e) {
  e?.preventDefault(); e?.stopPropagation();
  const menu = getEl("attachmentMenu"), button = getEl("attachBtn");
  if (!menu || !button) return;
  if (menu.classList.contains("open")) return closeAttachmentMenu();
  closeModelDropdown();
  // A blurred/transformed composer can capture fixed descendants; the menu must use viewport coordinates.
  if (menu.parentElement !== document.body) document.body.appendChild(menu);
  menu.style.removeProperty("animation"); menu.style.removeProperty("transform");
  menu.style.removeProperty("opacity"); menu.style.removeProperty("transition"); menu.style.removeProperty("will-change");
  positionAttachmentMenu(menu, button);
  menu.scrollTop = 0;
  const modeRow = menu.querySelector(".trux-plus-grid");
  if (modeRow) modeRow.scrollLeft = 0;
  menu.classList.add("open"); button.classList.add("open"); button.setAttribute("aria-expanded", "true");
}

function closeAttachmentMenu() {
  const menu = getEl("attachmentMenu");
  if (menu) {
    menu.classList.remove("open");
    menu.style.removeProperty("animation"); menu.style.removeProperty("transform");
    menu.style.removeProperty("opacity"); menu.style.removeProperty("transition"); menu.style.removeProperty("will-change");
    ["left", "right", "bottom", "width"].forEach(property => menu.style.removeProperty(property));
  }
  const button = getEl("attachBtn");
  button?.classList.remove("open"); button?.setAttribute("aria-expanded", "false");
}

window.addEventListener("resize", () => {
  const menu = getEl("attachmentMenu");
  if (menu?.classList.contains("open")) positionAttachmentMenu(menu, getEl("attachBtn"));
}, { passive: true });

(function bindPlusMenuGestures() {
  const menu = getEl("attachmentMenu"), handle = getEl("plusMenuHandle"), button = getEl("attachBtn");
  if (!menu || !handle || menu.dataset.gestureBound === "true") return;
  menu.dataset.gestureBound = "true";
  let gesture = null, suppressClickUntil = 0;

  function beginGesture(type, id, y, event) {
    if (!menu.classList.contains("open") || gesture || event?.isPrimary === false ||
        (type === "pointer" && typeof event?.button === "number" && event.button !== 0)) return;
    gesture = {type,id,startY:y,lastY:y,startedAt:Date.now(),startScrollTop:menu.scrollTop,dragging:false};
  }
  function moveGesture(y, event) {
    if (!gesture) return;
    gesture.lastY = y;
    const delta = y - gesture.startY;
    if (!gesture.dragging) {
      if (delta < 9 || gesture.startScrollTop > 1 || menu.scrollTop > 1) return;
      gesture.dragging = true; menu.style.transition = "none"; menu.style.willChange = "transform, opacity";
      if (gesture.type === "pointer") { try { menu.setPointerCapture(gesture.id); } catch {} }
    }
    if (delta < 0) return;
    if (event?.cancelable) event.preventDefault();
    const distance = Math.max(0,delta);
    menu.style.transform = "translateY(" + distance + "px)";
    menu.style.opacity = String(Math.max(.28,1-distance/Math.max(360,menu.offsetHeight*1.35)));
  }
  function finishGesture(finalY, event) {
    if (!gesture) return;
    if (gesture.type === "pointer" && event && event.pointerId !== gesture.id) return;
    if (typeof finalY === "number") gesture.lastY = finalY;
    const current = gesture; gesture = null;
    if (!current.dragging) return;
    const delta = Math.max(0,current.lastY-current.startY);
    const elapsed = Math.max(1,Date.now()-current.startedAt), velocity = delta/elapsed;
    suppressClickUntil = Date.now()+450;
    if (delta >= Math.max(72,menu.offsetHeight*.18) || (delta>26 && velocity>.62)) {
      menu.style.transition = "transform 250ms cubic-bezier(.2,.75,.25,1), opacity 180ms ease, visibility 180ms ease";
      menu.style.transform = "translateY("+Math.max(delta,menu.offsetHeight)+"px)";
      menu.style.opacity = "0"; menu.classList.remove("open");
      button?.classList.remove("open"); button?.setAttribute("aria-expanded","false");
      window.setTimeout(() => {
        if (!menu.classList.contains("open")) {
          menu.style.removeProperty("transform"); menu.style.removeProperty("opacity");
          menu.style.removeProperty("transition"); menu.style.removeProperty("will-change");
        }
      },320);
      return;
    }
    menu.style.transition = "transform 230ms cubic-bezier(.16,1,.3,1), opacity 180ms ease";
    menu.style.transform = "translateY(0)"; menu.style.opacity = "1";
    window.setTimeout(() => {
      if (menu.classList.contains("open")) { menu.style.removeProperty("transform"); menu.style.removeProperty("opacity"); }
      menu.style.removeProperty("transition"); menu.style.removeProperty("will-change");
    },270);
  }

  /* Touch scrolling stays native/momentum-based; down-drag works anywhere at scrollTop 0. */
  menu.addEventListener("touchstart", event => {
    if (event.touches.length!==1) { gesture=null; return; }
    beginGesture("touch",0,event.touches[0].clientY,event);
  },{passive:true});
  menu.addEventListener("touchmove", event => {
    if (!gesture || gesture.type!=="touch" || event.touches.length!==1) return;
    moveGesture(event.touches[0].clientY,event);
  },{passive:false});
  menu.addEventListener("touchend", event => {
    if (!gesture || gesture.type!=="touch") return;
    finishGesture(event.changedTouches?.[0]?.clientY,event);
  },{passive:true});
  menu.addEventListener("touchcancel", event => {
    if (gesture?.type==="touch") finishGesture(undefined,event);
  },{passive:true});

  /* Mouse/pen drag behavior for desktop without sacrificing button clicks. */
  menu.addEventListener("pointerdown", event => {
    if (event.pointerType==="touch") return;
    beginGesture("pointer",event.pointerId,event.clientY,event);
  });
  menu.addEventListener("pointermove", event => {
    if (!gesture || gesture.type!=="pointer" || event.pointerId!==gesture.id) return;
    moveGesture(event.clientY,event);
  });
  menu.addEventListener("pointerup", event => { if (gesture?.type==="pointer") finishGesture(event.clientY,event); });
  menu.addEventListener("pointercancel", event => { if (gesture?.type==="pointer") finishGesture(undefined,event); });
  menu.addEventListener("lostpointercapture", event => { if (gesture?.type==="pointer") finishGesture(undefined,event); });
  menu.addEventListener("click", event => {
    if (Date.now()>=suppressClickUntil) return;
    suppressClickUntil=0; event.preventDefault(); event.stopImmediatePropagation();
  },true);
  handle.addEventListener("click", event => {
    event.preventDefault();
    if (Date.now()>=suppressClickUntil) closeAttachmentMenu();
  });
})();

addEventListener("scroll", e => {
  if (e.target === getEl("chatContainer") || e.target === document) closeAttachmentMenu();
}, true);
function openFileLibrary() {
  closeAttachmentMenu();
  getEl("fileUpload")?.click();
}
function openCamera() { closeAttachmentMenu(); getEl("cameraUpload").click(); }
function openPhotoLibrary() { closeAttachmentMenu(); getEl("imageUpload").click(); }

async function ingestLargeFile(file) {
  if(!auth?.currentUser) { openLoginWall(); throw new Error("Sign in before uploading files."); }
  const requestUser = auth.currentUser;
  const uploadResponse = await truxAuthenticatedFetch("/api/files/upload", {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream", "X-Trux-File-Name": encodeURIComponent(file.name) },
    body: file
  }, requestUser);
  const uploaded = await uploadResponse.json().catch(() => ({}));
  if(!uploadResponse.ok) throw new Error(uploaded.error || "File upload failed.");
  const processResponse = await truxAuthenticatedFetch("/api/files/process", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ objectKey: uploaded.objectKey, mimeType: uploaded.mimeType, name: uploaded.name })
  }, requestUser);
  const processed = await processResponse.json().catch(() => ({}));
  if(!processResponse.ok) throw new Error(processed.error || "File processing failed.");
  return {
    name: processed.file?.name || file.name,
    size: processed.file?.size || file.size,
    mimeType: processed.file?.mimeType || file.type || "application/octet-stream",
    objectKey: processed.file?.objectKey || uploaded.objectKey,
    processedKey: processed.file?.processedKey || null,
    kind: processed.file?.kind || "file",
    pages: processed.file?.pages ?? null,
    rows: processed.file?.rows ?? null,
    filesIncluded: processed.file?.filesIncluded ?? null,
    filesSkipped: processed.file?.filesSkipped ?? null,
    snippet: processed.file?.snippet || (file.name + " · " + Math.ceil(file.size / 1024) + " KB")
  };
}

async function handleFileUpload(e) {
  const files = Array.from(e.target.files || []).slice(0, 8);
  if(!files.length) return;
  if(!auth?.currentUser) { e.target.value = ""; openLoginWall(); return; }
  for (const file of files) {
    const id = Date.now() + Math.floor(Math.random() * 100000);
    if(file.type.startsWith("image/")) {
      await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = ev => { selectedImageBase64 = ev.target.result; getEl("imagePreview").src = ev.target.result; getEl("imagePreviewContainer").classList.add("visible"); resolve(); };
        reader.onerror = () => { toast("Could not read " + file.name + ".", "err"); resolve(); };
        reader.readAsDataURL(file);
      });
      continue;
    }
    const pending = { id, name: file.name, size: file.size, mimeType: file.type || "application/octet-stream", processing: true, snippet: file.name + " · Uploading…" };
    fileAttachments.push(pending);
    renderFileChips(); handleInputChange();
    try {
      const processed = await ingestLargeFile(file);
      Object.assign(pending, processed, { processing: false });
      pending.snippet = processed.snippet;
      toast(file.name + " ready for analysis.", "ok");
    } catch(error) {
      fileAttachments = fileAttachments.filter(x => x.id !== id);
      toast(file.name + ": " + (error?.message || "processing failed"), "err");
    }
    renderFileChips(); handleInputChange();
  }
  e.target.value = "";
}
    
function handleImageUpload(e) {
  let f = e.target.files[0]; if(!f || !f.type.startsWith("image/")) return;
  let r = new FileReader();
  r.onload = x => { selectedImageBase64 = x.target.result; getEl("imagePreview").src = x.target.result; getEl("imagePreviewContainer").classList.add("visible"); updateComposerAttachments(); handleInputChange(); };
  r.readAsDataURL(f);
}
function removeImage() { selectedImageBase64 = null; getEl("imageUpload").value = ""; getEl("cameraUpload").value = ""; getEl("imagePreviewContainer").classList.remove("visible"); updateComposerAttachments(); handleInputChange(); }

if("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
  let SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR(); recognition.continuous = false; recognition.interimResults = true; recognition.lang = store.getItem("trux_dictation_language") && store.getItem("trux_dictation_language") !== "auto" ? store.getItem("trux_dictation_language") : (navigator.language || "en-US");
  recognition.onstart = () => { isRecording = true; wasInputByVoice = true; getEl("voiceBtn").classList.add("recording"); };
  recognition.onresult = e => { let t = "", finalText = ""; for(let i = e.resultIndex; i < e.results.length; i++) { t += e.results[i][0].transcript; if(e.results[i].isFinal) finalText += e.results[i][0].transcript; } getEl("promptInput").value = t; if(finalText.trim()) storeDictationHistory(finalText); handleInputChange(); };
  recognition.onerror = stopVoiceInput; recognition.onend = stopVoiceInput;
}
function toggleVoiceInput() { if(!recognition) return toast("Speech recognition is not supported in this browser.", "err"); isRecording ? recognition.stop() : (wasInputByVoice = true, recognition.start()); }
function stopVoiceInput() { isRecording = false; getEl("voiceBtn").classList.remove("recording"); }
