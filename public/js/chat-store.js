/* Chat storage on Firebase Realtime Database.
 *
 *   users/{uid}/chats/{chatId}            chat metadata (sidebar list)
 *   users/{uid}/messages/{chatId}/{msgId} messages, written by the server
 *
 *   users/{uid}/thinking/{chatId}/{msgId} the answer's thinking summary, kept apart from the answer
 *
 * `chatSessions` stays the in-memory model the UI already uses. The chat list
 * is live-synced; messages load lazily when a chat opens. The reply is streamed
 * to the screen over SSE and written to the database ONCE, when it is complete
 * (a small "working" placeholder is stored while it runs). It keeps generating on
 * Vertex AI even if this tab closes; reopening the chat shows "working in the
 * background" until the finished answer lands, then settles it in place.
 */
let truxSyncedUid = "";
let truxChatsRef = null;
let truxSyncedMeta = {};          // chatId -> last meta seen in RTDB
let truxPendingSync = Promise.resolve();
let truxChatSyncRetried = false;  // one token refresh + re-listen per sign-in
let truxChatSyncWarned = false;   // one message per sign-in
const truxSyncedMessageIds = {};  // chatId -> Set of message ids seen in RTDB
const truxStreamWatchers = {};    // chatId -> unsubscribe fn
let truxServerMode = false;       // true when the database rules refuse the browser: everything goes through /api/data
let truxServerPoll = null;
const TRUX_META_FIELDS = ["title", "mode", "notebookId", "pinned", "archived"];

function truxUid() { return auth?.currentUser?.uid || ""; }
function userRef(path) { return rtdb.ref(`users/${truxUid()}/${path}`); }

