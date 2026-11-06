/* Chat list grouping, notebooks (local per device), context menu and sidebar rendering. */

/* Chat ids are "chat_<epoch ms>", so the timestamp is free - use it to
   group history the way every serious assistant UI does. */
function chatBucket(id) {
  let ms = chatTimestamp(id);
  if(!ms || Number.isNaN(ms)) return { rank: 3, label: "Earlier" };
  let start = new Date(); start.setHours(0, 0, 0, 0);
  let day = 864e5, diff = start.getTime() - ms;
  if(diff <= 0) return { rank: 0, label: "Today" };
  if(diff <= day) return { rank: 1, label: "Yesterday" };
  if(diff <= day * 7) return { rank: 2, label: "Previous 7 days" };
  return { rank: 3, label: "Earlier" };
}

function plainPreview(t) {
  return String(t || "")
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\|.*\|\s*$/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(-{3,}|\*{3,})\s*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

const TRUX_NOTEBOOKS_KEY = "trux_notebooks";

function getNotebooks() {
  const fallback = [{ id:"notebook_trux", title:"TruX-AI" }];
  const value = store.json(TRUX_NOTEBOOKS_KEY, null);
  return Array.isArray(value) ? value : fallback;
}

function getActiveNotebookId() {
  const active = store.getItem("trux_active_notebook");
  return getNotebooks().some(n => n && n.id === active) ? active : null;
}

function notebookIdForNewChat() {
  const notebooks = getNotebooks();
  const active = getActiveNotebookId();
  return active || (notebooks[0] && notebooks[0].id) || null;
}

function ensureNotebookAssignments() {
  const notebooks = getNotebooks();
  if(!notebooks.length) return false;
  const fallbackId = notebooks[0].id;
  let changed = false;
  Object.keys(chatSessions).forEach(id => {
    const chat = chatSessions[id];
    if(!chat || chat.incognito || chat.notebookUnassigned) return;
    if(!chat.notebookId || !notebooks.some(n => n && n.id === chat.notebookId)) {
      chat.notebookId = fallbackId;
      changed = true;
    }
  });
  if(changed) saveChatSessions();
  return changed;
}

function renderNotebooks() {
  const host = getEl("notebookList");
  if(!host) return;
  host.innerHTML = "";
  const activeId = getActiveNotebookId();
  getNotebooks().forEach(n => {
    const item = document.createElement("div");
    item.className = "notebook-item" + (n.id === activeId ? " active" : "");
    item.setAttribute("role","button");
    item.tabIndex = 0;
    item.setAttribute("aria-label","Open notebook " + n.title);
    item.setAttribute("aria-current", n.id === activeId ? "page" : "false");
    item.onclick = () => openNotebook(n.id);
    item.onkeydown = e => { if(e.key === "Enter" || e.key === " ") { e.preventDefault(); openNotebook(n.id); } };

    const icon = document.createElement("span");
    icon.className = "notebook-icon";
    icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5h8.5L18.5 9v10A1.5 1.5 0 0 1 17 20.5H5A1.5 1.5 0 0 1 3.5 19V6A1.5 1.5 0 0 1 5 4.5Z"/><path d="M13 4.5V9h5"/></svg>';

    const label = document.createElement("b");
    label.textContent = n.title;
    label.title = n.title;

    const del = document.createElement("button");
    del.type = "button";
    del.className = "notebook-delete";
    del.setAttribute("aria-label","Delete " + n.title);
    del.title = "Delete notebook";
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V5h6v2m-8 0 1 13h8l1-13M10 11v5M14 11v5"/></svg>';
    del.onclick = e => { e.preventDefault(); e.stopPropagation(); deleteNotebook(n.id); };

    item.append(icon, label, del);
    host.appendChild(item);
  });
  if(!host.children.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No notebooks yet. Create one to organize chats.";
    host.appendChild(empty);
  }
}

function createNotebook() {
  const title = prompt("Notebook name");
  const clean = String(title || "").trim().slice(0,60);
  if(!clean) return;
  const notebooks = getNotebooks();
  notebooks.push({ id:"notebook_" + Date.now(), title:clean });
  store.setItem(TRUX_NOTEBOOKS_KEY, JSON.stringify(notebooks));
  ensureNotebookAssignments();
  renderSidebar();
  toast("Notebook created.", "ok");
}

function deleteNotebook(id) {
  const notebook = getNotebooks().find(n => n && n.id === id);
  if(!notebook) return;
  if(!confirm("Delete " + JSON.stringify(notebook.title) + "? Chats will be kept and moved to another notebook when possible.")) return;

  const wasActive = store.getItem("trux_active_notebook") === id;
  const notebooks = getNotebooks().filter(n => n && n.id !== id);
  const replacementId = notebooks[0] ? notebooks[0].id : null;
  Object.keys(chatSessions).forEach(chatId => {
    const chat = chatSessions[chatId];
    if(!chat || chat.incognito || chat.notebookId !== id) return;
    if(replacementId) { chat.notebookId = replacementId; chat.notebookUnassigned = false; }
    else { delete chat.notebookId; chat.notebookUnassigned = true; }
  });
  store.setItem(TRUX_NOTEBOOKS_KEY, JSON.stringify(notebooks));
  if(wasActive && replacementId) store.setItem("trux_active_notebook", replacementId);
  else if(wasActive) store.removeItem("trux_active_notebook");

  saveChatSessions();
  renderSidebar();
  if(wasActive) {
    if(replacementId) openNotebook(replacementId);
    else {
      document.body.classList.remove("notebook-open");
      startNewChat();
    }
  } else if(document.body.classList.contains("notebook-open")) {
    renderNotebookWorkspace(getActiveNotebookId());
  }
  toast("Notebook deleted. Chats were kept.", "ok");
}

function renderNotebookWorkspace(id) {
  const host = getEl("notebookWorkspace");
  if(!host) return;
  ensureNotebookAssignments();
  const notebook = getNotebooks().find(n => n && n.id === id);
  if(!notebook) {
    host.innerHTML = '<div class="notebook-workspace-inner"><div class="notebook-empty"><strong>Notebook unavailable</strong>This notebook may have been deleted. Choose another notebook from the sidebar.</div></div>';
    return;
  }

  host.innerHTML = "";
  const inner = document.createElement("div");
  inner.className = "notebook-workspace-inner";

  const header = document.createElement("header");
  header.className = "notebook-workspace-head";
  const copy = document.createElement("div");
  copy.style.minWidth = "0";
  const eyebrow = document.createElement("div");
  eyebrow.className = "notebook-workspace-eyebrow";
  eyebrow.textContent = "Notebook";
  const title = document.createElement("h1");
  title.textContent = notebook.title;
  const description = document.createElement("p");
  description.textContent = "Chats saved here stay together. Open a conversation or start a new one in this notebook.";
  copy.append(eyebrow, title, description);

  const actions = document.createElement("div");
  actions.className = "notebook-workspace-actions";
  const newChat = document.createElement("button");
  newChat.type = "button";
  newChat.className = "notebook-primary-btn";
  newChat.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg><span>New chat here</span>';
  newChat.onclick = () => startNotebookChat(notebook.id);
  actions.appendChild(newChat);
  header.append(copy, actions);

  const list = document.createElement("div");
  list.className = "notebook-chat-list";
  const ids = Object.keys(chatSessions).filter(chatId => {
    const chat = chatSessions[chatId];
    return chat && !chat.incognito && chat.notebookId === notebook.id;
  }).reverse();

  if(!ids.length) {
    const empty = document.createElement("div");
    empty.className = "notebook-empty";
    const emptyTitle = document.createElement("strong");
    emptyTitle.textContent = "No chats in this notebook yet";
    const emptyText = document.createElement("div");
    emptyText.textContent = "Start a chat here, or move an existing conversation into this notebook from its chat menu.";
    const emptyAction = document.createElement("button");
    emptyAction.type = "button";
    emptyAction.className = "notebook-primary-btn";
    emptyAction.textContent = "Start a chat";
    emptyAction.onclick = () => startNotebookChat(notebook.id);
    empty.append(emptyTitle, emptyText, emptyAction);
    list.appendChild(empty);
  } else {
    ids.forEach(chatId => {
      const chat = chatSessions[chatId];
      const row = document.createElement("div");
      row.className = "nb-chat-row";

      const open = document.createElement("button");
      open.type = "button";
      open.className = "nb-chat-open";
      const chatTitle = document.createElement("span");
      chatTitle.className = "nb-chat-title";
      chatTitle.textContent = chat.title || "Untitled chat";
      const messages = Array.isArray(chat.messages) ? chat.messages : [];
      const lastMessage = messages.length ? messages[messages.length - 1] : null;
      const preview = document.createElement("span");
      preview.className = "nb-chat-preview";
      const previewText = String(lastMessage && lastMessage.text || "").replace(/\s+/g, " ").trim();
      preview.textContent = previewText || (messages.length ? "Conversation" : "Empty conversation");
      open.append(chatTitle, preview);
      open.onclick = () => loadChatSession(chatId);
      open.oncontextmenu = e => {
        e.preventDefault();
        showChatContextMenu(chatId, e.clientX, e.clientY);
      };

      const more = document.createElement("button");
      more.type = "button";
      more.className = "hist-menu-btn notebook-chat-menu";
      more.textContent = "⋮";
      more.setAttribute("aria-label", "Chat actions for " + (chat.title || "Untitled chat"));
      more.title = "Chat actions";
      more.onclick = e => {
        e.preventDefault();
        e.stopPropagation();
        const rect = more.getBoundingClientRect();
        showChatContextMenu(chatId, rect.right - 190, rect.bottom + 4);
      };
      row.append(open, more);
      list.appendChild(row);
    });
  }

  inner.append(header, list);
  host.appendChild(inner);
}

function openNotebook(id) {
  const notebook = getNotebooks().find(n => n && n.id === id);
  if(!notebook) return;
  store.setItem("trux_active_notebook", notebook.id);
  closeSidebar();
  getEl("contextMenu").style.display = "none";
  document.body.classList.remove("home-active","chat-session-active","plugins-page-active","incognito-mode");
  document.body.removeAttribute("data-media-mode");
  document.body.classList.add("notebook-open");
  const welcome = getEl("welcomeScreen");
  if(welcome) welcome.style.display = "none";
  renderNotebookWorkspace(notebook.id);
  renderSidebar();
}

function startNotebookChat(id) {
  const notebook = getNotebooks().find(n => n && n.id === id);
  if(!notebook) return;
  store.setItem("trux_active_notebook", notebook.id);
  document.body.classList.remove("notebook-open");
  startNewChat();
  toast("New chat will be saved to " + notebook.title + ".", "ok");
}

async function shareChatConversation(id) {
  const chat = chatSessions[id];
  if(!chat || chat.incognito) return;
  const title = chat.title || "Untitled chat";
  const transcript = (Array.isArray(chat.messages) ? chat.messages : []).map(message => {
    const text = String(message?.text || "").trim();
    if(!text) return "";
    return (message.role === "user" ? "You" : "TruX-Omni") + ":\n" + text;
  }).filter(Boolean).join("\n\n");
  const shareText = "TruX-Omni conversation: " + title + "\n\n" + (transcript || "This conversation has no text messages yet.");
  if(navigator.share) {
    try {
      await navigator.share({ title: title, text: shareText });
      toast("Share sheet opened.", "ok");
      return;
    } catch(error) {
      if(error?.name === "AbortError") return;
    }
  }
  try {
    if(!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(shareText);
    toast("Conversation copied. Paste it anywhere to share.", "ok");
  } catch(error) {
    prompt("Copy your conversation text to share it:", shareText);
  }
}

function togglePinChat(id) {
  const chat = chatSessions[id];
  if(!chat || chat.incognito) return;
  chat.pinned = !chat.pinned;
  saveChatSessions(id);
  renderSidebar();
  if(document.body.classList.contains("notebook-open")) renderNotebookWorkspace(getActiveNotebookId());
  toast(chat.pinned ? "Chat pinned to the top of Recent." : "Chat unpinned.", "ok");
}

function renameChat(id) {
  const chat = chatSessions[id];
  if(!chat || chat.incognito) return;
  const nextTitle = prompt("Rename conversation", chat.title || "Untitled chat");
  if(nextTitle === null) return;
  const cleanTitle = String(nextTitle).trim().slice(0, 80);
  if(!cleanTitle) return toast("Chat title cannot be empty.", "err");
  chat.title = cleanTitle;
  saveChatSessions(id);
  renderSidebar();
  if(document.body.classList.contains("notebook-open")) renderNotebookWorkspace(getActiveNotebookId());
  toast("Conversation renamed.", "ok");
}

function removeChatFromNotebook(id) {
  const chat = chatSessions[id];
  if(!chat || chat.incognito || !chat.notebookId) return;
  const notebook = getNotebooks().find(item => item && item.id === chat.notebookId);
  delete chat.notebookId;
  chat.notebookUnassigned = true;
  saveChatSessions(id);
  closeChatContextMenu();
  renderSidebar();
  if(document.body.classList.contains("notebook-open")) renderNotebookWorkspace(getActiveNotebookId());
  toast('Removed "' + (chat.title || "Untitled chat") + '" from ' + (notebook?.title || "the notebook") + ". The chat is still in Recent.", "ok");
}

function openChatHelp() {
  closeChatContextMenu();
  const oldHelp = getEl("chatHelpModal");
  if (oldHelp) oldHelp.style.display = "none";
  closeSettingsModal();
  const profileModal = getEl("profileModal");
  if (!profileModal) return toast("The Help page could not be opened. Please refresh TruX and try again.", "err");
  closeProfileOption();
  profileModal.style.display = "flex";
  openProfileOption("help");
}

function closeChatHelp() {
  const modal = getEl("chatHelpModal");
  if(modal) modal.style.display = "none";
}

function openConversationFeedback(id) {
  closeChatContextMenu();
  const chat = id && chatSessions[id] && !chatSessions[id].incognito ? chatSessions[id] : null;
  openChatHelp();
  setTimeout(() => {
    const body = getEl("profileDetailBody");
    const section = body?.querySelector("#helpFeedbackSection");
    if (!section) return;
    const subjectField = section.querySelector('[name="subject"]');
    if (chat && subjectField && !subjectField.value.trim()) {
      subjectField.value = 'Feedback about "' + (chat.title || "Untitled chat") + '"';
    }
    section.scrollIntoView({ behavior: "smooth", block: "start" });
    section.querySelector('[name="message"]')?.focus({ preventScroll: true });
  }, 0);
}

function closeChatContextMenu() {
  const menu = getEl("contextMenu");
  if(menu) menu.style.display = "none";
  getEl("topbarMoreBtn")?.setAttribute("aria-expanded", "false");
}

function toggleTopbarMoreMenu(event) {
  event?.preventDefault();
  event?.stopPropagation();
  const menu = getEl("contextMenu");
  if(menu && menu.style.display === "block" && menu.dataset.source === "topbar") {
    closeChatContextMenu();
    return;
  }
  const onNonChatPage = document.body.classList.contains("home-active") ||
    document.body.classList.contains("notebook-open") ||
    document.body.hasAttribute("data-media-mode") ||
    document.body.classList.contains("plugins-page-active");
  showChatContextMenu(onNonChatPage ? null : currentChatId, 0, 0, "topbar");
}

function showChatContextMenu(id, x, y, source) {
  source = source || "chat";
  const menu = getEl("contextMenu");
  if(!menu) return;
  const candidate = id && chatSessions[id];
  const chat = candidate && !candidate.incognito ? candidate : null;
  if(source !== "topbar" && !chat) return;
  contextMenuTargetId = chat ? id : null;
  menu.dataset.source = source;

  const hasChat = !!chat;
  const hasNotebook = !!(chat && chat.notebookId && getNotebooks().some(notebook => notebook && notebook.id === chat.notebookId));
  ["contextMenuShareBtn","contextMenuPinBtn","contextMenuMoveBtn","contextMenuRenameBtn","contextMenuDeleteBtn"].forEach(actionId => {
    const action = getEl(actionId);
    if(action) action.style.display = hasChat ? "flex" : "none";
  });
  const removeNotebook = getEl("contextMenuRemoveNotebookBtn");
  if(removeNotebook) removeNotebook.style.display = hasNotebook ? "flex" : "none";
  const pinLabel = getEl("contextMenuPinBtn")?.querySelector(".context-label");
  if(pinLabel) pinLabel.textContent = chat?.pinned ? "Unpin" : "Pin";
  const incognitoLabel = getEl("contextMenuIncognitoBtn")?.querySelector(".context-label");
  if(incognitoLabel) incognitoLabel.textContent = source === "topbar" && incognitoMode ? "Exit incognito chat" : "New incognito chat";
  menu.style.display = "block";
  const width = menu.offsetWidth || 258;
  const height = menu.offsetHeight || 360;
  let left = Number(x) || 8;
  let top = Number(y) || 8;
  if(source === "topbar") {
    const button = getEl("topbarMoreBtn");
    const rect = button?.getBoundingClientRect();
    if(rect) {
      left = rect.right - width;
      top = rect.bottom + 7;
      if(top + height > innerHeight - 8) top = rect.top - height - 7;
    }
  }
  menu.style.left = Math.max(8, Math.min(left, innerWidth - width - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(top, innerHeight - Math.min(height, innerHeight - 16) - 8)) + "px";
  getEl("topbarMoreBtn")?.setAttribute("aria-expanded", source === "topbar" ? "true" : "false");
}

function openMoveChatToNotebook(chatId) {
  const chat = chatSessions[chatId];
  if(!chat || chat.incognito) return;
  ensureNotebookAssignments();
  notebookMoveTargetId = chatId;
  const host = getEl("notebookMoveChoices");
  const subtitle = getEl("notebookMoveSubtitle");
  if(subtitle) subtitle.textContent = 'Choose a notebook for "' + (chat.title || "Untitled chat") + '".';
  if(host) {
    host.innerHTML = "";
    const notebooks = getNotebooks();
    notebooks.forEach(notebook => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "notebook-choice" + (chat.notebookId === notebook.id ? " current" : "");
      const icon = document.createElement("span");
      icon.className = "notebook-choice-icon";
      icon.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4.5h8.5L18.5 9v10A1.5 1.5 0 0 1 17 20.5H5A1.5 1.5 0 0 1 3.5 19V6A1.5 1.5 0 0 1 5 4.5Z"/><path d="M13 4.5V9h5"/></svg>';
      const copy = document.createElement("span");
      copy.className = "notebook-choice-copy";
      const title = document.createElement("span");
      title.className = "notebook-choice-title";
      title.textContent = notebook.title;
      const count = Object.keys(chatSessions).filter(id => {
        const item = chatSessions[id];
        return item && !item.incognito && item.notebookId === notebook.id;
      }).length;
      const meta = document.createElement("span");
      meta.className = "notebook-choice-meta";
      meta.textContent = count + (count === 1 ? " chat" : " chats") + (chat.notebookId === notebook.id ? " · Current notebook" : "");
      copy.append(title, meta);
      button.append(icon, copy);
      button.onclick = () => moveChatToNotebook(chatId, notebook.id);
      host.appendChild(button);
    });
    if(!notebooks.length) {
      const empty = document.createElement("div");
      empty.className = "notebook-choice-empty";
      empty.textContent = "There are no notebooks yet. Create one from the sidebar, then move this chat.";
      const create = document.createElement("button");
      create.type = "button";
      create.className = "notebook-primary-btn";
      create.textContent = "Create notebook";
      create.onclick = () => { closeNotebookMoveModal(); createNotebook(); };
      host.append(empty, create);
    }
  }
  const modal = getEl("notebookMoveModal");
  if(modal) {
    modal.classList.add("active");
    modal.setAttribute("aria-hidden","false");
  }
}

function closeNotebookMoveModal() {
  const modal = getEl("notebookMoveModal");
  if(modal) {
    modal.classList.remove("active");
    modal.setAttribute("aria-hidden","true");
  }
  notebookMoveTargetId = null;
}

function moveChatToNotebook(chatId, notebookId) {
  const chat = chatSessions[chatId];
  const notebook = getNotebooks().find(n => n && n.id === notebookId);
  if(!chat || chat.incognito || !notebook) return closeNotebookMoveModal();
  const previousNotebookId = chat.notebookId;
  chat.notebookId = notebook.id;
  chat.notebookUnassigned = false;
  saveChatSessions(chatId);
  closeNotebookMoveModal();
  renderSidebar();
  if(document.body.classList.contains("notebook-open")) {
    renderNotebookWorkspace(getActiveNotebookId());
  }
  if(previousNotebookId === notebook.id) toast("This chat is already in " + notebook.title + ".", "ok");
  else toast('Moved "' + (chat.title || "Untitled chat") + '" to ' + notebook.title + ".", "ok");
}

function renderSidebar() {
  ensureNotebookAssignments();
  renderNotebooks();
  let hL = getEl("historyList"); if(!hL) return;
  let q = (getEl("historySearch")?.value || "").trim().toLowerCase();
  let ids = Object.keys(chatSessions).filter(id => !chatSessions[id]?.incognito).reverse();
  if(q) ids = ids.filter(id => (chatSessions[id]?.title || "").toLowerCase().includes(q));

  hL.innerHTML = "";
  if(!ids.length) {
    if(q) {
      hL.innerHTML = '<div class="empty">No chats match <b>' + escapeHtml(q) + '</b>.</div>';
    } else {
      hL.innerHTML = '<div class="empty">Your chats will appear here.<br>Start a new chat to begin.</div>';
    }
    return;
  }

  let lastLabel = null;
  ids.sort((a, b) => {
    const pinOrder = Number(!!chatSessions[b]?.pinned) - Number(!!chatSessions[a]?.pinned);
    return pinOrder || chatBucket(a).rank - chatBucket(b).rank || chatTimestamp(b) - chatTimestamp(a);
  });
  ids.forEach(id => {
    let label = chatSessions[id]?.pinned ? "Pinned" : chatBucket(id).label;
    if(label !== lastLabel) {
      let h = document.createElement("div"); h.className = "history-head"; h.textContent = label;
      hL.appendChild(h); lastLabel = label;
    }
    const row = document.createElement("div");
    row.className = "hist-row";

    const x = document.createElement("div");
    x.className = "hist" + (id === currentChatId ? " active" : "");
    x.textContent = chatSessions[id].title || "Untitled chat";
    x.title = chatSessions[id].title || "Untitled chat";
    x.setAttribute("role","button");
    x.tabIndex = 0;
    x.onclick = () => loadChatSession(id);
    x.onkeydown = e => { if(e.key === "Enter" || e.key === " ") { e.preventDefault(); loadChatSession(id); } };
    x.oncontextmenu = e => { e.preventDefault(); showChatContextMenu(id, e.clientX, e.clientY); };

    const more = document.createElement("button");
    more.type = "button";
    more.className = "hist-menu-btn";
    more.textContent = "⋯";
    more.setAttribute("aria-label", "Chat actions for " + (chatSessions[id].title || "Untitled chat"));
    more.title = "Move or delete chat";
    more.onclick = e => {
      e.preventDefault();
      e.stopPropagation();
      const rect = more.getBoundingClientRect();
      showChatContextMenu(id, rect.right - 190, rect.bottom + 4);
    };
    row.append(x, more);
    hL.appendChild(row);
  });
}
function enterChatWorkspace() {
  const body = document.body, welcomeForExit = getEl("welcomeScreen");
  const leavingHome = body.classList.contains("home-active") && !!welcomeForExit;
  if (leavingHome) {
    const rect = welcomeForExit.getBoundingClientRect();
    if (window.__truxHomeExitTimer) clearTimeout(window.__truxHomeExitTimer);
    body.classList.remove("home-exiting-fade"); body.classList.add("home-exiting");
    welcomeForExit.style.setProperty("--trux-home-exit-left", rect.left + "px"); welcomeForExit.style.setProperty("--trux-home-exit-top", rect.top + "px");
    welcomeForExit.style.setProperty("--trux-home-exit-width", rect.width + "px"); welcomeForExit.style.setProperty("--trux-home-exit-height", rect.height + "px");
    welcomeForExit.style.removeProperty("opacity"); welcomeForExit.style.removeProperty("transform"); void welcomeForExit.offsetWidth;
    requestAnimationFrame(() => requestAnimationFrame(() => { if (body.classList.contains("home-exiting")) body.classList.add("home-exiting-fade"); }));
    window.__truxHomeExitTimer = setTimeout(() => {
      const returnedHome = body.classList.contains("home-active"); body.classList.remove("home-exiting", "home-exiting-fade");
      ["--trux-home-exit-left", "--trux-home-exit-top", "--trux-home-exit-width", "--trux-home-exit-height"].forEach(property => welcomeForExit.style.removeProperty(property));
      welcomeForExit.style.removeProperty("opacity"); welcomeForExit.style.removeProperty("transform");
      if (returnedHome) welcomeForExit.style.removeProperty("display"); else welcomeForExit.style.setProperty("display", "none");
      window.__truxHomeExitTimer = null;
    }, 1050);
  }
  body.classList.remove("home-active"); body.classList.add("chat-session-active"); body.removeAttribute("data-media-mode");
  const welcome = getEl("welcomeScreen"); if (welcome) welcome.style.display = "none";
  const active = getEl("chatContainer"); if (active) { active.style.display = "block"; active.classList.add("chat-session-view"); }
  return active;
}


function bindContextMenuAction(id, handler) {
  const item = getEl(id);
  if(!item) return;
  const activate = event => {
    event?.preventDefault();
    event?.stopPropagation();
    const targetId = contextMenuTargetId;
    closeChatContextMenu();
    handler(targetId);
  };
  item.onclick = activate;
  item.onkeydown = event => {
    if(event.key === "Enter" || event.key === " ") activate(event);
  };
}
