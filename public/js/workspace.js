/* Workspace chrome: model picker, accent, location, avatar, profile pages, workspace modes, feedback, usage. */
/* Model selection is a page (#modelPage), not a dropdown: full screen on phones, split screen on larger displays.
   The names stay toggleModelDropdown / closeModelDropdown because the rest of the app already calls them. */
function toggleModelDropdown(e) {
  e?.stopPropagation();
  const page = getEl("modelPage");
  if (!page) return;
  if (!page.hidden) { closeModelDropdown(); return; }
  closeAttachmentMenu();
  closeThinkingPage?.({ instant: true });
  page.hidden = false;
  document.body.classList.add("model-page-open");
  getEl("modelPickerBtn")?.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => {
    page.classList.add("open");
    (page.querySelector(".mp-item.active") || page.querySelector(".mp-item"))?.focus({ preventScroll: true });
  });
  try { if (typeof refreshTruxUsage === "function") void refreshTruxUsage(); } catch {}
}
function closeModelDropdown() {
  const page = getEl("modelPage");
  if (page && !page.hidden) {
    page.classList.remove("open");
    page.hidden = true;
    closeThinkingPage?.({ instant: true });
    document.body.classList.remove("model-page-open");
  }
  getEl("modelPickerBtn")?.setAttribute("aria-expanded", "false");
}

async function loadOwnerGeminiModels(forceRefresh = false) {
  if (!isTruxDeveloper(auth?.currentUser)) return;
  const selector = getEl("ownerGeminiModelSelect");
  const status = getEl("ownerGeminiModelStatus");
  if (!selector) return;
  const currentUser = auth.currentUser;
  selector.disabled = true;
  if (status) status.textContent = "Loading Gemini models…";
  try {
    const endpoint = "/api/models" + (forceRefresh ? "?refresh=1" : "");
    const response = await truxAuthenticatedFetch(endpoint, {
      method: "GET",
      cache: "no-store"
    }, currentUser);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Could not load Google Cloud Gemini models.");
    if (!isTruxDeveloper(auth?.currentUser) || auth.currentUser.uid !== currentUser.uid) return;

    const models = Array.isArray(payload.models) ? payload.models : [];
    const savedModel = store.getItem("trux_owner_gemini_model") || "auto";
    selector.replaceChildren();
    const autoOption = document.createElement("option");
    autoOption.value = "auto";
    autoOption.textContent = "Off, use the selected TruX model";
    selector.appendChild(autoOption);
    for (const model of models) {
      if (!model || typeof model.id !== "string" || !model.id) continue;
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.displayName ? model.displayName + " (" + model.id + ")" : model.id;
      selector.appendChild(option);
    }

    const savedIsAvailable = Array.from(selector.options).some(option => option.value === savedModel);
    selector.value = savedIsAvailable ? savedModel : "auto";
    if (!savedIsAvailable && savedModel !== "auto") store.setItem("trux_owner_gemini_model", "auto");
    selector.dataset.loaded = "true";
    updateOwnerGeminiModelStatus();
    if (status) status.textContent = models.length + " Gemini models loaded from Google Cloud.";
  } catch (error) {
    if (status) status.textContent = String(error?.message || "Gemini model catalog could not be loaded.");
  } finally {
    selector.disabled = false;
  }
}

function saveOwnerGeminiModel(value) {
  if (!isTruxDeveloper(auth?.currentUser)) return;
  const selector = getEl("ownerGeminiModelSelect");
  if (!selector || !Array.from(selector.options).some(option => option.value === value)) return;
  store.setItem("trux_owner_gemini_model", value === "auto" ? "auto" : String(value));
  updateOwnerGeminiModelStatus();
}

function updateOwnerGeminiModelStatus() {
  const selected = store.getItem("trux_owner_gemini_model") || "auto";
  const state = getEl("ownerModelStateText");
  if (state) state.textContent = selected === "auto" ? "Off" : selected;
}

function getActiveChatContainer() {
  return getEl("chatContainer");
}


