/* Global bindings and startup. */
bindContextMenuAction("contextMenuShareBtn", id => { if(id) void shareChatConversation(id); });
bindContextMenuAction("contextMenuPinBtn", id => { if(id) togglePinChat(id); });
bindContextMenuAction("contextMenuMoveBtn", id => { if(id) openMoveChatToNotebook(id); });
bindContextMenuAction("contextMenuRemoveNotebookBtn", id => { if(id) removeChatFromNotebook(id); });
bindContextMenuAction("contextMenuRenameBtn", id => { if(id) renameChat(id); });
bindContextMenuAction("contextMenuHelpBtn", () => openChatHelp());
bindContextMenuAction("contextMenuFeedbackBtn", id => openConversationFeedback(id));
bindContextMenuAction("contextMenuIncognitoBtn", () => {
  if(incognitoMode) closeIncognitoChat();
  else launchIncognitoChat();
});
bindContextMenuAction("contextMenuDeleteBtn", id => {
  if(id) deleteChat(id);
  contextMenuTargetId = null;
});

addEventListener("click", e => {
  let ctx = getEl("contextMenu"); if(ctx && !ctx.contains(e.target)) closeChatContextMenu();
  let menu = getEl("attachmentMenu"); if(menu && !menu.contains(e.target) && !getEl("attachBtn").contains(e.target)) closeAttachmentMenu();
  let modelPicker = getEl("modelDropdown"), modelPickerBtn = getEl("modelPickerBtn"); if(modelPicker && modelPickerBtn && !modelPicker.contains(e.target) && !modelPickerBtn.contains(e.target)) closeModelDropdown();
});

getEl("promptInput").addEventListener("keydown", e => {
  if(e.key === "Enter" && !e.shiftKey) {
    let isMobile = window.innerWidth <= 768 || ('ontouchstart' in window && navigator.maxTouchPoints > 0);
    if(isMobile) return;
    e.preventDefault();
    handleActionButton();
  }
});

getEl("profileModal").addEventListener("click", e => { if(e.target === getEl("profileModal")) closeProfileModal(); });
getEl("sandboxModal")?.addEventListener("click", e => { if(e.target === getEl("sandboxModal")) closeSandboxModal(); });
getEl("pinnedModal")?.addEventListener("click", e => { if(e.target === getEl("pinnedModal")) closePinnedModal(); });
getEl("loginWallModal")?.addEventListener("click", e => { if(e.target === getEl("loginWallModal")) closeLoginWall(); });

addEventListener("keydown", e => { if(e.key === "Escape") { closeMediaLibrary(); closeProfileModal(); closeSettingsModal(); closeSandboxModal(); closePinnedModal(); closeLoginWall(); closeChatContextMenu(); closeSidebar(); closeModelDropdown(); closeAttachmentMenu(); } });


/* SETTINGS / PROFILE EVENT DELEGATION */
const settingsModalNode=getEl("profileModal");
if(settingsModalNode){
  settingsModalNode.addEventListener("click",function(event){
    const nav=event.target && event.target.closest ? event.target.closest("[data-settings-section]") : null;
    if(nav && settingsModalNode.contains(nav)){
      event.preventDefault();
      event.stopPropagation();
      switchSettingsSection(nav.getAttribute("data-settings-section"));
    }
  },true);
}

const profileModalNode=getEl("profileModal");
if(profileModalNode){
  profileModalNode.addEventListener("click",function(event){
    const route=event.target && event.target.closest ? event.target.closest("[data-profile-page]") : null;
    if(route && profileModalNode.contains(route)){
      event.preventDefault();
      event.stopPropagation();
      openProfileOption(route.getAttribute("data-profile-page"));
    }
  },true);
}

const startupWorkspaceMode = "chat";
try {
  currentChatId = null;
  document.body.classList.remove("chat-session-active","plugins-page-active");
  document.body.removeAttribute("data-media-mode");
  document.body.classList.add("home-active");
  restoreCachedUserUI();
  loadSettings();
  renderNotebooks();
  renderSidebar();
  updateAllUsageUI();
  handleInputChange();
  setWorkspaceMode(startupWorkspaceMode, {reload:false,preserveSession:false});
  
} catch (startupError) {
  window.__truxRecoverBoot(startupError);
} finally {
  window.__truxBootFinished = true;
  initFirebase().catch(error => {
    console.error("TruX sign-in setup failed", error);
    openLoginWall("signin");
    setLoginAuthMessage(error?.message || "Sign-in is unavailable right now.", "err");
    return false;
  }).then(ok => {
    if (ok === false) return;
    return (truxAuthStateReady || waitForTruxAuthState()).then(() => {
      if (!auth?.currentUser) openLoginWall("signin");
    });
  });
  document.body?.classList.remove("trux-boot-recovered");
}
