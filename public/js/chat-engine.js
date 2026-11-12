/* Chat turn engine.
 *
 * One POST /api/chat per turn. The server streams SSE events back and also
 * writes the reply into Realtime Database as it streams, so:
 *   - closing or refreshing the tab never cancels the reply,
 *   - if the stream drops, the UI keeps following the reply from RTDB,
 *   - Stop is a flag in RTDB that the server watches.
 * The model chooses its own tools (web search, images, video, memory, apps);
 * the client never routes by keyword.
 */
const TRUX_SEND_ICON = '<path fill="currentColor" d="M2 21 23 12 2 3 2 10l15 2-15 2z"/>';
const TRUX_STOP_ICON = '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>';

function setComposerGenerating(on) {
  isGenerating = !!on;
  const icon = getEl("btnIcon");
  const btn = getEl("actionBtn");
  if (icon) icon.innerHTML = on ? TRUX_STOP_ICON : TRUX_SEND_ICON;
  if (btn) { btn.classList.toggle("stop", !!on); if (on) btn.classList.remove("ready"); }
  handleInputChange();
}

/* Detach the UI from the running turn without stopping it on the server. */
function detachActiveTurn() {
  generationEpoch += 1;
  try { activeAbortController?.abort(); } catch {}
  try { activeStreamer?.cancel(); } catch {}
  activeAbortController = null;
  activeStreamer = null;
  activeTurnContext = null;
  generationStopRequested = false;
  if (currentChatId) stopStreamWatcher(currentChatId);
  setComposerGenerating(false);
}

function buildAssistantRow({ animate = true } = {}) {
  const stamp = Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  const ids = { id: "b_" + stamp, aid: "a_" + stamp, sid: "s_" + stamp, tsid: "ts_" + stamp, thid: "th_" + stamp };
  const row = document.createElement("div");
  row.className = "row trux-row" + (animate ? " appear" : "");
  row.innerHTML = `<div class="trux-response-stack">
    <div class="trux-thinking-panel trux-chat-thinking" id="${ids.thid}" data-thinking-visible="true">
      <div class="trux-thinking-bar">
        <span class="trux-thinking-spark trux-thinking-chat-spark" aria-hidden="true"><span class="trux-orbit"><i style="--a:0deg"></i><i style="--a:120deg"></i><i style="--a:240deg"></i></span></span>
        <div class="trux-thinking-copy"><span class="status-msg" id="${ids.sid}" role="status" aria-live="polite"><span class="thinking-status-line compact"></span><span class="thinking-status-line full"></span></span></div>
        <button type="button" class="trux-thinking-toggle" hidden onclick="toggleThinkingDetails('${ids.thid}')" aria-expanded="false" aria-label="Expand AI activity" title="Expand AI activity"><svg viewBox="0 0 24 24"><path d="m7 9 5 5 5-5"/></svg></button>
      </div>
      <div class="trux-thinking-details" id="${ids.tsid}" hidden></div>
    </div>
    <div class="bubble trux-bubble" id="${ids.id}"></div>
    <div class="actions" id="${ids.aid}"></div>
  </div>`;
  return { row, ...ids };
}

/* Generated images and videos live in Cloud Storage and are served only to
   their owner through /api/media, so they are fetched with the ID token. */
const truxMediaUrlCache = new Map();
async function truxMediaObjectUrl(objectKey) {
  if (truxMediaUrlCache.has(objectKey)) return truxMediaUrlCache.get(objectKey);
  const promise = truxAuthenticatedFetch("/api/media?key=" + encodeURIComponent(objectKey))
    .then(r => { if (!r.ok) throw new Error("Media unavailable (" + r.status + ")"); return r.blob(); })
    .then(blob => URL.createObjectURL(blob));
  truxMediaUrlCache.set(objectKey, promise);
  promise.catch(() => truxMediaUrlCache.delete(objectKey));
  return promise;
}

function truxFileSize(bytes) {
  const n = Number(bytes) || 0;
  return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : n + " B";
}