const TRUX_ACCENTS = new Set(["blue","cyan","purple","pink","red","orange","yellow","green","teal","white"]);
function applyTruxAccent(name, persist) {
  const next = TRUX_ACCENTS.has(String(name || "").toLowerCase()) ? String(name).toLowerCase() : "blue";
  document.body.dataset.accent = next;
  document.querySelectorAll("[data-accent-option]").forEach(function(el){ el.classList.toggle("active", el.dataset.accentOption === next); });
  if(persist !== false) store.setItem("trux_accent", next);
}
applyTruxAccent(store.getItem("trux_accent") || "blue", false);



function updateLocationSettingUI() {
  const toggle=getEl("locationAccessToggle"), status=getEl("locationStatusText");
  const enabled=store.getItem("trux_location_enabled") !== "false";
  if(toggle) toggle.checked=enabled;
  if(!status) return;
  if(!("geolocation" in navigator)) status.textContent="Location is not supported by this browser.";
  else if(!enabled) status.textContent="Location access is off. TruX will not request it.";
  else if(truxLocationCache) status.textContent="Location available for this session.";
  else if(store.getItem("trux_location_granted")==="true") status.textContent="Permission granted. Waiting for a fresh position.";
  else if(store.getItem("trux_location_granted")==="false") status.textContent="Permission unavailable or denied.";
  else status.textContent="Location access is enabled. TruX will ask when needed.";
}

function toggleTruxLocationAccess(enabled) {
  store.setItem("trux_location_enabled", enabled ? "true" : "false");
  if(!enabled){ truxLocationCache=null; store.setItem("trux_location_granted","false"); updateLocationSettingUI(); return; }
  requestTruxLocation({interactive:true,force:true});
  updateLocationSettingUI();
}

function requestTruxLocation(options) {
  options=options||{};
  const interactive=!!options.interactive, force=!!options.force;
  if(store.getItem("trux_location_enabled")==="false" || !("geolocation" in navigator)){ updateLocationSettingUI(); return Promise.resolve(null); }
  if(truxLocationCache && !force) return Promise.resolve(truxLocationCache);
  return new Promise(function(resolve){
    navigator.geolocation.getCurrentPosition(function(pos){
      truxLocationCache={latitude:Number(pos.coords.latitude),longitude:Number(pos.coords.longitude),accuracy:Number(pos.coords.accuracy||0)};
      store.setItem("trux_location_granted","true"); store.setItem("trux_location_prompted","true"); updateLocationSettingUI();
      if(interactive) toast("Location access enabled for TruX.","ok");
      resolve(truxLocationCache);
    },function(err){
      store.setItem("trux_location_granted","false"); updateLocationSettingUI();
      if(interactive) toast(err && err.code===1 ? "Location permission was denied. You can enable it later in Personalization." : "TruX could not access your location right now.","err");
      resolve(null);
    },{enableHighAccuracy:false,maximumAge:300000,timeout:12000});
  });
}

function getTruxLocationForTurn(){
  if(store.getItem("trux_location_enabled")==="false") return Promise.resolve(null);
  if(truxLocationCache) return Promise.resolve(truxLocationCache);
  if(store.getItem("trux_location_granted")==="false") return Promise.resolve(null);
  return requestTruxLocation({interactive:false});
}

function dismissLocationConsent(useLocation){
  store.setItem("trux_location_prompted","true");
  setOverlayActive(getEl("locationConsentModal"), false);
  if(useLocation){ store.setItem("trux_location_enabled","true"); requestTruxLocation({interactive:true,force:true}); }
  else { store.setItem("trux_location_enabled","false"); truxLocationCache=null; updateLocationSettingUI(); }
}

function maybeAskForLocation(){
  if(!auth || !auth.currentUser) return;
  if(store.getItem("trux_location_prompted")==="true" || store.getItem("trux_location_enabled")==="false") return;
  if(!("geolocation" in navigator)){ store.setItem("trux_location_prompted","true"); return; }
  setTimeout(function(){ const el=getEl("locationConsentModal"); if(el) setOverlayActive(el, true); },380);
}

function applyStoredAvatar(user){
  const override=store.getItem("trux_avatar_override")||"";
  const src=override || (user && user.photoURL) || "https://ui-avatars.com/api/?name=User&background=111111&color=fff";
  if(getEl("userAvatar")) getEl("userAvatar").src=src;
  if(getEl("modalAvatar")) getEl("modalAvatar").src=src;
  if(getEl("topProfileAvatar")) getEl("topProfileAvatar").src=src;
}

