/* Workspace chrome: model picker, accent, location, avatar, profile pages, workspace modes, feedback, usage. */
function positionModelDropdown() {
  const dropdown = getEl("modelDropdown"), button = getEl("modelPickerBtn");
  if (!dropdown || !button || !dropdown.classList.contains("open")) return;
  if (window.matchMedia("(max-width: 720px)").matches) {   /* phones: CSS shows it as a bottom sheet */
    ["position","width","max-width","max-height","left","right","top","bottom","transform"].forEach(k => dropdown.style.removeProperty(k));
    return;
  }
  const rect = button.getBoundingClientRect();
  const width = Math.min(360, Math.max(260, window.innerWidth - 20));
  const fromComposer = !!button.closest(".bar");          /* the picker lives in the typing bar: open upward, right-aligned */
  const left = fromComposer
    ? Math.min(Math.max(10, rect.right - width), Math.max(10, window.innerWidth - width - 10))
    : Math.min(Math.max(10, rect.left), Math.max(10, window.innerWidth - width - 10));
  const top = Math.max(8, rect.bottom + 8);
  const maxHeight = fromComposer
    ? Math.max(160, Math.min(540, rect.top - 20))
    : Math.max(160, Math.min(540, window.innerHeight - top - 12));
  dropdown.style.setProperty("position", "fixed", "important");
  dropdown.style.setProperty("width", width + "px", "important");
  dropdown.style.setProperty("max-width", "calc(100vw - 20px)", "important");
  dropdown.style.setProperty("max-height", maxHeight + "px", "important");
  dropdown.style.setProperty("left", left + "px", "important");
  dropdown.style.setProperty("right", "auto", "important");
  if (fromComposer) {
    dropdown.style.setProperty("bottom", Math.max(8, window.innerHeight - rect.top + 8) + "px", "important");
    dropdown.style.setProperty("top", "auto", "important");
  } else {
    dropdown.style.setProperty("top", top + "px", "important");
    dropdown.style.setProperty("bottom", "auto", "important");
  }
  dropdown.style.setProperty("transform", "none", "important");
}
window.positionModelDropdown = positionModelDropdown;
window.addEventListener("resize", () => {
  if (getEl("modelDropdown")?.classList.contains("open")) positionModelDropdown();
}, { passive: true });

function toggleModelDropdown(e) {
        e?.stopPropagation();
  const dropdown = getEl("modelDropdown"), button = getEl("modelPickerBtn");
  if(!dropdown || !button) return;
  closeAttachmentMenu();
  const open = dropdown.classList.toggle("open");
  button.closest(".model-picker-container")?.classList.toggle("open", open);
  button.setAttribute("aria-expanded", open ? "true" : "false");
  if(open) requestAnimationFrame(positionModelDropdown);
}
function closeModelDropdown() {
  const dropdown = getEl("modelDropdown");
  dropdown?.classList.remove("open");
  if(dropdown){
    dropdown.style.removeProperty("top"); dropdown.style.removeProperty("bottom");
    dropdown.style.removeProperty("left"); dropdown.style.removeProperty("right");
    dropdown.style.removeProperty("width"); dropdown.style.removeProperty("max-height");
    dropdown.style.removeProperty("transform");
  }
  const button = getEl("modelPickerBtn");
  button?.closest(".model-picker-container")?.classList.remove("open");
  button?.setAttribute("aria-expanded", "false");
}

function selectModel(m, e) {
        e?.stopPropagation();
  // Auto is the only Chat model selection; account entitlements remain separate.
  const modelEl = getEl("profileModelText");
  if(modelEl) modelEl.innerText = "Auto";
  const pickerLabel = getEl("modelPickerLabel");
  if(pickerLabel) pickerLabel.textContent = "Models";
  document.querySelectorAll("[data-model]").forEach(x => {
    x.classList.toggle("active", x.dataset.model === "auto");
    const check = x.querySelector(".model-check");
    if(check) check.textContent = x.dataset.model === "auto" ? "✓" : "";
  });
  updateAllUsageUI();
}