function attachTruxMedia(row, mediaList) {
  const bubble = row?.querySelector(".bubble");
  const actions = row?.querySelector(".actions");
  if (!bubble) return;
  for (const media of mediaList || []) {
    if (!media?.objectKey || bubble.querySelector(`[data-media-key="${CSS.escape(media.objectKey)}"]`)) continue;
    const mime = String(media.mimeType || "");
    const isVideo = media.kind === "video" || mime.startsWith("video/");
    const isImage = !isVideo && (media.kind === "image" || mime.startsWith("image/"));
    if (!isVideo && !isImage) {
      // Files made in the sandbox: a download chip.
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "trux-file-chip";
      chip.dataset.mediaKey = media.objectKey;
      const name = media.name || media.objectKey.split("/").pop();
      chip.innerHTML = `<span class="tfc-icon">${ICON.down}</span><span class="tfc-copy"><b></b><small></small></span>`;
      chip.querySelector("b").textContent = name;
      chip.querySelector("small").textContent = [truxFileSize(media.size), mime].filter(Boolean).join(" · ");
      chip.onclick = () => truxMediaObjectUrl(media.objectKey).then(url => { const a = document.createElement("a"); a.href = url; a.download = name; a.click(); })
        .catch(() => toast("This file is no longer available.", "err"));
      bubble.appendChild(chip);
      continue;
    }
    const wrap = document.createElement("div");
    wrap.className = isVideo ? "gen-video-wrap" : "gen-image-wrap";
    wrap.dataset.mediaKey = media.objectKey;
    const el = document.createElement(isVideo ? "video" : "img");
    if (isVideo) { el.controls = true; el.preload = "metadata"; el.playsInline = true; }
    else { el.alt = media.prompt ? "Generated image: " + media.prompt.slice(0, 120) : "Generated image"; el.onload = () => el.classList.add("loaded"); }
    wrap.appendChild(el);
    bubble.appendChild(wrap);
    const ext = (mime.split("/")[1] || (isVideo ? "mp4" : "png")).replace("jpeg", "jpg").replace("quicktime", "mov");
    truxMediaObjectUrl(media.objectKey).then(url => {
      el.src = url;
      if (actions && !actions.querySelector(`[data-download="${CSS.escape(media.objectKey)}"]`)) {
        const dl = document.createElement("button");
        dl.className = "act"; dl.type = "button"; dl.dataset.download = media.objectKey;
        dl.title = isVideo ? "Download video" : "Download image";
        dl.innerHTML = ICON.down + "Download";
        dl.onclick = () => { const a = document.createElement("a"); a.href = url; a.download = `trux-${isVideo ? "video" : "image"}-${Date.now()}.${ext}`; a.click(); };
        actions.prepend(dl);
      }
    }).catch(() => { wrap.classList.add("media-error"); wrap.textContent = "This media is no longer available."; });
  }
}

function renderAssistantActions(row, text, { incomplete = false } = {}) {
  const a = row?.querySelector(".actions");
  if (!a) return;
  a.querySelectorAll(".act:not([data-download]):not([data-plugin-reauth])").forEach(el => el.remove());
  const make = (title, html, fn) => { const b = document.createElement("button"); b.className = "act"; b.type = "button"; b.title = title; b.innerHTML = html; b.onclick = fn; return b; };
  const readBtn = make("Read aloud", ICON.speak + "Read", () => speakText(text, readBtn));
  const copyBtn = make("Copy answer", ICON.copy + "Copy", () => copyTextMessage(text, copyBtn));
  const editBtn = make("Edit prompt", ICON.edit + "Edit", () => editPromptFromAssistantRow(row));
  const pinBtn = make("Pin to insights", ICON.pin + "Pin", () => pinInsight(text));
  const regenBtn = make("Regenerate this answer", ICON.redo + "Retry", () => regenerateLast());
  if (incomplete) a.append(regenBtn);
  else a.append(readBtn, copyBtn, editBtn, pinBtn, regenBtn);
}

