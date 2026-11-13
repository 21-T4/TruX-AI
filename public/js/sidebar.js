/* Pins, sidebar, scrolling and composer input handling. */
function pinInsight(text) {
  if(pinnedInsights.includes(text)) return toast("That insight is already pinned.");
  pinnedInsights.push(text);
  store.setItem("trux_pinned", JSON.stringify(pinnedInsights));
  toast("Pinned to insights.", "ok");
}
function openPinnedInsightsModal() {
  let list = getEl("pinnedList");
  if(!pinnedInsights.length) {
    list.innerHTML = '<div class="empty">No pinned insights yet.<br>Use <b>Pin</b> on any answer to save it here.</div>';
  } else {
    list.innerHTML = pinnedInsights.map((t, idx) => {
      let clean = plainPreview(t);
      return `<div class="pin-card"><p>${escapeHtml(clean.slice(0, 190))}${clean.length > 190 ? "…" : ""}</p><button class="pin-remove" onclick="removePinnedInsight(${idx})">${ICON.trash}Remove</button></div>`;
    }).join('');
  }
  showOverlay(getEl("pinnedModal"));
}
function removePinnedInsight(idx) {
  pinnedInsights.splice(idx, 1);
  store.setItem("trux_pinned", JSON.stringify(pinnedInsights));
  openPinnedInsightsModal();
}
function closePinnedModal() { hideOverlay(getEl("pinnedModal")); }

function setSidebarOpen(open) {
  const s = getEl("sidebarNode"), overlay = getEl("sidebarOverlay");
  if(!s) return;
  s.classList.toggle("open", !!open);
  overlay?.classList.toggle("active", !!open);
  document.body.classList.toggle("sidebar-open", !!open);
}

function toggleSidebar(e) {
  if(e) e.stopPropagation();
  const s = getEl("sidebarNode");
  setSidebarOpen(!s?.classList.contains("open"));
}

function closeSidebar() {
  setSidebarOpen(false);
  closeSidebarChatSearch();
}

function syncMobileSidebarState() {
  const s = getEl("sidebarNode"), overlay = getEl("sidebarOverlay");
  if(!s || !overlay) return;
  const open = s.classList.contains("open");
  overlay.classList.toggle("active", open);
  document.body.classList.toggle("sidebar-open", open);
}
addEventListener("resize", syncMobileSidebarState);

function focusSidebarChatSearch() {
  const wrap = getEl("sidebarSearchWrap"), input = getEl("historySearch");
  if(!wrap || !input) return;
  wrap.hidden = false;
  requestAnimationFrame(() => input.focus());
}

function closeSidebarChatSearch() {
  const wrap = getEl("sidebarSearchWrap"), input = getEl("historySearch");
  if(!wrap) return;
  wrap.hidden = true;
  if(input && input.value) { input.value = ""; renderSidebar(); }
}

function bindChatScroll(container) {
  container?.addEventListener("scroll", function() {
    if(this !== getActiveChatContainer()) return;
    isScrolledUp = (this.scrollHeight - this.scrollTop - this.clientHeight) > 80;
    getEl("scrollDownBtn").classList.toggle("visible", isScrolledUp && this.children.length > 0);
    document.body.classList.toggle("scrolled", this.scrollTop > 4);
  });
}
bindChatScroll(getEl("chatContainer"));

function scrollToBottom() {
  const container = getActiveChatContainer();
  container?.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  getEl("scrollDownBtn").classList.remove("visible");
}