function setThinkingLevel(level, e) {
  e?.stopPropagation();
  const next = ["low","medium","extended"].includes(level) ? level : "medium";
  advancedThinkingLevel = next;
  advancedThinkingEnabled = next === "extended";
  try { store.setItem("trux_thinking_level", next); } catch (_) {}
  document.querySelectorAll("[data-thinking-level]").forEach(x => {
    x.classList.toggle("active", x.dataset.thinkingLevel === next);
    const check = x.querySelector(".thinking-check");
    if(check) check.textContent = x.dataset.thinkingLevel === next ? "✓" : "";
  });
}

function syncModelPickerUI() {
  const pickerLabel = getEl("modelPickerLabel");
  if(pickerLabel) pickerLabel.textContent = "Models";
  const modelEl = getEl("profileModelText");
  if(modelEl) modelEl.innerText = "Auto";
  document.querySelectorAll("[data-model]").forEach(x => {
    x.classList.toggle("active", x.dataset.model === "auto");
    const check = x.querySelector(".model-check");
    if(check) check.textContent = x.dataset.model === "auto" ? "✓" : "";
  });
  document.querySelectorAll("[data-thinking-level]").forEach(x => {
    x.classList.toggle("active", x.dataset.thinkingLevel === advancedThinkingLevel);
    const check = x.querySelector(".thinking-check");
    if(check) check.textContent = x.dataset.thinkingLevel === advancedThinkingLevel ? "✓" : "";
  });
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
    autoOption.textContent = "Auto — automatic routing";
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
  if (state) state.textContent = selected === "auto" ? "Auto · automatic routing" : selected;
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
  getEl("locationConsentModal") && getEl("locationConsentModal").classList.remove("active");
  if(useLocation){ store.setItem("trux_location_enabled","true"); requestTruxLocation({interactive:true,force:true}); }
  else { store.setItem("trux_location_enabled","false"); truxLocationCache=null; updateLocationSettingUI(); }
}

