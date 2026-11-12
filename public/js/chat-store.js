/* Chat storage on Firebase Realtime Database.
 *
 *   users/{uid}/chats/{chatId}            chat metadata (sidebar list)
 *   users/{uid}/messages/{chatId}/{msgId} messages, written by the server
 *
 * `chatSessions` stays the in-memory model the UI already uses. The chat list
 * is live-synced; messages load lazily when a chat opens. The server writes
 * every turn as it streams, so a reply keeps generating on Vertex AI even if
 * this tab closes, and reopening the chat picks up the stored text and any
 * still-streaming reply.
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
        if (!present.has(msgId)) { updates[`messages/${id}/${msgId}`] = null; seen.delete(msgId); }
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
    createdAt: m.createdAt || 0
  };
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

/* Follow a reply that is still being generated (after a refresh, on another
   device, or after the live stream dropped). Updates the row in place. */
function watchStreamingMessage(chatId, messageId, row, { onSettled } = {}) {
  stopStreamWatcher(chatId);
  const ref = userRef(`messages/${chatId}/${messageId}`);
  const bubble = row?.querySelector(".bubble");
  let lastText = null;
  let raf = 0;
  const handler = snapshot => {
    const m = snapshot.val();
    if (!m) return;
    const msg = clientMessageFromStored(messageId, m);
    const session = chatSessions[chatId];
    if (session?.messages) {
      const idx = session.messages.findIndex(x => x.id === messageId);
      if (idx >= 0) session.messages[idx] = msg; else session.messages.push(msg);
    }
    if (bubble && msg.text !== lastText && currentChatId === chatId) {
      lastText = msg.text;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const container = getActiveChatContainer();
        const stick = container ? isNearBottom(container) : false;
        bubble.innerHTML = renderFormattedText(msg.text || "", false);
        if (stick && container) container.scrollTop = container.scrollHeight;
      });
    }
    if (msg.status !== "streaming") {
      stopStreamWatcher(chatId);
      onSettled?.(msg);
    }
  };
  if (truxServerMode) {
    const tick = async () => {
      try {
        const { messages } = await truxDataApi("messages?chatId=" + encodeURIComponent(chatId));
        if (messages?.[messageId]) handler({ val: () => messages[messageId] });
      } catch {}
    };
    const timer = setInterval(tick, 1200);
    truxStreamWatchers[chatId] = () => clearInterval(timer);
    void tick();
    return;
  }
  ref.on("value", handler);
  truxStreamWatchers[chatId] = () => ref.off("value", handler);
}