function detectCodeInInput(text) {
  if (!text) return false;
  let hasCodeBlock = text.includes("```");
  let hasCodePattern = /function\s*\w*\(|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|class\s+\w+|import\s+.*from|def\s+\w+\(|<html|<div|public\s+class|select\s+.*from/i.test(text);
  let isLongStructure = text.split('\n').length > 5 || text.length > 280;
  return hasCodeBlock || (hasCodePattern && isLongStructure);
}

function shouldAttachPastedText(text) {
  return !!text && (text.split(/\r\n|\r|\n|\u2028|\u2029/).length > 15 || detectCodeInInput(text));
}

function getPasteText(e) {
  try {
    const clip = e?.clipboardData || e?.dataTransfer || window.clipboardData;
    return clip?.getData?.("text/plain") || clip?.getData?.("text") || "";
  } catch (_) {
    return "";
  }
}

/* Long paste handling:
   On Android the paste event's clipboardData can be empty, while
   beforeinput/input still exposes the actual edit. Keep the pre-paste
   value and recover the inserted text from the resulting textarea value. */
let pendingPromptPaste = null;

getEl("promptInput").addEventListener("beforeinput", e => {
  if(e.inputType !== "insertFromPaste") return;

  const p = e.target;
  const text = getPasteText(e);

  if(shouldAttachPastedText(text)) {
    e.preventDefault();
    pendingPromptPaste = null;
    attachCodeAsFile(text);
    return;
  }

  const start = typeof p.selectionStart === "number" ? p.selectionStart : p.value.length;
  const end = typeof p.selectionEnd === "number" ? p.selectionEnd : start;
  pendingPromptPaste = {
    value: p.value,
    start,
    end,
    timer: setTimeout(() => { pendingPromptPaste = null; }, 1000)
  };
});

getEl("promptInput").addEventListener("paste", e => {
  const p = e.target;
  const text = getPasteText(e);

  if(shouldAttachPastedText(text)) {
    e.preventDefault();
    if(pendingPromptPaste?.timer) clearTimeout(pendingPromptPaste.timer);
    pendingPromptPaste = null;
    attachCodeAsFile(text);
    return;
  }

  /* Some mobile WebViews fire paste but expose no clipboard payload.
     Capture the pre-paste selection here so the following input event
     can recover the inserted text from the textarea itself. */
  if(!text && !pendingPromptPaste) {
    const start = typeof p.selectionStart === "number" ? p.selectionStart : p.value.length;
    const end = typeof p.selectionEnd === "number" ? p.selectionEnd : start;
    pendingPromptPaste = {
      value: p.value,
      start,
      end,
      timer: setTimeout(() => { pendingPromptPaste = null; }, 1000)
    };
  }
});

/* Final fallback: some Android keyboards/WebViews expose paste only as
   a normal "input" edit. Compare the value before and after every input,
   so long pasted text is caught even when paste/beforeinput contain no
   clipboard data at all. */
let lastPromptInputValue = getEl("promptInput").value || "";

getEl("promptInput").addEventListener("input", e => {
  const p = e.target;
  const current = p.value;
  const pending = pendingPromptPaste;

  if(pending) {
    if(pending.timer) clearTimeout(pending.timer);
    pendingPromptPaste = null;

    const before = pending.value;
    const start = pending.start;
    const end = pending.end;
    const insertedLength = Math.max(0, current.length - before.length + (end - start));
    const inserted = current.slice(start, start + insertedLength);

    if(shouldAttachPastedText(inserted)) {
      p.value = before;
      lastPromptInputValue = before;
      attachCodeAsFile(inserted);
      handleInputChange();
      return;
    }
  }

  const before = lastPromptInputValue;
  lastPromptInputValue = current;

  if(!current || current === before) return;

  /* When the composer was empty, the whole new value is the inserted
     paste. This is the common Android case that the earlier fallback
     accidentally skipped. */
  let prefix = 0;
  const maxPrefix = Math.min(before.length, current.length);
  while(prefix < maxPrefix && before.charCodeAt(prefix) === current.charCodeAt(prefix)) prefix++;

  let suffix = 0;
  const maxSuffix = Math.min(before.length - prefix, current.length - prefix);
  while(suffix < maxSuffix &&
        before.charCodeAt(before.length - 1 - suffix) === current.charCodeAt(current.length - 1 - suffix)) suffix++;

  const inserted = current.slice(prefix, current.length - suffix);

  if(shouldAttachPastedText(inserted)) {
    p.value = before;
    lastPromptInputValue = before;
    attachCodeAsFile(inserted);
    handleInputChange();
  }
});

function attachCodeAsFile(text) {
  if(!text) return;
  let id = Date.now() + Math.floor(Math.random() * 1000);
  let cleanFirstLine = text.trim().split(/\r?\n/)[0].substring(0, 28).replace(/```/g, '');
  let fileType = /<html|<div/i.test(text) ? "HTML Code" : (/function|const|let|var|def|class\s/i.test(text) ? "Source Code" : "Text Attachment");
  let snippet = `${fileType}: ${cleanFirstLine || "Pasted content"}…`;
  pastedTextBlocks.push({ id, name: `pasted-${pastedTextBlocks.length + 1}.txt`, text, snippet });
  renderFileChips();
  handleInputChange();
}

function updateComposerAttachments() {
  const tray = getEl("composerAttachments");
  const hasFiles = pastedTextBlocks.length > 0 || fileAttachments.length > 0;
  const hasImage = !!getEl("imagePreviewContainer")?.classList.contains("visible");
  if (tray) tray.classList.toggle("has-items", hasFiles || hasImage);
}
function renderFileChips() {
  let c = getEl("chipContainer");
  let all = pastedTextBlocks.concat(fileAttachments);
  if(!all.length) { c.style.display = "none"; c.innerHTML = ""; updateComposerAttachments(); return; }
  c.style.display = "flex";
  c.innerHTML = all.map(b => {
    const label = b.processing ? (b.name || "Attachment") + " · Processing…" : (b.snippet || (b.name || "Attachment") + " · " + Math.ceil((b.size || (b.text || "").length) / 1024) + " KB");
    return `<div class="file-chip"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10A1.5 1.5 0 0 0 18.5 19V8L14 3.5Z"/><path d="M13.5 4v4.5H18"/></svg> ${escapeHtml(label)} <button type="button" aria-label="Remove attachment" onclick="removeFileChip(${b.id})">×</button></div>`;
  }).join('');
  updateComposerAttachments();
}
function removeFileChip(id) {
  pastedTextBlocks = pastedTextBlocks.filter(b => b.id !== id);
  fileAttachments = fileAttachments.filter(b => b.id !== id);
  renderFileChips();
  handleInputChange();
}

let sidebarSyncTimer = null;
function queueSidebarSync() {
  clearTimeout(sidebarSyncTimer);
  sidebarSyncTimer = setTimeout(() => {
    try {
      renderSidebar();
      if(document.body.classList.contains("notebook-open")) renderNotebookWorkspace(getActiveNotebookId());
    } catch (e) { /* ignore */ }
  }, 120);
}