function openAvatarPicker(){
  let input=getEl("profileAvatarUpload");
  if(!input){
    input=document.createElement("input"); input.id="profileAvatarUpload"; input.type="file"; input.accept="image/*"; input.hidden=true;
    input.onchange=handleProfileAvatarUpload; document.body.appendChild(input);
  }
  input.click();
}

function handleProfileAvatarUpload(event){
  const file=event && event.target && event.target.files && event.target.files[0];
  if(!file || !file.type.startsWith("image/")) return;
  const reader=new FileReader();
  reader.onload=function(e){ const data=String(e.target.result||""); if(!data)return; store.setItem("trux_avatar_override",data); applyStoredAvatar(auth&&auth.currentUser); toast("Profile avatar updated on this device.","ok"); };
  reader.readAsDataURL(file);
}

function resetAvatarOverride(){ store.removeItem("trux_avatar_override"); applyStoredAvatar(auth&&auth.currentUser); toast("Profile avatar reset.","ok"); }



function updateNotificationSettingsUI(){
  const granted=("Notification" in window && Notification.permission==="granted");
  const t=getEl("notificationsToggle"); if(t) t.checked=granted;
  const s=getEl("notificationStatusText"); if(s) s.textContent=("Notification" in window) ? "Permission: "+Notification.permission : "Notifications are not supported.";
}

async function toggleTruxNotificationsSetting(enabled){
  if(!enabled){ updateNotificationSettingsUI(); return; }
  await enableTruxNotifications();
  updateNotificationSettingsUI();
}

function setWorkspaceMode(mode, options) {
  options = options || {};
  const allowedModes = new Set(["chat", "deep-research", "video"]);
  const nextMode = allowedModes.has(String(mode || "")) ? String(mode) : "chat";
  const previousMode = workspaceMode;
  document.body.classList.remove("plugins-page-active", "notebook-open");
  const leavingSubscriptionPage = document.body.classList.contains("subscription-page-active");
  if (leavingSubscriptionPage) { document.body.classList.remove("subscription-page-active"); truxSubscriptionReturnState = null; }
  const modeChanged = leavingSubscriptionPage || nextMode !== previousMode || !!document.body.dataset.mediaMode || options.forceReset === true;
  const preserveSession = options.preserveSession === true;
  closeAttachmentMenu(); closeModelDropdown();
  if (modeChanged) {
    detachActiveTurn();
    if (typeof clearHomeGreetingTimers === "function") clearHomeGreetingTimers();
    document.body.classList.remove("scrolled"); getEl("scrollDownBtn")?.classList.remove("visible");
    pastedTextBlocks = []; fileAttachments = []; renderFileChips();
    if (!preserveSession) { currentChatId = null; incognitoMode = false; }
    const chatView = getEl("chatContainer");
    if (chatView) { chatView.innerHTML = ""; }
    void document.body.offsetHeight;
  }
  workspaceMode = nextMode; document.body.dataset.workspaceMode = workspaceMode;
  if (currentChatId && chatSessions[currentChatId] && preserveSession) chatSessions[currentChatId].mode = workspaceMode;
  const isMedia = workspaceMode === "video" && !currentChatId;
  if (isMedia) document.body.dataset.mediaMode = workspaceMode; else document.body.removeAttribute("data-media-mode");
  document.body.classList.toggle("chat-session-active", !!currentChatId && !isMedia);
  document.body.classList.toggle("home-active", !isMedia && !currentChatId);
  document.querySelectorAll("[data-trux-menu-mode]").forEach(el => el.classList.toggle("active", el.dataset.truxMenuMode === workspaceMode));
  const prompt = getEl("promptInput");
  const placeholders = { chat: "Ask TruX…", "deep-research": "Research prompt…", video: "Describe a video…" };
  if (prompt) { prompt.placeholder = placeholders[workspaceMode] || "Ask TruX…"; prompt.style.height = "auto"; handleInputChange(); }
  renderModelPicker(); renderSidebar();
  if (isMedia) window.truxVideoStudio?.refresh();
  if (workspaceMode === "chat" && !currentChatId && !isMedia) startHomeGreetingPulse();
}
async function submitFeedback() {
  const type = getEl("feedbackType")?.value || "general-feedback";
  const subject = getEl("feedbackSubject")?.value?.trim() || "";
  const message = getEl("feedbackInput")?.value?.trim() || "";
  if (!message) return toast("Please describe your feedback or bug.", "err");
  return sendTruxFeedback({ type, subject, message, button: getEl("feedbackSubmitBtn") });
}