/* Server-side data access (Admin SDK). Used when the browser is refused by the database rules. */
async function truxDataApi(path, body) {
  const response = await truxAuthenticatedFetch("/api/data/" + path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function newChatId() {
  return "chat_" + Date.now() + Math.random().toString(36).slice(2, 8);
}

function chatTimestamp(id) {
  const meta = chatSessions[id];
  const ms = Number(meta?.updatedAt || meta?.createdAt) || Number(String(id).replace(/^chat_/, "").slice(0, 13));
  return Number.isFinite(ms) ? ms : 0;
}

/* Called by auth.js whenever the signed-in user changes. */
function onTruxUserChanged(user) {
  const uid = user?.uid || "";
  if (uid === truxSyncedUid) return;
  detachChatSync();
  chatSessions = {};
  currentChatId = null;
  truxSyncedMeta = {};
  getEl("chatContainer")?.replaceChildren();
  document.body.classList.remove("chat-session-active");
  document.body.classList.add("home-active");
  truxSyncedUid = uid;
  truxChatSyncRetried = false;
  truxChatSyncWarned = false;
  truxServerMode = false;
  if (uid) attachChatSync(uid);
  renderSidebar();
}

function detachChatSync() {
  try { truxChatsRef?.off(); } catch {}
  truxChatsRef = null;
  clearInterval(truxServerPoll); truxServerPoll = null;
  Object.keys(truxStreamWatchers).forEach(stopStreamWatcher);
  Object.keys(truxSyncedMessageIds).forEach(k => delete truxSyncedMessageIds[k]);
}

function applyRemoteChats(remote) {
  const next = {};
  for (const [id, meta] of Object.entries(remote || {})) {
    if (!meta || typeof meta !== "object") continue;
    next[id] = meta;
    /* Chats the user deleted are only hidden: the data stays in the database (retention). */
    if (meta.deleted === true) { delete chatSessions[id]; continue; }
    const local = chatSessions[id] || { messages: [], messagesLoaded: false };
    chatSessions[id] = {
      ...local,
      title: meta.title || local.title || "New chat",
      mode: meta.mode || local.mode || "chat",
      notebookId: meta.notebookId || null,
      pinned: meta.pinned === true,
      archived: meta.archived === true,
      createdAt: meta.createdAt || local.createdAt || 0,
      updatedAt: meta.updatedAt || local.updatedAt || 0,
      lastStatus: meta.lastStatus || ""
    };
  }
  // Chats deleted on another device disappear here too. Brand-new local
  // chats whose meta hasn't landed yet are kept.
  for (const id of Object.keys(chatSessions)) {
    const session = chatSessions[id];
    if ((next[id] && next[id].deleted !== true) || session?.incognito) continue;
    if (truxSyncedMeta[id] || session?.messagesLoaded === false) delete chatSessions[id];
  }
  truxSyncedMeta = next;
  queueSidebarSync();
}

/* The browser is refused by the database rules, so read and write through the server instead. */
function enterServerMode(uid) {
  if (truxServerMode || truxSyncedUid !== uid) return;
  truxServerMode = true;
  try { truxChatsRef?.off(); } catch {}
  truxChatsRef = null;
  const poll = async () => {
    if (truxSyncedUid !== uid) return;
    try { applyRemoteChats((await truxDataApi("chats")).chats); }
    catch (error) {
      console.warn("TruX chat poll failed", error?.message || error);
      if (!truxChatSyncWarned) { truxChatSyncWarned = true; toast("Chat history can't reach the server right now.", "err"); }
    }
  };
  void poll();
  truxServerPoll = setInterval(() => { if (!document.hidden) void poll(); }, 5000);
}

function attachChatSync(uid) {
  truxChatsRef = rtdb.ref(`users/${uid}/chats`);
  truxChatsRef.on("value", snapshot => applyRemoteChats(snapshot.val() || {}), error => {
    console.warn("TruX chat sync failed", error?.message || error);
    const denied = /permission_denied/i.test(String(error?.code || error?.message));
    // A stale token can be refused: refresh it and listen once more before giving up on the direct connection.
    if (denied && !truxChatSyncRetried && auth?.currentUser && truxSyncedUid === uid) {
      truxChatSyncRetried = true;
      getTruxIdToken(auth.currentUser, true).then(() => { if (truxSyncedUid === uid) { detachChatSync(); attachChatSync(uid); } });
      return;
    }
    // Still refused: the sign-in is fine, the database rules say no. The server can read the same data, so use it.
    if (denied) return enterServerMode(uid);
    if (truxChatSyncWarned) return;
    truxChatSyncWarned = true;
    toast("Chat history can't reach the database right now.", "err");
  });
}

function metaOf(session) {
  const meta = {};
  for (const key of TRUX_META_FIELDS) {
    if (key === "pinned" || key === "archived") meta[key] = session[key] === true;
    else if (key === "notebookId") meta[key] = session.notebookId ? String(session.notebookId).slice(0, 80) : null;
    else meta[key] = String(session[key] || (key === "mode" ? "chat" : "New chat")).slice(0, key === "title" ? 120 : 20);
  }
  return meta;
}

/* Push local edits (rename, pin, archive, delete, removed messages) to RTDB.
   The UI keeps calling this after it mutates chatSessions, as before. */
function saveChatSessions() {
  queueSidebarSync();
  const uid = truxUid();
  if (!uid || uid !== truxSyncedUid || !rtdb) return;
  const updates = {};
  for (const [id, session] of Object.entries(chatSessions)) {
    if (!session || session.incognito) continue;
    const meta = metaOf(session);
    const remote = truxSyncedMeta[id];
    if (!remote) continue; // the server creates chat meta on the first turn
    for (const key of TRUX_META_FIELDS) {
      const remoteValue = key === "pinned" || key === "archived" ? remote[key] === true : (remote[key] ?? null);
      if (meta[key] !== remoteValue) updates[`chats/${id}/${key}`] = meta[key];
    }
    const seen = truxSyncedMessageIds[id];
    if (seen && session.messagesLoaded) {
      const present = new Set((session.messages || []).map(m => m.id).filter(Boolean));
      for (const msgId of seen) {
        if (!present.has(msgId)) { updates[`messages/${id}/${msgId}`] = null; updates[`thinking/${id}/${msgId}`] = null; seen.delete(msgId); }
      }
    }
  }
  /* Deleting a chat only hides it (deleted flag). Nothing is removed from the database;
     the owner can ask for real deletion by email. */
  for (const id of Object.keys(truxSyncedMeta)) {
    if (chatSessions[id]) continue;
    if (truxSyncedMeta[id]?.deleted !== true) {
      updates[`chats/${id}/deleted`] = true;
      updates[`chats/${id}/deletedAt`] = Date.now();
      truxSyncedMeta[id] = { ...truxSyncedMeta[id], deleted: true };
    }
    delete truxSyncedMessageIds[id];
    stopStreamWatcher(id);
  }
  if (Object.keys(updates).length) {
    const write = truxServerMode ? truxDataApi("chats", { updates }) : rtdb.ref(`users/${uid}`).update(updates);
    truxPendingSync = write.catch(error => {
      console.warn("TruX chat save failed", error?.message || error);
      toast("Couldn't sync that change. Check your connection.", "err");
    });
  }
}

/* RTDB message -> the shape the renderer expects. */
function clientMessageFromStored(id, m) {
  const media = Array.isArray(m.media) ? m.media : (m.media ? Object.values(m.media) : []);
  const attachments = Array.isArray(m.attachments) ? m.attachments : (m.attachments ? Object.values(m.attachments) : []);
  const sources = Array.isArray(m.sources) ? m.sources : (m.sources ? Object.values(m.sources) : []);
  return {
    id,
    role: m.role === "model" ? "trux" : "user",
    text: String(m.text || ""),
    attachments,
    media,
    sources,
    status: m.status || "done",
    error: m.error || "",
    incomplete: m.role === "model" && (m.status === "stopped" || m.status === "error"),
    createdAt: m.createdAt || 0,
    updatedAt: m.updatedAt || 0,
    activity: String(m.activity || ""),
    tools: Array.isArray(m.tools) ? m.tools : (m.tools ? Object.values(m.tools) : []),
    hasThinking: m.hasThinking === true
  };
}

/* "working" is the placeholder written while the server generates; "streaming" is what older versions stored. */
function isLiveStatus(status) { return status === "working" || status === "streaming"; }

/* The thinking summary of an answer, fetched only when the person opens it. */
async function loadStoredThinking(chatId, messageId) {
  if (!chatId || !messageId) return "";
  if (truxServerMode) return String((await truxDataApi("thinking?chatId=" + encodeURIComponent(chatId) + "&messageId=" + encodeURIComponent(messageId))).thinking || "");
  const snap = await userRef(`thinking/${chatId}/${messageId}`).get();
  return typeof snap.val() === "string" ? snap.val() : "";
}

/* Messages the UI removed (Resend, Regenerate): the server deletes them with the new turn, so just stop tracking them. */
function forgetMessageIds(chatId, ids) {
  const seen = truxSyncedMessageIds[chatId];
  if (seen) for (const id of ids) if (id) seen.delete(id);
}

async function loadChatMessages(chatId, { force = false } = {}) {
  const session = chatSessions[chatId];
  if (!session || session.incognito) return session?.messages || [];
  if (session.messagesLoaded && !force) return session.messages;
  const raw = truxServerMode
    ? (await truxDataApi("messages?chatId=" + encodeURIComponent(chatId))).messages || {}
    : (await userRef(`messages/${chatId}`).orderByKey().limitToLast(300).get()).val() || {};
  const ids = Object.keys(raw).sort();
  session.messages = ids.map(id => clientMessageFromStored(id, raw[id]));
  session.messagesLoaded = true;
  truxSyncedMessageIds[chatId] = new Set(ids);
  return session.messages;
}

function rememberMessageId(chatId, id) {
  if (!chatId || !id) return;
  (truxSyncedMessageIds[chatId] ||= new Set()).add(id);
}

/* Ask the server-side turn to stop. The server watches this flag. */
function requestServerStop(chatId, messageId) {
  if (!chatId || !messageId || !truxUid()) return Promise.resolve();
  if (truxServerMode) return truxDataApi("chats", { updates: { [`messages/${chatId}/${messageId}/stopRequested`]: true } }).catch(() => {});
  return userRef(`messages/${chatId}/${messageId}/stopRequested`).set(true).catch(() => {});
}

function stopStreamWatcher(chatId) {
  const off = truxStreamWatchers[chatId];
  if (off) { try { off(); } catch {} delete truxStreamWatchers[chatId]; }
}

/* Follow a reply that is still being generated by the server (after a refresh, on another device, or after the live
   stream dropped). While it is "working" the thinking bar says so and shows the tools it has used; when the finished
   answer lands it is revealed in place, continuing from whatever the live stream had already shown. */
const TRUX_STALE_BEAT_MS = 90 * 1000;          /* no heartbeat for this long: the server is gone */
const TRUX_STALE_ABS_MS = 10 * 60 * 1000;      /* an answer "working" for longer than this on first sight is left over from an old crash */

function watchStreamingMessage(chatId, messageId, row, { onSettled, getStreamer } = {}) {
  stopStreamWatcher(chatId);
  const ref = userRef(`messages/${chatId}/${messageId}`);
  const bubble = row?.querySelector(".bubble");
  const sid = row?.querySelector(".status-msg")?.id || "";
  const tsid = row?.querySelector(".trux-thinking-details")?.id || "";
  let settled = false;
  let lastMsg = null;
  let beat = { value: null, at: Date.now() };
  let staleTimer = null;
  let firstSight = true;

  const record = msg => {
    const session = chatSessions[chatId];
    if (!session?.messages) return;
    const idx = session.messages.findIndex(x => x.id === messageId);
    if (idx >= 0) session.messages[idx] = msg; else session.messages.push(msg);
  };

  const settle = msg => {
    if (settled) return;
    settled = true;
    clearInterval(staleTimer);
    stopStreamWatcher(chatId);
    record(msg);
    if (currentChatId !== chatId || !row?.isConnected) { onSettled?.(msg); return; }
    /* Reveal the finished text with the same renderer the live stream used (or a new one), so the words that were
       already on screen stay put and nothing is cleared and redrawn. */
    let streamer = null;
    try { streamer = getStreamer?.() || null; } catch {}
    if (msg.text && msg.status !== "error") {
      try {
        if (!streamer) { dismissThinkingPanel(row); bubble.classList.remove("thinking"); streamer = createStreamRenderer(bubble); }
        streamer.setText(msg.text);
        truxFinishReveal(streamer, msg.text, () => onSettled?.(msg));
        return;
      } catch {}
    }
    onSettled?.(msg);
  };

  const showProgress = msg => {
    if (getStreamer?.()) return;                    /* the answer is already being written on screen */
    if (sid) setThinkingStatus(sid, msg.activity || "TruX is working in the background…");
    if (tsid) for (const t of msg.tools || []) {
      if (t?.label) appendToolStatusLine(tsid, t.label, t.status === "running" ? "" : (t.status === "error" ? "Failed" : "Done"), t.status === "running" ? "start" : "complete", { id: t.id, ok: t.status !== "error" });
    }
  };

  const handler = snapshot => {
    if (settled) return;
    const m = snapshot.val();
    if (!m) return;
    const msg = clientMessageFromStored(messageId, m);
    lastMsg = msg;
    if (!isLiveStatus(msg.status)) { settle(msg); return; }
    const heartbeat = msg.updatedAt || msg.createdAt || 0;
    /* Left over from a server that died long ago: do not wait for it. */
    if (firstSight && heartbeat && Date.now() - heartbeat > TRUX_STALE_ABS_MS) { settle(staleMessage(msg)); return; }
    firstSight = false;
    if (heartbeat !== beat.value) beat = { value: heartbeat, at: Date.now() };
    record(msg);
    showProgress(msg);
  };

  /* A server that crashed leaves "working" behind. The heartbeat stops moving, so give up instead of waiting forever. */
  const staleMessage = msg => ({ ...(msg || { id: messageId, role: "trux", text: "" }), status: "error", error: "TruX lost this answer (the server stopped). Please retry.", incomplete: true });
  staleTimer = setInterval(() => {
    if (!settled && Date.now() - beat.at > TRUX_STALE_BEAT_MS) settle(staleMessage(lastMsg));
  }, 10000);

  if (truxServerMode) {
    const tick = async () => {
      try {
        const { messages } = await truxDataApi("messages?chatId=" + encodeURIComponent(chatId) + "&messageId=" + encodeURIComponent(messageId));
        if (messages?.[messageId]) handler({ val: () => messages[messageId] });
      } catch {}
    };
    const timer = setInterval(tick, 2000);
    truxStreamWatchers[chatId] = () => { clearInterval(timer); clearInterval(staleTimer); };
    void tick();
    return;
  }
  ref.on("value", handler);
  truxStreamWatchers[chatId] = () => { ref.off("value", handler); clearInterval(staleTimer); };
}
