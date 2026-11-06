/* Settings and profile modal, chat history actions, sign-out, code sandbox. */

async function checkApiLatency() {
  let t = performance.now();
  try { await fetch("/healthz", { cache: "no-store" }); toast(`Backend reachable - ${Math.round(performance.now() - t)} ms`, "ok"); } catch { toast("Backend check failed.", "err"); }
}

function clearAllHistory() {
  if (!confirm("Delete all chats from your account on every device? This cannot be undone.")) return;
  saveChatSessions();
  chatSessions = {};
  currentChatId = null;
  startNewChat();
  closeSettingsModal();
  renderSidebar();
  toast("Current session chat history cleared.", "ok");
}

async function handleAuthAction() {
  if (!truxAuthStateReady) {
    const restoredUser = await waitForTruxAuthState();
    if (restoredUser === undefined && !truxAuthStateReady) {
      toast("Your sign-in session is still loading. Please try again.", "err");
      return;
    }
  }
  if (!auth?.currentUser) return openLoginWall();
  closeProfileOption();
  const user = auth.currentUser;
  updateTruxProfileUI(user);
  const plan = getEl("profilePlanText");
  if(plan) plan.innerText = isTruxDeveloper(user) ? "Owner" : (currentPlanTier === "pro" ? "Pro" : "Core");
  const model = getEl("profileModelText"); if(model) model.innerText = "Auto";
  const limit = getEl("profileLimitText"); if(limit) limit.innerText = "Unlimited";
  const modal = getEl("profileModal");
  if(modal){ modal.removeAttribute("data-settings-view"); modal.style.display = "flex"; modal.setAttribute("aria-hidden","false"); }
  void refreshTruxProfileInfo(user);
}
function closeProfileModal() {
  const modal=getEl("profileModal");
  if(!modal) return;
  modal.style.display="none";
  modal.removeAttribute("data-settings-view");
  modal.setAttribute("aria-hidden","true");
  closeProfileOption();
}
function switchSettingsSection(name) {
  if (String(name || "") === "home") { showSettingsHome(); return; }
  const validSections = ["general","appearance","voice","personalization","usage","data","account","developer"];
  const requested = String(name || "general");
  const hasSection = validSections.includes(requested) &&
    Array.from(document.querySelectorAll("[data-settings-content]")).some(section => section.getAttribute("data-settings-content") === requested);
  const activeSection = hasSection ? requested : "general";
  const settingsModal = getEl("profileModal");
  if (settingsModal) settingsModal.dataset.settingsView = "section";
  document.querySelectorAll("[data-settings-content]").forEach(section => {
    section.classList.toggle("active", section.getAttribute("data-settings-content") === activeSection);
  });
  document.querySelectorAll(".settings-nav button[data-settings-section]").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-settings-section") === activeSection);
  });
  const scroller = document.querySelector(".settings-main-scroll");
  if (scroller) scroller.scrollTop = 0;
  const mobileSelect=getEl("settingsMobileSelect"); if(mobileSelect) mobileSelect.value=activeSection;
  if (activeSection === "developer" && isTruxDeveloper(auth?.currentUser)) {
    void loadOwnerGeminiModels(false);
  }
}
function showSettingsHome() {
  closeSettingsModal();
}
function handleSettingsBack() {
  const modal = getEl("profileModal");
  if (modal && modal.dataset.settingsView === "section") {
    showSettingsHome();
    return;
  }
  closeSettingsModal();
}
function openSettingsModal(section) {
  const modal = getEl("profileModal");
  if (!modal) {
    toast("Settings could not load. Please refresh TruX and try again.", "err");
    return;
  }
  modal.style.display = "flex";
  modal.setAttribute("aria-hidden", "false");
  const requested = String(section || "home");
  try {
    if (requested === "home") closeSettingsModal();
    else switchSettingsSection(requested);
  } catch (error) {
    console.error("TruX Settings navigation failed:", error);
    try { showSettingsHome(); } catch {}
  }
  try { updateAllUsageUI(); } catch (error) { console.warn("Settings usage refresh deferred:", error); }
  try { loadSettings(); } catch (error) { console.warn("Settings preferences refresh deferred:", error); }
  try { updateLocationSettingUI(); } catch (error) { console.warn("Settings location refresh deferred:", error); }
  try { updateNotificationSettingsUI(); } catch (error) { console.warn("Settings notifications refresh deferred:", error); }
}
function closeSettingsModal() {
  const modal = getEl("profileModal");
  if (!modal) return;
  modal.removeAttribute("data-settings-view");
  modal.setAttribute("aria-hidden", "false");
  const scroller = document.querySelector(".settings-main-scroll");
  if (scroller) scroller.scrollTop = 0;
  closeProfileOption();
}
function confirmSignOut() { truxSignOut().then(() => { closeProfileModal(); closeSettingsModal?.(); openLoginWall("signin"); }); }

function openCodeSandbox(codeId, extension) {
  const source = getEl(codeId);
  const frame = getEl("sandboxFrame");
  const codeText = source?.value || "";
  if (!source || !frame) return;

  // Preview runs in an opaque-origin iframe: scripts can run, but they
  // cannot read the parent app's DOM, Firebase session, or local storage.
  frame.setAttribute("sandbox", "allow-scripts");
  const ext = String(extension || source.dataset.extension || "html").toLowerCase();
  if (ext === "js") {
    // A bare JS code block is not an HTML document. Wrap it so the Run
    // button truly executes it and surfaces console output/runtime errors.
    const safeScript = codeText.replace(/<\/script/gi, "<\\/script");
    frame.srcdoc = [
      '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
      '<style>html,body{margin:0;min-height:100%;}body{box-sizing:border-box;padding:12px;font:13px/1.45 system-ui,sans-serif;color:#202124;background:#fff}#trux-preview-console{margin-top:12px;padding:8px;white-space:pre-wrap;overflow-wrap:anywhere;border-radius:8px;background:#f1f2f4;color:#41444b;font:12px/1.5 ui-monospace,monospace}#trux-preview-console:empty{display:none}</style></head><body>',
      '<pre id="trux-preview-console" aria-live="polite"></pre>',
      '<script>(function(){var out=document.getElementById("trux-preview-console");var fmt=function(v){try{return typeof v==="string"?v:JSON.stringify(v)}catch(e){return String(v)}};["log","info","warn","error"].forEach(function(key){var native=console[key].bind(console);console[key]=function(){native.apply(console,arguments);var line=Array.from(arguments).map(fmt).join(" ");out.textContent+=(out.textContent?"\\n":"")+line;};});window.addEventListener("error",function(e){out.textContent+=(out.textContent?"\\n":"")+"Error: "+String(e.message||"Script failed");});})();', 
      String.fromCharCode(10),
      safeScript,
      String.fromCharCode(10),
      '</' + 'script></body></html>'
    ].join("");
  } else {
    // Full HTML previews execute inside the same restricted iframe.
    frame.srcdoc = codeText;
  }
  getEl("sandboxModal").style.display = "flex";
}
function closeSandboxModal() { getEl("sandboxModal").style.display = "none"; }