async function submitHelpFeedback(event) {
  event?.preventDefault();
  const form = event?.currentTarget;
  if (!form) return;
  const type = form.querySelector('[name="type"]')?.value || "general-feedback";
  const subject = form.querySelector('[name="subject"]')?.value?.trim() || "";
  const message = form.querySelector('[name="message"]')?.value?.trim() || "";
  if (message.length < 8) return toast("Please add a little more detail before sending.", "err");
  return sendTruxFeedback({ type, subject, message, form, button: form.querySelector('[type="submit"]') });
}

async function submitFounderQuery(event) {
  event?.preventDefault();
  const form = event?.currentTarget;
  if (!form) return;
  const subject = form.querySelector('[name="subject"]')?.value?.trim() || "";
  const message = form.querySelector('[name="message"]')?.value?.trim() || "";
  if (subject.length < 2 || message.length < 8) return toast("Please add a subject and write your query.", "err");
  return sendTruxFeedback({ type: "founder-query", subject, message, form, button: form.querySelector('[type="submit"]') });
}

function openFeedbackEmailDraft({ type, subject, message, user }) {
  const labels = {
    "bug-report": "Bug report",
    "product-feedback": "Product feedback",
    "feature-request": "Feature request",
    "general-feedback": "General feedback",
    "founder-query": "Founder query"
  };
  const label = labels[type] || "Feedback";
  const emailSubject = "[TruX-Omni " + label + "] " + (subject || label);
  const body = [
    "TruX-Omni " + label,
    "Submitted from: " + window.location.origin,
    "Account name: " + (user?.displayName || "Not provided"),
    "Account email: " + (user?.email || "Not provided"),
    "Submitted at: " + new Date().toISOString(),
    "",
    "Message:",
    message
  ].join("\n");
  const mailto = "mailto:ekagraavn2003@gmail.com?subject=" +
    encodeURIComponent(emailSubject) + "&body=" + encodeURIComponent(body);
  try {
    window.location.href = mailto;
    toast("Your email app should open with this message prepared. Tap Send there to deliver it to the founder.", "ok");
    return true;
  } catch {
    toast("Automatic email is unavailable. Email ekagraavn2003@gmail.com and paste your message.", "err");
    return false;
  }
}

async function sendTruxFeedback({ type, subject, message, form, button }) {
  const user = auth?.currentUser;
  if (!user) {
    toast("Sign in to send feedback or contact the founder.", "err");
    openLoginWall();
    return false;
  }
  if (message.length > 12000) return toast("Your message is too long. Please shorten it.", "err");
  const originalHtml = button?.innerHTML;
  if (button) {
    button.disabled = true;
    button.textContent = "Sending…";
  }
  try {
    const requestOptions = {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, subject, message })
    };
    let response;
    try {
      response = await truxAuthenticatedFetch("/api/feedback", requestOptions, user);
    } catch {
      return openFeedbackEmailDraft({ type, subject, message, user });
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if ([404, 405, 500, 502, 503, 504].includes(response.status)) {
        return openFeedbackEmailDraft({ type, subject, message, user });
      }
      throw new Error(payload.error || payload.detail || "Feedback could not be sent. Please try again.");
    }
    if (form) form.reset();
    else {
      if (getEl("feedbackInput")) getEl("feedbackInput").value = "";
      if (getEl("feedbackSubject")) getEl("feedbackSubject").value = "";
    }
    toast(payload.message || "Your message was emailed to the founder.", "ok");
    return true;
  } catch (error) {
    toast(error?.message || "Feedback could not be sent. Please try again.", "err");
    return false;
  } finally {
    if (button) {
      button.disabled = false;
      if (originalHtml !== undefined) button.innerHTML = originalHtml;
    }
  }
}