function settleAssistantRow(row, msg) {
  if (!row) return;
  dismissThinkingPanel(row);
  const bubble = row.querySelector(".bubble");
  if (bubble) {
    bubble.classList.remove("thinking");
    let text = msg.text || "";
    if (msg.status === "error" && !text) text = msg.error || "The response could not be completed.";
    bubble.innerHTML = renderFormattedText(text, false);
    if (msg.status === "stopped") bubble.insertAdjacentHTML("beforeend", '<div class="trux-stopped-note">Stopped</div>');
    renderTruxDiagrams(bubble);
    scheduleTruxMath(bubble);
  }
  attachSources(row, (msg.sources || []).filter(s => s?.uri).slice(0, 8));
  attachTruxMedia(row, msg.media);
  renderAssistantActions(row, msg.text || "", { incomplete: msg.status === "error" && !msg.text });
}

function dataUrlToBlob(dataUrl) {
  const [head, body] = String(dataUrl).split(",");
  const mime = (head.match(/data:([^;]+)/) || [])[1] || "image/png";
  const bin = atob(body || "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function uploadTurnBlob(blob, name) {
  const res = await truxAuthenticatedFetch("/api/files/upload", {
    method: "POST",
    headers: { "Content-Type": blob.type || "application/octet-stream", "X-Trux-File-Name": encodeURIComponent(name) },
    body: blob
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Upload failed.");
  return { objectKey: data.objectKey, name: data.name || name, mimeType: data.mimeType || blob.type, size: data.size || blob.size };
}

function thinkingParam() {
  if (workspaceMode === "deep-research") return "high";
  return advancedThinkingLevel === "extended" ? "high" : advancedThinkingLevel === "medium" ? "medium" : "low";
}

function serverMode() {
  return ["deep-research", "video"].includes(workspaceMode) ? workspaceMode : "chat";
}

async function readSseStream(response, onEvent, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    if (signal?.aborted) { try { await reader.cancel(); } catch {} return; }
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = frame.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
      if (!data) continue;
      let event; try { event = JSON.parse(data); } catch { continue; }
      onEvent(event);
    }
  }
}

async function sendPromptImpl() {
  try { if (typeof navigator.vibrate === "function") navigator.vibrate(0); } catch {}
  if (!truxAuthStateReady) {
    const restored = await waitForTruxAuthState();
    if (restored === undefined && !truxAuthStateReady) { toast("Still restoring your sign-in. Try again in a moment.", "err"); return; }
  }
  const user = auth?.currentUser;
  if (!user) { openLoginWall("signin"); return; }
  if (fileAttachments.some(f => f.processing)) { toast("Wait for your files to finish uploading.", "err"); return; }

  const promptInput = getEl("promptInput");
  const typed = promptInput.value.trim();
  if (!typed && !selectedImageBase64 && !fileAttachments.length && !pastedTextBlocks.length) return;

  // Pasted blocks travel inline; very large ones become uploaded text files.
  let message = typed;
  const uploads = [];
  for (const block of pastedTextBlocks) {
    const text = String(block.text || "");
    if (text.length <= 60000) message += `\n\n--- ${block.name || "Pasted text"} ---\n${text}`;
    else uploads.push(uploadTurnBlob(new Blob([text], { type: "text/plain" }), block.name || "pasted.txt"));
  }
  const imageDataUrl = selectedImageBase64;
  if (imageDataUrl) uploads.push(uploadTurnBlob(dataUrlToBlob(imageDataUrl), "image." + ((imageDataUrl.match(/image\/(\w+)/) || [])[1] || "png")));
  const fileList = fileAttachments.map(f => ({ objectKey: f.objectKey, name: f.name, mimeType: f.mimeType, size: f.size })).filter(f => f.objectKey);

  enterChatWorkspace();
  closeModelDropdown();
  closeAttachmentMenu();
  try { activeStreamer?.cancel(); } catch {}
  activeStreamer = null;
  generationStopRequested = false;
  const turnId = ++generationEpoch;
  isScrolledUp = false;
  setComposerGenerating(true);
  const voice = wasInputByVoice; wasInputByVoice = false;

  const incognito = !!incognitoMode;
  if (!currentChatId) {
    currentChatId = newChatId();
    chatSessions[currentChatId] = {
      title: (typed || "New chat").slice(0, 60), mode: workspaceMode, notebookId: notebookIdForNewChat(),
      messages: [], messagesLoaded: true, createdAt: Date.now(), updatedAt: Date.now()
    };
  }
  const chatId = currentChatId;
  const session = chatSessions[chatId];
  session.mode = workspaceMode;
  session.updatedAt = Date.now();
  const attachmentLabel = (fileList.length + uploads.length) ? `\n\n[${fileList.length + uploads.length} attachment${fileList.length + uploads.length === 1 ? "" : "s"}]` : "";
  const userMessage = { role: "user", text: message, attachments: fileList };
  session.messages.push(userMessage);
  const userIndex = session.messages.length - 1;
  queueSidebarSync();

  document.body.classList.remove("home-active"); document.body.classList.add("chat-session-active");
  const chatContainer = getActiveChatContainer();
  appendMessageRow("You", typed + attachmentLabel, "user-row", "user-bubble", null, true, undefined, undefined, { messageIndex: userIndex });
  promptInput.value = ""; removeImage(); pastedTextBlocks = []; fileAttachments = []; renderFileChips(); handleInputChange();

  const parts = buildAssistantRow();
  const { row, sid, tsid } = parts;
  chatContainer.appendChild(row);
  chatContainer.scrollTop = chatContainer.scrollHeight;
  setThinkingStatus(sid, uploads.length ? "Uploading…" : "Thinking…");

  const ctx = { turnId, chatId, row, messageId: "", userMessageId: "", text: "", sources: [], media: [], settled: false, incognito };
  activeTurnContext = ctx;
  const isCurrent = () => turnId === generationEpoch;

  let attachments = fileList;
  try {
    if (uploads.length) attachments = fileList.concat(await Promise.all(uploads));
  } catch (error) {
    settleAssistantRow(row, { status: "error", error: error.message || "Upload failed.", text: "" });
    setComposerGenerating(false);
    return;
  }
  userMessage.attachments = attachments;

  const wantsPlace = /\b(near me|nearby|around me|my location|where am i|closest|nearest|local|weather|directions|restaurants?|open now)\b/i.test(typed);
  const location = wantsPlace ? await Promise.race([getTruxLocationForTurn(), new Promise(r => setTimeout(() => r(null), 900))]).catch(() => null) : null;

  const body = {
    chatId: incognito ? "" : chatId,
    message,
    mode: serverMode(),
    attachments,
    thinking: thinkingParam(),
    location: location ? { latitude: location.latitude ?? location.lat, longitude: location.longitude ?? location.lng } : null,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    incognito,
    history: incognito ? session.messages.slice(0, userIndex).map(m => ({ role: m.role === "trux" ? "model" : "user", text: m.text })) : undefined,
    notify: true,
    video: workspaceMode === "video" ? window.truxVideoStudio?.options() : undefined,
    device: (() => { try { return window.truxDevice?.info() || null; } catch { return null; } })(),
    ...(isTruxDeveloper(user) ? { ownerModel: store.getItem("trux_owner_gemini_model") || "auto" } : {})
  };

  await truxPendingSync;
  const controller = new AbortController();
  activeAbortController = controller;
  let streamer = null;
  const ensureStreamer = () => {
    if (streamer || ctx.settled) return streamer;
    const bubble = row.querySelector(".bubble");
    dismissThinkingPanel(row);
    bubble.classList.remove("thinking");
    streamer = createStreamRenderer(bubble);
    activeStreamer = streamer;
    return streamer;
  };

  const finish = msg => {
    if (ctx.settled) return;
    ctx.settled = true;
    row.querySelector(".trux-storyboard")?.remove();
    if (activeStreamer === streamer) activeStreamer = null;
    const stored = { id: ctx.messageId, role: "trux", text: msg.text || "", sources: msg.sources || ctx.sources, media: msg.media || ctx.media, status: msg.status || "done", error: msg.error || "", incomplete: msg.status !== "done" };
    if (ctx.messageId) {
      const idx = session.messages.findIndex(m => m.id === ctx.messageId);
      if (idx >= 0) session.messages[idx] = stored; else session.messages.push(stored);
    } else session.messages.push(stored);
    /* A finished answer is usually fully received long before it has been revealed. Let the stream
       renderer keep revealing it at reading pace and only then swap in the final markup, instead of
       replacing the bubble with the whole text the moment the server says "done". */
    const drain = !!(streamer && stored.status === "done" && stored.text);
    if (drain && isCurrent()) {
      activeAbortController = null;
      if (activeTurnContext === ctx) activeTurnContext = null;
      setComposerGenerating(false);
      try {
        streamer.setText(stored.text);
        streamer.finish(() => { if (row.isConnected) settleAssistantRow(row, stored); });
      } catch { settleAssistantRow(row, stored); }
      if (voice || getEl("autoReadToggle")?.checked) speakText(stored.text);
      for (const m of stored.media || []) { if (m.kind !== "image" && m.kind !== "video") continue; try { saveGeneratedMedia?.({ type: m.kind, objectKey: m.objectKey, prompt: m.prompt || typed }); } catch {} }
    } else if (isCurrent()) {
      if (streamer) { try { streamer.cancel(); } catch {} }
      settleAssistantRow(row, stored);
      activeAbortController = null;
      if (activeTurnContext === ctx) activeTurnContext = null;
      setComposerGenerating(false);
      if (stored.status === "done" && stored.text && (voice || getEl("autoReadToggle")?.checked)) speakText(stored.text);
      for (const m of stored.media || []) { if (m.kind !== "image" && m.kind !== "video") continue; try { saveGeneratedMedia?.({ type: m.kind, objectKey: m.objectKey, prompt: m.prompt || typed }); } catch {} }
    }
    queueSidebarSync();
  };

  const onEvent = ev => {
    ctx.lastEventAt = Date.now();
    if (!isCurrent() && ev.type !== "start") return;
    switch (ev.type) {
      case "start":
        ctx.messageId = ev.messageId; ctx.userMessageId = ev.userMessageId;
        userMessage.id = ev.userMessageId;
        rememberMessageId(chatId, ev.userMessageId); rememberMessageId(chatId, ev.messageId);
        row.dataset.messageId = ev.messageId;
        if (generationStopRequested && !incognito) {
          setThinkingStatus(sid, "Stopping…");
          requestServerStop(chatId, ev.messageId);
        }
        break;
      case "status":
        if (!streamer) setThinkingStatus(sid, ev.status || "");
        if (ev.stage) window.truxVideoStudio?.progress(row, ev);
        break;
      case "storyboard": window.truxVideoStudio?.storyboard(row, ev.plan); break;
      case "chunk": {
        if (!ev.text) break;
        ctx.text += ev.text;
        const s = ensureStreamer();
        if (s) { if (!s.received) s.setText(ctx.text); else s.push(ev.text); }
        break;
      }
      case "tool_status":
        if (!streamer) setThinkingStatus(sid, ev.label || ev.tool || "Working…");
        appendToolStatusLine(tsid, ev.label || ev.tool, ev.phase === "start" ? "" : (ev.ok === false ? "Failed" : "Done"), ev.phase || "complete", { id: ev.id });
        break;
      case "grounding": {
        const seen = new Map(ctx.sources.map(s => [s.uri, s]));
        for (const s of ev.sources || []) if (s?.uri && !seen.has(s.uri)) seen.set(s.uri, s);
        ctx.sources = Array.from(seen.values()).slice(0, 12);
        attachSources(row, ctx.sources);
        break;
      }
      case "media": if (ev.media) { ctx.media.push(ev.media); attachTruxMedia(row, [ev.media]); } break;
      case "memory":
        if (ev.action === "saved") toast("Memory updated", "ok");
        try { refreshTruxMemoryList?.(); } catch {}
        break;
      case "device_action": if (ev.action) window.truxDevice?.run(ev.action, { source: "chat" }); break;
      case "plugin_auth_required":
        setThinkingStatus(sid, ev.message || ((ev.pluginName || "App") + " needs to be connected."));
        if (ev.redirectUrl && !row.querySelector("[data-plugin-reauth]")) {
          const btn = document.createElement("button");
          btn.className = "act"; btn.type = "button"; btn.dataset.pluginReauth = "1";
          btn.textContent = "Connect " + (ev.pluginName || "app");
          btn.onclick = () => window.location.assign(ev.redirectUrl);
          row.querySelector(".actions")?.appendChild(btn);
        }
        break;
      case "final": finish({ text: ev.text || ctx.text, sources: ev.sources?.length ? ev.sources : ctx.sources, media: ev.media || ctx.media, status: "done" }); break;
      case "stopped": finish({ text: ctx.text, status: "stopped" }); break;
      case "error": finish({ text: ctx.text, status: "error", error: ev.error }); break;
      case "title":
        if (chatSessions[ev.chatId]) { chatSessions[ev.chatId].title = ev.title; queueSidebarSync(); }
        break;
      default: break;
    }
  };

  try {
    const res = await truxAuthenticatedFetch("/api/chat", {
      method: "POST", cache: "no-store", signal: controller.signal,
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Request failed (" + res.status + ")");
    }
    await readSseStream(res, onEvent, controller.signal);
  } catch (error) {
    if (!isCurrent()) return;
    if (controller.signal.aborted && generationStopRequested) {
      if (incognito || !ctx.messageId) finish({ text: ctx.text, status: "stopped" });
      return;
    }
    if (!ctx.settled && ctx.messageId && !incognito) {
      // The stream dropped but the server keeps generating: follow it in RTDB.
      setThinkingStatus(sid, "Reconnecting…");
      followServerTurn(ctx, session, () => streamer);
      return;
    }
    if (!ctx.settled) finish({ text: ctx.text, status: "error", error: navigator.onLine === false ? "You're offline. The reply will appear when you reconnect." : (error?.message || "Something went wrong.") });
    return;
  }
  if (!ctx.settled && isCurrent()) {
    if (ctx.messageId && !incognito) followServerTurn(ctx, session, () => streamer);
    else finish({ text: ctx.text, status: ctx.text ? "done" : "error", error: "The response ended early." });
  }
}

function followServerTurn(ctx, session, getStreamer) {
  if (ctx.following) return;
  ctx.following = true;
  try { getStreamer()?.cancel(); } catch {}
  if (activeStreamer === getStreamer()) activeStreamer = null;
  watchStreamingMessage(ctx.chatId, ctx.messageId, ctx.row, {
    onSettled: msg => {
      ctx.settled = true;
      if (ctx.turnId !== generationEpoch) return;
      settleAssistantRow(ctx.row, msg);
      if (activeTurnContext === ctx) activeTurnContext = null;
      activeAbortController = null;
      setComposerGenerating(false);
    }
  });
}

function markGenerationStopped() {
  if (generationStopRequested) return;
  const ctx = activeTurnContext;
  generationStopRequested = true;

  const button = getEl("actionBtn");
  if (button) {
    button.title = "Stopping…";
    button.setAttribute("aria-label", "Stopping…");
  }
  if (ctx?.row) setThinkingStatus(ctx.row.querySelector(".status-msg")?.id, "Stopping…");

  if (ctx && !ctx.incognito) {
    /* Keep SSE open so the persistent server turn can receive its stop flag. */
    if (ctx.messageId) requestServerStop(ctx.chatId, ctx.messageId);
    return;
  }
  try { activeAbortController?.abort(); } catch {}
}

function handleActionButton() {
  if (isGenerating) { markGenerationStopped(); return; }
  sendPrompt();
}

async function sendPrompt() {
  if (sendPromptInFlight || isGenerating) return;
  sendPromptInFlight = true;
  try { await sendPromptImpl(); }
  catch (error) {
    console.error("TruX send failed", error);
    toast(error?.message || "Could not send that message.", "err");
    setComposerGenerating(false);
  } finally {
    sendPromptInFlight = false;
  }
}

/* ---------- Opening a stored chat ---------- */

function renderStoredMessages(chatId) {
  const session = chatSessions[chatId];
  const container = getActiveChatContainer();
  container.innerHTML = "";
  let streamingRow = null;
  let streamingId = "";
  session.messages.forEach((m, index) => {
    if (m.role === "user") {
      const label = m.attachments?.length ? `\n\n[${m.attachments.length} attachment${m.attachments.length === 1 ? "" : "s"}]` : "";
      appendMessageRow("You", m.text + label, "user-row", "user-bubble", null, false, undefined, undefined, { messageIndex: index, stopped: m.stopped === true });
      return;
    }
    const parts = buildAssistantRow({ animate: false });
    container.appendChild(parts.row);
    parts.row.dataset.messageId = m.id || "";
    if (m.status === "streaming") {
      const bubble = parts.row.querySelector(".bubble");
      if (m.text) { dismissThinkingPanel(parts.row); bubble.innerHTML = renderFormattedText(m.text, false); }
      else setThinkingStatus(parts.sid, "Still working on this…");
      streamingRow = parts.row; streamingId = m.id;
    } else {
      settleAssistantRow(parts.row, m);
    }
  });
  container.scrollTop = container.scrollHeight;
  if (streamingRow && streamingId) {
    const ctx = { turnId: generationEpoch, chatId, row: streamingRow, messageId: streamingId, incognito: false, settled: false, text: "", sources: [], media: [] };
    activeTurnContext = ctx;
    setComposerGenerating(true);
    followServerTurn(ctx, session, () => null);
  }
}

async function loadChatSession(id) {
  if (!chatSessions[id]) return;
  detachActiveTurn();
  document.body.classList.remove("notebook-open", "incognito-mode");
  incognitoMode = false;
  currentChatId = id;
  setWorkspaceMode(chatSessions[id].mode === "coding" ? "chat" : (chatSessions[id].mode || "chat"), { reload: false, preserveSession: true });
  const container = enterChatWorkspace();
  if (!chatSessions[id].messagesLoaded) container.innerHTML = '<div class="trux-chat-loading" role="status">Loading chat…</div>';
  renderSidebar(); if (innerWidth <= 768) closeSidebar(); else setSidebarOpen(true);
  try {
    await loadChatMessages(id);
  } catch (error) {
    if (currentChatId === id) container.innerHTML = '<div class="trux-chat-loading">Could not load this chat. Check your connection and try again.</div>';
    return;
  }
  if (currentChatId !== id) return;
  renderStoredMessages(id);
}

async function deleteChat(id) {
  if (!confirm("Delete this chat?")) return;
  if (!chatSessions[id]) return;
  const notebookWasOpen = document.body.classList.contains("notebook-open");
  const openNotebookId = getActiveNotebookId();
  if (activeTurnContext?.chatId === id) markGenerationStopped();
  delete chatSessions[id];
  saveChatSessions();
  if (currentChatId === id) {
    detachActiveTurn();
    if (notebookWasOpen) currentChatId = null;
    else startNewChat();
  }
  renderSidebar();
  if (notebookWasOpen) renderNotebookWorkspace(openNotebookId);
}


/* ---------- background / offline recovery ----------
   The server keeps generating after the app is backgrounded or closed and stores the reply.
   When the phone wakes up (or the network returns) and the live stream has gone quiet,
   follow the stored reply instead of waiting on a connection the OS may have frozen. */
(function () {
  let hiddenAt = 0;
  function recover(reason) {
    const ctx = activeTurnContext;
    if (!ctx || ctx.settled || ctx.incognito || !ctx.messageId || ctx.following) return;
    const since = Date.now();
    setTimeout(() => {
      if (activeTurnContext !== ctx || ctx.settled || ctx.following) return;
      if ((ctx.lastEventAt || 0) > since) return;               /* the live stream is still delivering */
      try { setThinkingStatus(ctx.row?.querySelector(".status-msg")?.id, "Catching up…"); } catch {}
      const streamer = activeStreamer;
      followServerTurn(ctx, chatSessions[ctx.chatId], () => streamer);
      try { activeAbortController?.abort(); } catch {}
    }, reason === "online" ? 800 : 1800);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (Date.now() - hiddenAt > 2500) recover("visible");
  });
  window.addEventListener("pageshow", e => { if (e.persisted) recover("visible"); });
  window.addEventListener("online", () => recover("online"));
})();