function maybeAskForLocation(){
  if(!auth || !auth.currentUser) return;
  if(store.getItem("trux_location_prompted")==="true" || store.getItem("trux_location_enabled")==="false") return;
  if(!("geolocation" in navigator)){ store.setItem("trux_location_prompted","true"); return; }
  setTimeout(function(){ const el=getEl("locationConsentModal"); if(el) el.classList.add("active"); },380);
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



function profileDetailData(key){
  const email=escapeHtml((auth&&auth.currentUser&&auth.currentUser.email)||"No account");
  if(key==="account") return {title:"Manage your account",subtitle:"Your connected sign-in and account controls.",html:'<div class="detail-callout"><h4>Connected account</h4><p>'+email+'</p><div class="detail-stack-actions"><button class="mbtn" type="button" onclick="window.open(&#39;https://myaccount.google.com/&#39;,&#39;_blank&#39;,&#39;noopener&#39;)">Open Google Account</button></div></div>'};
  if(key==="avatar") return {title:"Avatar",subtitle:"Choose the image shown in your TruX profile.",html:'<div class="detail-callout"><h4>Profile image</h4><p>Choose a local image or reset to your connected Google photo.</p><div class="detail-stack-actions"><button class="mbtn" type="button" onclick="openAvatarPicker()">Choose image</button><button class="mbtn" type="button" onclick="resetAvatarOverride()">Reset avatar</button></div></div>'};
  if(key==="help") return {title:"Help & privacy",subtitle:"Guides, troubleshooting, bug reports, and direct founder contact.",html:"<div class=\"help-layout\">\n  <section class=\"help-panel help-wide\">\n    <h4>Welcome to TruX-Omni</h4>\n    <p>This page explains the main workspaces, tools, settings, and ways to get help.</p>\n    <ul>\n      <li><b>Chat:</b> Ask questions, learn, brainstorm, write, and work through follow-up questions.</li>\n<li><b>Image and Video:</b> Switch to the matching workspace and describe what you want to create.</li>\n      <li><b>TruX Live:</b> Start a live voice session when you want to speak naturally; allow camera or screen access only when you need it.</li>\n    </ul>\n  </section>\n  <section class=\"help-panel\">\n    <h4>Chat and model selection</h4>\n    <p>Choose Chat for everyday questions. The regular user model choice is <b>Auto</b>, which selects a suitable model for your request. Be specific about your goal, constraints, and preferred output, then ask follow-up questions to refine the result.</p>\n    <p>Thinking controls, when available, let you adjust how much reasoning to use.</p>\n  </section>\n  <section class=\"help-panel\">\n    <h4>The + tools menu</h4>\n    <p>Use the <b>+</b> menu to access tools such as Deep Research, image generation, files, camera, and photos. Describe what you want done with an attachment so TruX knows how to use it.</p>\n    <p>Use the Library to revisit supported generated media and saved items.</p>\n  </section>\n  <section class=\"help-panel\">\n    <h4>Chats, notebooks, and Incognito</h4>\n    <p>Use the sidebar to switch between chats and notebooks. Move relevant conversations into a notebook to keep related work together. Use the Incognito option when you want a separate private-style session; check the current interface before assuming a conversation has been saved.</p>\n  </section>\n  <section class=\"help-panel\">\n    <h4>Settings and privacy</h4>\n    <p>Open your profile menu for Settings, Personalization, Notifications, usage information, and account options. Location access can be managed from Personalization. Only grant device permissions when a feature needs them.</p>\n    <div class=\"detail-stack-actions\"><button class=\"mbtn\" type=\"button\" onclick=\"closeProfileOption();openSettingsModal(&quot;personalization&quot;)\">Open Personalization</button></div>\n  </section>\n  <section class=\"help-panel\">\n    <h4>Troubleshooting</h4>\n    <ol>\n      <li>Check your internet connection and confirm you are signed in.</li>\n      <li>If a tool fails, retry once and note the exact error message.</li>\n      <li>For voice, camera, or screen features, check the browser permission for that feature.</li>\n      <li>If the issue continues, send a bug report below with the steps that caused it and what you expected to happen.</li>\n    </ol>\n  </section>\n  <section class=\"help-panel help-wide\" id=\"helpFeedbackSection\">\n    <h4>Feedback and bug reports</h4>\n    <p>Use this form to report a bug, describe an issue, suggest a feature, or share feedback. For bugs, include what you were doing, the steps to reproduce the issue, what happened, and what you expected instead. Please do not include passwords, API keys, or other secrets.</p>\n    <form class=\"help-form\" onsubmit=\"submitHelpFeedback(event)\">\n      <label>Feedback type\n        <select name=\"type\" required>\n          <option value=\"bug-report\">Report a bug or issue</option>\n          <option value=\"product-feedback\">General feedback</option>\n          <option value=\"feature-request\">Suggest a feature</option>\n          <option value=\"general-feedback\">Other</option>\n        </select>\n      </label>\n      <label>Subject (optional)\n        <input name=\"subject\" type=\"text\" maxlength=\"160\" placeholder=\"A short title for your feedback\">\n      </label>\n      <label>Details\n        <textarea name=\"message\" required minlength=\"8\" maxlength=\"12000\" rows=\"5\" placeholder=\"Describe the issue, steps to reproduce it, or your suggestion…\"></textarea>\n      </label>\n      <button class=\"mbtn help-submit\" type=\"submit\">Send feedback</button>\n    </form>\n  </section>\n  <section class=\"help-panel help-wide\" id=\"founderContactSection\">\n    <h4>Contact the founder directly</h4>\n    <p>Have a question, suggestion, or query for the founder? Type it here and submit it as a direct contact request. Replies use the email address associated with your signed-in account.</p>\n    <form class=\"help-form\" onsubmit=\"submitFounderQuery(event)\">\n      <label>Subject\n        <input name=\"subject\" type=\"text\" required maxlength=\"160\" placeholder=\"What is your query about?\">\n      </label>\n      <label>Your query\n        <textarea name=\"message\" required minlength=\"8\" maxlength=\"12000\" rows=\"4\" placeholder=\"Write your question or query to the founder…\"></textarea>\n      </label>\n      <button class=\"mbtn help-submit\" type=\"submit\">Email the founder</button>\n    </form>\n  </section>\n  <p class=\"help-footnote help-wide\">Feedback and founder queries require you to be signed in. Submissions are emailed to the TruX-Omni founder when server delivery is available. If email delivery fails, TruX opens your email app with the message prepared so you can send it manually.</p>\n</div>"};

  if(key==="workspace") return {title:"Workspace",subtitle:"Your current TruX-Omni plan and tools.",html:'<div class="detail-callout"><h4>Current workspace</h4><p>'+((currentPlanTier==="pro")?"Pro workspace":"Personal workspace")+'</p><p>Usage and model access are managed by your current plan.</p><div class="detail-stack-actions"><button class="mbtn" type="button" onclick="openSettingsModal(&quot;usage&quot;)">View usage &amp; limits</button><button class="mbtn" type="button" onclick="openSettingsModal(&quot;data&quot;)">Manage workspace data</button></div></div>'};
  if(key==="safety") return {title:"Safety & wellbeing",subtitle:"Permission and safe-use guidance for this workspace.",html:'<div class="detail-callout"><h4>Device permissions</h4><p>Only grant location, microphone, camera, or notification permissions when you are using a feature that needs them. You can change location and notification settings below.</p><div class="detail-stack-actions"><button class="mbtn" type="button" onclick="openSettingsModal(&quot;personalization&quot;)">Location &amp; personalization</button><button class="mbtn" type="button" onclick="openSettingsModal(&quot;notifications&quot;)">Notification settings</button></div></div><div class="detail-callout"><h4>Content safeguards</h4><p>TruX does not currently expose a separate sensitive-content filter switch. Do not use this screen as a substitute for reviewing generated content.</p></div>'};
  if(key==="security") return {title:"Security & login",subtitle:"Manage the account used to sign in to TruX.",html:'<div class="detail-callout"><h4>Connected account</h4><p>'+email+'</p><p>Account password, passkeys, and multi-factor authentication are managed by your sign-in provider.</p><div class="detail-stack-actions"><button class="mbtn" type="button" onclick="window.open(&#39;https://myaccount.google.com/security&#39;,&#39;_blank&#39;,&#39;noopener&#39;)">Open account security</button><button class="mbtn danger" type="button" onclick="confirmSignOut()">Sign out</button></div></div>'};
  if(key==="remote") return {title:"Remote control",subtitle:"Control TruX from another device.",html:'<div class="detail-callout"><h4>Remote pairing is not available yet</h4><p>This TruX web app does not currently implement QR pairing or remote desktop control. No saved connections are being hidden here.</p><div class="detail-stack-actions"><button class="mbtn" type="button" onclick="closeProfileOption()">Back to profile</button></div></div>'};
  if(key==="storage") return {title:"Storage",subtitle:"Manage chats and workspace data saved by TruX.",html:'<div class="detail-callout"><h4>Workspace data</h4><p>Export a copy of your chats before clearing history. Clearing chat history is destructive and requires confirmation.</p><div class="detail-stack-actions"><button class="mbtn" type="button" onclick="exportChatData()">Export chats</button><button class="mbtn" type="button" onclick="exportTruxMemory()">Export workspace memory</button><button class="mbtn danger" type="button" onclick="clearAllHistory()">Clear chat history</button></div></div>'};
  if(key==="privacy") return {title:"Privacy center",subtitle:"Review the privacy controls available in TruX.",html:'<div class="detail-callout"><h4>Available controls</h4><p>Use Data controls to export or clear chats and to import or export workspace memory. Location access can be changed under Personalization. Incognito sessions are intended to stay separate from normal chat history.</p><div class="detail-stack-actions"><button class="mbtn" type="button" onclick="openSettingsModal(&quot;data&quot;)">Open data controls</button><button class="mbtn" type="button" onclick="openSettingsModal(&quot;personalization&quot;)">Open personalization</button></div></div>'};
  if(key==="ads") return {title:"Ads controls",subtitle:"Advertising preferences for TruX-Omni.",html:'<div class="detail-callout"><h4>Ads are not currently enabled in TruX</h4><p>This app does not currently serve personalized ads or maintain an ads-topic history, so an ad personalization toggle would not change anything. Your chat and workspace controls are available separately.</p><div class="detail-stack-actions"><button class="mbtn" type="button" onclick="openSettingsModal(&quot;data&quot;)">Open data controls</button></div></div>'};
  if(key==="about") return {title:"About TruX-Omni",subtitle:"Your AI workspace.",html:'<div class="detail-callout"><h4>TruX-Omni</h4><p>An AI workspace for chat, coding, image and video creation, and connected tools.</p><p>Application: <a href="https://trux-ai-workspace.trux.website/" target="_blank" rel="noopener noreferrer">trux-ai-workspace.trux.website</a></p><div class="detail-stack-actions"><button class="mbtn" type="button" onclick="openProfileOption(&quot;help&quot;)">Help &amp; feedback</button></div></div>'};
  if(key==="reportbug"){ const page=profileDetailData("help"); page.title="Report a bug"; page.subtitle="Send a bug report, feature request, or product feedback."; return page; }

  if(key==="parental") return {title:"Parental controls",subtitle:"Safety options for younger users.",html:'<div class="detail-callout"><h4>Device-level controls</h4><p>TruX does not currently provide parent-linked controls or cross-account monitoring. A parent or guardian can configure device-level restrictions using the device operating system or family-management service.</p><div class="detail-stack-actions"><button class="mbtn" type="button" onclick="openSettingsModal(&quot;personalization&quot;)">Review personalization</button><button class="mbtn" type="button" onclick="openSettingsModal(&quot;notifications&quot;)">Review notifications</button></div></div>'};
  if(key==="upgrade") return {title:"Plan & usage",subtitle:"Review your current plan limits.",html:'<div class="detail-callout"><h4>Current plan</h4><p>Open usage and limits to review your current workspace allowance and image-generation usage. Plan purchasing is not handled by this page.</p><div class="detail-stack-actions"><button class="mbtn" type="button" onclick="openSettingsModal(&quot;usage&quot;)">View usage &amp; limits</button></div></div>'};
  return {title:"Profile",subtitle:"Choose a profile setting.",html:'<div class="detail-callout"><p>That option is not available for this account.</p></div>'};
}

function openProfileOption(key){
  const settingsSections={usage:"usage",personalization:"personalization",notifications:"voice",memory:"personalization",appearance:"appearance",general:"general",voice:"voice",dataControls:"data",developer:"developer",account:"account",workspace:"account",upgrade:"usage",security:"account",safety:"personalization",remote:"data",storage:"data",privacy:"data",ads:"data",parental:"personalization",avatar:"account"};
  if(key==="plugins"){
    closeProfileOption();
    closeProfileModal();
    if(typeof openPluginsPage==="function") openPluginsPage();
    else toast("Plugins could not be opened. Please refresh TruX and try again.","err");
    return;
  }
  if(Object.prototype.hasOwnProperty.call(settingsSections,key)){
    closeProfileOption();
    openSettingsModal(settingsSections[key]);
    return;
  }
  currentProfileOption=key;
  const detail=getEl("profileDetailView");
  const data=profileDetailData(key);
  document.querySelectorAll("#profileModal .profile-option-list").forEach(el=>el.style.display="none");
  document.querySelectorAll("#profileModal .profile-list-group-title").forEach(el=>el.style.display="none");
  const hero=getEl("profileHero"), summary=getEl("profileMetaSummary"), actions=getEl("profileActionsRow");
  if(hero) hero.style.display="none";
  if(summary) summary.style.display="none";
  if(actions) actions.style.display="none";
  if(detail){ detail.hidden=false; getEl("profileDetailTitle").textContent=data.title; getEl("profileDetailSubtitle").textContent=data.subtitle; getEl("profileDetailBody").innerHTML=data.html; }
  const scroller=getEl("profileModal"); if(scroller) scroller.scrollTop=0;
}

function closeProfileOption(){
  currentProfileOption=null;
  document.querySelectorAll("#profileModal .profile-option-list").forEach(el=>el.style.display="");
  document.querySelectorAll("#profileModal .profile-list-group-title").forEach(el=>el.style.display="");
  const hero=getEl("profileHero"), summary=getEl("profileMetaSummary"), actions=getEl("profileActionsRow");
  if(hero) hero.style.display="";
  if(summary) summary.style.display="";
  if(actions) actions.style.display="";
  const detail=getEl("profileDetailView");
  if(detail) detail.hidden=true;
  const scroller=getEl("profileModal"); if(scroller) scroller.scrollTop=0;
}

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
  syncModelPickerUI(); renderSidebar();
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

function getProUsageData() {
  let currentMonth = new Date().toISOString().slice(0, 7);
  let u = store.json("trux_pro_usage", { tokensUsed: 0, monthReset: currentMonth });
  if(u.monthReset !== currentMonth) { u = { tokensUsed: 0, monthReset: currentMonth }; store.setItem("trux_pro_usage", JSON.stringify(u)); }
  return u;
}
function getCoreUsageData() {
  let currentMonth = new Date().toISOString().slice(0, 7);
  let u = store.json("trux_core_usage", { tokensUsed: 0, monthReset: currentMonth });
  if(u.monthReset !== currentMonth) { u = { tokensUsed: 0, monthReset: currentMonth }; store.setItem("trux_core_usage", JSON.stringify(u)); }
  return u;
}
function getImageUsageData() {
  let currentMonth = new Date().toISOString().slice(0, 7);
  let u = store.json("trux_image_usage", { count: 0, monthReset: currentMonth });
  if(u.monthReset !== currentMonth) { u = { count: 0, monthReset: currentMonth }; store.setItem("trux_image_usage", JSON.stringify(u)); }
  return u;
}

function updateAllUsageUI() {
  const owner = isTruxDeveloper(auth?.currentUser);
  let cU = getCoreUsageData();
  getEl("coreUsageBarFill").style.width = owner ? "8%" : "12%";
  getEl("coreUsageText").innerText = `Unlimited · ${cU.tokensUsed.toLocaleString()} tokens used`;

  let pU = getProUsageData();
  getEl("proUsageBarFill").style.width = owner ? "100%" : Math.min(100, (pU.tokensUsed / 1000000) * 100) + "%";
  getEl("proUsageText").innerText = owner ? `Unlimited · ${pU.tokensUsed.toLocaleString()} tokens used` : `${pU.tokensUsed.toLocaleString()} / 1,000,000 Tokens`;

  let iU = getImageUsageData();
  getEl("imageUsageBarFill").style.width = Math.min(100, (iU.count / 15) * 100) + "%";
  getEl("imageUsageText").innerText = owner ? `${iU.count} / 15 Images · Owner access` : `${iU.count} / 15 Images`;

  const plan = getEl("profilePlanText"), limit = getEl("profileLimitText");
  if(plan) plan.innerText = owner ? "Owner" : (currentPlanTier === "pro" ? "Pro" : "Core");
  if(limit) limit.innerText = "Unlimited";
}
