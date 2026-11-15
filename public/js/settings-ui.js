/* The Settings screen: a full-page view with a section list on the left (a list-then-page flow on phones).
 *
 *   Profile · General · Appearance · Personalization · Memory · Voice · Notifications · Usage & limits ·
 *   Data & privacy · Help & feedback · Developer (owner only)
 *
 * Device preferences come from settings.js, account-wide personalization from personalization.js, models and
 * token usage from models.js. Everything here is built with DOM calls (textContent), never HTML strings. */
const SX_SECTIONS = [
  { id: "profile",         label: "Profile",          hint: "Your account and plan",
    icon: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0" },
  { id: "general",         label: "General",          hint: "Model, sending and reading",
    icon: "M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6" },
  { id: "appearance",      label: "Appearance",       hint: "Theme, colour and text size",
    icon: "M12 3a9 9 0 1 0 0 18c1.1 0 1.7-.8 1.7-1.6 0-1.4-1.1-1.5-1.1-2.7 0-.9.7-1.5 1.7-1.5H17a4 4 0 0 0 4-4c0-4.4-4-8.2-9-8.2z" },
  { id: "personalization", label: "Personalization",  hint: "How TruX talks to you",
    icon: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM18.5 16l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" },
  { id: "memory",          label: "Memory",           hint: "What TruX remembers",
    icon: "M5 5h14v14H5zM9 9h6M9 13h6M9 17h3" },
  { id: "voice",           label: "Voice & audio",    hint: "Voice, speed and dictation",
    icon: "M4 10v4h4l5 4V6L8 10zM16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11" },
  { id: "notifications",   label: "Notifications",    hint: "Alerts and reminders",
    icon: "M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0" },
  { id: "usage",           label: "Usage & limits",   hint: "Daily tokens and monthly tools",
    icon: "M5 20V10M12 20V4M19 20v-7" },
  { id: "data",            label: "Data & privacy",   hint: "Export, history and location",
    icon: "M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z" },
  { id: "help",            label: "Help & feedback",  hint: "Guides, bugs and contact",
    icon: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.6 9.4a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2.9-1.2 1.8M12 16.7v.1", },
  { id: "developer",       label: "Developer",        hint: "Owner tools", owner: true,
    icon: "m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" }
];
const SX_ALIASES = { account: "profile", assistant: "general", home: "", plugins: "help" };
const SX_ACCENTS = [["blue", "#2f6fed"], ["cyan", "#0e9bbd"], ["purple", "#7a56e6"], ["pink", "#d9488f"], ["red", "#d64545"],
  ["orange", "#d9731f"], ["yellow", "#c99a0a"], ["green", "#1f9a5f"], ["teal", "#16a08c"], ["white", "#8a8880"]];
const SX_PLAN_NAMES = { base: "Free", plus: "Plus", pro: "Pro", edge: "Edge" };

let sxRoot = null;
let sxSection = "profile";
let sxOpen = false;
let sxPzTimer = null;
let sxReturnFocus = null;

/* ---------- tiny DOM helpers ---------- */
function sxEl(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return node;
}
function sxIcon(path) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  svg.append(p);
  return svg;
}
const sxSignedIn = () => !!auth?.currentUser;
const sxIsOwner = () => { try { return isTruxDeveloper(auth?.currentUser); } catch { return false; } };

function sxRow(title, desc, control, opts = {}) {
  return sxEl("div", { class: "sx-row" + (opts.stack ? " stack" : "") },
    sxEl("div", { class: "sx-row-copy" }, sxEl("div", { class: "sx-row-title", text: title }), desc ? sxEl("div", { class: "sx-row-desc", text: desc }) : null),
    control ? sxEl("div", { class: "sx-row-control" }, control) : null);
}
function sxGroup(title, note, ...rows) {
  return sxEl("section", { class: "sx-group" },
    title ? sxEl("h3", { class: "sx-group-title", text: title }) : null,
    note ? sxEl("p", { class: "sx-group-note", text: note }) : null,
    sxEl("div", { class: "sx-card" }, rows));
}
function sxSwitch(checked, onChange, label) {
  const input = sxEl("input", { type: "checkbox", role: "switch", "aria-label": label || "Toggle" });
  input.checked = !!checked;
  input.addEventListener("change", () => onChange(input.checked, input));
  return sxEl("label", { class: "sx-switch" }, input, sxEl("span", { class: "sx-switch-track" }));
}
function sxSelect(options, value, onChange, label) {
  const select = sxEl("select", { class: "sx-select", "aria-label": label || "Choose" },
    options.map(([id, text]) => sxEl("option", { value: id, text })));
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  return select;
}
function sxSegmented(options, value, onChange, label) {
  const wrap = sxEl("div", { class: "sx-seg", role: "radiogroup", "aria-label": label || "Choose" });
  for (const [id, text] of options) {
    const b = sxEl("button", { type: "button", role: "radio", class: id === value ? "on" : "", "aria-checked": String(id === value), text });
    b.addEventListener("click", () => {
      wrap.querySelectorAll("button").forEach(x => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", String(x === b)); });
      onChange(id);
    });
    wrap.append(b);
  }
  return wrap;
}
function sxButton(text, onClick, kind) {
  return sxEl("button", { type: "button", class: "sx-btn" + (kind ? " " + kind : ""), text, onclick: onClick });
}
function sxHead(title, desc) {
  return sxEl("header", { class: "sx-head" }, sxEl("h2", { text: title }), desc ? sxEl("p", { text: desc }) : null);
}
function sxSignInNeeded(what) {
  return sxEl("div", { class: "sx-empty" }, sxEl("p", { text: "Sign in to " + what + "." }), sxButton("Sign in", () => { closeSettings(); openLoginWall(); }, "primary"));
}
function sxPlanName() {
  if (sxIsOwner()) return "Owner";
  return SX_PLAN_NAMES[truxUsage?.tier || currentPlanTier] || "Free";
}
function sxDate(value) {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" }) : "Not available";
}

/* ---------- shell ---------- */
function sxBuildShell() {
  if (sxRoot) return sxRoot;
  const nav = sxEl("nav", { class: "sx-nav-list", id: "sxNav", "aria-label": "Settings sections" });
  const root = sxEl("div", { class: "sx", id: "settingsApp", role: "dialog", "aria-modal": "true", "aria-label": "Settings", hidden: true, dataset: { view: "nav" } },
    sxEl("aside", { class: "sx-nav" },
      sxEl("div", { class: "sx-nav-head" },
        sxEl("button", { type: "button", class: "sx-icon-btn", "aria-label": "Close settings", onclick: () => closeSettings() }, sxIcon("M19 12H5M12 19l-7-7 7-7")),
        sxEl("h1", { text: "Settings" })),
      nav),
    sxEl("main", { class: "sx-main" },
      sxEl("div", { class: "sx-main-head" },
        sxEl("button", { type: "button", class: "sx-icon-btn sx-back", "aria-label": "Back to settings", onclick: () => sxShowNav() }, sxIcon("M15 18l-6-6 6-6")),
        sxEl("div", { class: "sx-main-title", id: "sxMainTitle", text: "Profile" }),
        sxEl("button", { type: "button", class: "sx-icon-btn", "aria-label": "Close settings", onclick: () => closeSettings() }, sxIcon("M6 6l12 12M18 6 6 18"))),
      sxEl("div", { class: "sx-scroll", id: "sxScroll" }, sxEl("div", { class: "sx-content", id: "sxContent" }))));
  document.body.append(root);
  sxRoot = root;
  return root;
}

function sxVisibleSections() { return SX_SECTIONS.filter(s => !s.owner || sxIsOwner()); }

function sxRenderNav() {
  const nav = getEl("sxNav");
  if (!nav) return;
  const frag = document.createDocumentFragment();
  for (const s of sxVisibleSections()) {
    const btn = sxEl("button", { type: "button", class: "sx-nav-item" + (s.id === sxSection ? " active" : ""), dataset: { section: s.id }, "aria-current": s.id === sxSection ? "page" : null },
      sxEl("span", { class: "sx-nav-icon" }, sxIcon(s.icon)),
      sxEl("span", { class: "sx-nav-copy" }, sxEl("span", { class: "sx-nav-label", text: s.label }), sxEl("span", { class: "sx-nav-hint", text: s.hint })),
      sxEl("span", { class: "sx-nav-chev" }, sxIcon("M9 6l6 6-6 6")));
    btn.addEventListener("click", () => sxGo(s.id));
    frag.append(btn);
  }
  nav.replaceChildren(frag);
}

const sxIsPhone = () => window.matchMedia("(max-width: 760px)").matches;
function sxShowNav() { if (sxRoot) sxRoot.dataset.view = "nav"; }
function sxShowContent() { if (sxRoot) sxRoot.dataset.view = "content"; }

function sxGo(id) {
  const section = sxVisibleSections().find(s => s.id === id) || sxVisibleSections()[0];
  sxSection = section.id;
  sxRenderNav();
  getEl("sxMainTitle").textContent = section.label;
  sxShowContent();
  renderSettingsSection();
  const scroller = getEl("sxScroll");
  if (scroller) scroller.scrollTop = 0;
}

function renderSettingsSection() {
  const content = getEl("sxContent");
  if (!content || !sxOpen) return;
  const builders = {
    profile: sxProfile, general: sxGeneral, appearance: sxAppearance, personalization: sxPersonalization, memory: sxMemory, voice: sxVoice,
    notifications: sxNotifications, usage: sxUsage, data: sxData, help: sxHelp, developer: sxDeveloper
  };
  const node = (builders[sxSection] || sxProfile)();
  node.classList.add("sx-fade");
  const scroller = getEl("sxScroll");
  const top = scroller ? scroller.scrollTop : 0;
  content.replaceChildren(node);
  if (scroller) scroller.scrollTop = top;
}
/* Re-render the open section only when it is the one that changed (model picker and usage call these). */
function renderSettingsGeneral() { if (sxOpen && sxSection === "general") renderSettingsSection(); }
function renderSettingsUsage() { if (sxOpen && sxSection === "usage") renderSettingsSection(); }

/* ---------- open / close ---------- */
function openSettings(section) {
  sxBuildShell();
  const wanted = Object.hasOwn(SX_ALIASES, section) ? SX_ALIASES[section] : section;
  if (!sxOpen) sxReturnFocus = document.activeElement;
  sxOpen = true;
  sxRoot.hidden = false;
  document.body.classList.add("settings-open");
  closeModelDropdown?.();
  closeChatContextMenu?.();
  sxRenderNav();
  if (wanted) sxGo(wanted);
  else if (sxIsPhone()) { sxSection = "profile"; sxShowNav(); renderSettingsSection(); }
  else sxGo(sxSection || "profile");
  requestAnimationFrame(() => sxRoot.classList.add("open"));
  if (sxSignedIn()) { void refreshTruxProfileInfo?.(); void refreshTruxUsage({ force: true }); }
  sxRoot.querySelector(".sx-icon-btn")?.focus({ preventScroll: true });
}

function closeSettings() {
  if (!sxOpen) return;
  sxOpen = false;
  clearTimeout(sxPzTimer);
  sxFlushPersonalization();
  sxRoot.classList.remove("open");
  document.body.classList.remove("settings-open");
  setTimeout(() => { if (!sxOpen && sxRoot) sxRoot.hidden = true; }, 220);
  try { sxReturnFocus?.focus?.({ preventScroll: true }); } catch {}
}

/* Names older code still calls. */
function openSettingsModal(section) { openSettings(section); }
function closeSettingsModal() { closeSettings(); }
function closeProfileModal() { closeSettings(); }
function switchSettingsSection(name) { openSettings(name); }
function openProfileOption(key) { openSettings(key === "help" ? "help" : key === "account" ? "profile" : key); }
function closeProfileOption() {}

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && sxOpen) {
    if (sxIsPhone() && sxRoot.dataset.view === "content") sxShowNav();
    else closeSettings();
    event.stopPropagation();
  }
}, true);
window.addEventListener("trux-auth", () => { if (sxOpen) { sxRenderNav(); renderSettingsSection(); } });
window.addEventListener("trux-profile", () => { if (sxOpen && sxSection === "profile") renderSettingsSection(); });
window.addEventListener("trux-memory-changed", () => { if (sxOpen && sxSection === "memory") renderSettingsSection(); });
window.addEventListener("trux-personalization-status", event => {
  const status = getEl("sxPzStatus");
  if (!status) return;
  status.textContent = event.detail?.text || "";
  status.classList.toggle("err", !!event.detail?.error);
  clearTimeout(status._t);
  if (!event.detail?.error) status._t = setTimeout(() => { status.textContent = ""; }, 2200);
});

/* ================= Profile ================= */
function sxProfile() {
  const user = auth?.currentUser;
  const page = sxEl("div", { class: "sx-page" }, sxHead("Profile", "Your account details and plan."));
  if (!user) { page.append(sxSignInNeeded("see your profile")); return page; }
  const name = user.displayName || String(user.email || "").split("@")[0] || "User";
  const providers = (user.providerData || []).map(p => p?.providerId);
  const method = [providers.includes("google.com") && "Google", providers.includes("password") && "Email and password"].filter(Boolean).join(" and ") || "Email";
  const avatar = sxEl("img", { class: "sx-avatar", id: "modalAvatar", alt: "", referrerpolicy: "no-referrer", src: document.getElementById("userAvatar")?.src || "" });
  const badges = [sxEl("span", { class: "sx-badge plan", text: sxPlanName() })];
  if (sxIsOwner()) badges.push(sxEl("span", { class: "sx-badge owner", text: "Developer" }));
  page.append(sxEl("section", { class: "sx-hero" }, avatar,
    sxEl("div", { class: "sx-hero-copy" },
      sxEl("div", { class: "sx-hero-name", id: "modalName", text: name }),
      sxEl("div", { class: "sx-hero-email", id: "modalEmail", text: user.email || "" }),
      sxEl("div", { class: "sx-badges" }, badges)),
    sxEl("div", { class: "sx-hero-actions" },
      sxButton("Change photo", () => openAvatarPicker()),
      store.getItem("trux_avatar_override") ? sxButton("Reset photo", () => { resetAvatarOverride(); renderSettingsSection(); }, "quiet") : null)));

  const nameInput = sxEl("input", { class: "sx-input", id: "truxAccountDisplayName", type: "text", maxlength: "60", placeholder: "Your name", "aria-label": "Display name", autocomplete: "name" });
  nameInput.value = user.displayName || "";
  nameInput.addEventListener("keydown", e => { if (e.key === "Enter") saveTruxDisplayName(); });
  page.append(sxGroup("Display name", "Shown in the sidebar and used to greet you.",
    sxRow("Name", null, sxEl("div", { class: "sx-inline" }, nameInput, sxButton("Save", () => saveTruxDisplayName(), "primary")), { stack: true })));

  const plan = truxUsage?.tier || currentPlanTier;
  page.append(sxGroup("Account details", null,
    sxDetail("Email", user.email || "Not available", "truxAccountEmailText"),
    sxDetail("Sign-in method", method, "truxAccountMethodText"),
    sxDetail("Email verified", user.emailVerified || providers.includes("google.com") ? "Yes" : "Not yet"),
    sxDetail("Plan", sxIsOwner() ? "Owner (all models, no limits)" : (SX_PLAN_NAMES[plan] || "Free")),
    sxDetail("Account created", sxDate(user.metadata?.creationTime)),
    sxDetail("Last sign-in", sxDate(user.metadata?.lastSignInTime)),
    sxDetail("User ID", user.uid, null, () => { navigator.clipboard?.writeText(user.uid).then(() => toast("User ID copied.", "ok"), () => toast("Couldn't copy.", "err")); })));

  const actions = [];
  actions.push(sxRow("Plans", "Compare what each plan includes.", sxButton("View plans", () => { closeSettings(); openSubscriptionPage(); })));
  if (truxUsesPassword(user)) actions.push(sxRow("Password", "We'll email you a link to set a new one.", sxButton("Send reset link", async () => {
    try { await auth.sendPasswordResetEmail(user.email, { url: location.origin + "/" }); toast("Password reset email sent.", "ok"); }
    catch (error) { toast(friendlyAuthError(error), "err"); }
  })));
  actions.push(sxRow("Pinned insights", "Answers you pinned from chats.", sxButton("Open", () => { closeSettings(); openPinnedInsightsModal(); })));
  actions.push(sxRow("Sign out", "You'll need to sign in again on this device.", sxButton("Sign out", () => { if (confirm("Sign out of TruX on this device?")) confirmSignOut(); }, "danger")));
  page.append(sxGroup("Account", null, ...actions));
  return page;
}
function sxDetail(label, value, id, onCopy) {
  const val = sxEl("div", { class: "sx-detail-value sx-selectable", id, text: value });
  return sxEl("div", { class: "sx-row detail" }, sxEl("div", { class: "sx-row-copy" }, sxEl("div", { class: "sx-row-title", text: label })),
    sxEl("div", { class: "sx-row-control" }, val, onCopy ? sxButton("Copy", onCopy, "quiet") : null));
}

/* ================= General ================= */
function sxGeneral() {
  const page = sxEl("div", { class: "sx-page" }, sxHead("General", "Choose your model and how chat behaves."));
  const list = sxEl("div", { class: "sx-models", role: "radiogroup", "aria-label": "Default model" });
  for (const m of TRUX_MODELS) {
    const locked = truxModelLocked(m.id), usage = truxModelUsage(m.id), exhausted = !locked && truxModelExhausted(m.id);
    const active = m.id === truxSelectedModel && !locked;
    const side = locked ? sxIcon("M5 11h14v9H5zM8.5 11V8a3.5 3.5 0 0 1 7 0v3")
      : sxEl("span", { class: "sx-model-note", text: exhausted ? "Limit reached" : usage.limit !== null ? truxFormatTokens(usage.remaining) + " left today" : "No daily limit" });
    const row = sxEl("button", { type: "button", role: "radio", "aria-checked": String(active), class: "sx-model" + (active ? " on" : "") + (locked ? " locked" : "") },
      sxEl("span", { class: "sx-model-copy" },
        sxEl("span", { class: "sx-model-name" }, m.name, m.plan ? sxEl("span", { class: "edge-tag", text: "Edge" }) : null),
        sxEl("span", { class: "sx-model-desc", text: m.description })),
      sxEl("span", { class: "sx-model-side" }, side));
    row.addEventListener("click", () => selectModel(m.id));
    list.append(row);
  }
  page.append(sxGroup("Default model", "Used for new messages. You can also switch from the message bar.", sxEl("div", { class: "sx-pad" }, list)));
  page.append(sxGroup("Chat", null,
    sxRow("Press Enter to send", "Turn off to send with Shift + Enter, or Ctrl + Enter, and use Enter for a new line.",
      sxSwitch(truxEnterToSend(), on => store.setItem("trux_enter_to_send", on ? "true" : "false"), "Press Enter to send")),
    sxRow("Read answers aloud", "Speak each answer when it finishes, using your chosen voice.",
      sxSwitch(truxAutoRead(), on => store.setItem("trux_auto_read", on ? "true" : "false"), "Read answers aloud"))));
  page.append(sxGroup("Assistant", null,
    sxRow("Circle to search", "Circle or tap anything on your screen and ask about it.", sxButton("Try it", () => { closeSettings(); setTimeout(() => window.truxCircle?.start?.(), 260); })),
    sxRow("Phone actions", "Ask TruX to call, text, navigate or play something. It opens the right app and you confirm there.", null)));
  return page;
}

/* ================= Appearance ================= */
function sxAppearance() {
  const page = sxEl("div", { class: "sx-page" }, sxHead("Appearance", "Make TruX comfortable to read and look at."));
  const current = truxNormalizeTheme(store.getItem("trux_theme") || "system");
  const themes = sxEl("div", { class: "sx-themes", role: "radiogroup", "aria-label": "Theme" });
  for (const [id, label] of [["system", "System"], ["light", "Light"], ["dark", "Dark"]]) {
    const card = sxEl("button", { type: "button", role: "radio", class: "sx-theme" + (id === current ? " on" : ""), "aria-checked": String(id === current), dataset: { preview: id } },
      sxEl("span", { class: "sx-theme-art" }, sxEl("i"), sxEl("i"), sxEl("i")), sxEl("span", { class: "sx-theme-label", text: label }));
    card.addEventListener("click", () => {
      applyTruxTheme(id);
      themes.querySelectorAll(".sx-theme").forEach(x => { const on = x === card; x.classList.toggle("on", on); x.setAttribute("aria-checked", String(on)); });
    });
    themes.append(card);
  }
  page.append(sxGroup("Theme", "System follows your device's light or dark setting.", sxEl("div", { class: "sx-pad" }, themes)));

  const accent = document.body.dataset.accent || "blue";
  const swatches = sxEl("div", { class: "sx-swatches", role: "radiogroup", "aria-label": "Accent colour" });
  for (const [id, colour] of SX_ACCENTS) {
    const b = sxEl("button", { type: "button", role: "radio", class: "sx-swatch" + (id === accent ? " on" : ""), "aria-checked": String(id === accent), "aria-label": id[0].toUpperCase() + id.slice(1), dataset: { accentOption: id }, style: "--sw:" + colour });
    b.addEventListener("click", () => {
      applyTruxAccent(id);
      swatches.querySelectorAll(".sx-swatch").forEach(x => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", String(x === b)); });
    });
    swatches.append(b);
  }
  page.append(sxGroup("Accent colour", "Used for buttons, links and highlights.", sxEl("div", { class: "sx-pad" }, swatches)));

  page.append(sxGroup("Reading", null,
    sxRow("Text size", "Changes the size of messages and menus.",
      sxSegmented([["small", "Small"], ["default", "Default"], ["large", "Large"]], store.getItem("trux_text_size") || "default", size => applyTruxTextSize(size), "Text size")),
    sxRow("Ambient glow", "A soft coloured glow behind the chat.", sxSwitch(store.getItem("trux_ambient_glow") !== "false", on => applyAmbientGlow(on), "Ambient glow"))));
  return page;
}

/* ================= Personalization ================= */
function sxPzField(label, key, { multiline = false, placeholder = "", rows = 4 } = {}) {
  const max = TRUX_PERSONALIZATION_LIMITS[key];
  const input = sxEl(multiline ? "textarea" : "input", { class: "sx-input" + (multiline ? " area" : ""), maxlength: String(max), placeholder, "aria-label": label, rows: multiline ? String(rows) : null, type: multiline ? null : "text" });
  input.value = truxPersonalization[key] || "";
  const counter = multiline ? sxEl("div", { class: "sx-counter", text: input.value.length + " / " + max }) : null;
  input.addEventListener("input", () => {
    if (counter) counter.textContent = input.value.length + " / " + max;
    sxQueuePersonalization({ [key]: input.value });
  });
  return { input, counter };
}
let sxPzPending = {};
function sxQueuePersonalization(patch) {
  Object.assign(sxPzPending, patch);
  clearTimeout(sxPzTimer);
  sxPzTimer = setTimeout(sxFlushPersonalization, 700);
}
function sxFlushPersonalization() {
  clearTimeout(sxPzTimer);
  const patch = sxPzPending;
  sxPzPending = {};
  if (Object.keys(patch).length && sxSignedIn()) void saveTruxPersonalization(patch);
}
function sxPzNow(patch) { void saveTruxPersonalization(patch); }

function sxPersonalization() {
  const page = sxEl("div", { class: "sx-page" }, sxHead("Personalization", "Tell TruX how you like to be helped. Changes save automatically, sync to your devices and apply to your next message."));
  if (!sxSignedIn()) { page.append(sxSignInNeeded("personalize TruX")); return page; }
  const status = sxEl("div", { class: "sx-status", id: "sxPzStatus", "aria-live": "polite" });
  page.append(status);
  if (truxPersonalizationLoadedFor !== auth.currentUser.uid) {
    page.append(sxEl("div", { class: "sx-loading", text: "Loading your preferences…" }));
    loadTruxPersonalization().then(() => { if (sxOpen && sxSection === "personalization") renderSettingsSection(); });
    return page;
  }
  const pz = truxPersonalization;

  /* tone */
  const sample = sxEl("div", { class: "sx-sample sx-selectable" });
  const paintSample = id => { sample.replaceChildren(sxEl("div", { class: "sx-sample-label", text: "Example answer: how do I boil an egg?" }), sxEl("div", { class: "sx-sample-text", text: TRUX_PRESET_SAMPLES[id] || "" })); };
  paintSample(pz.preset);
  const grid = sxEl("div", { class: "sx-presets", role: "radiogroup", "aria-label": "Personality" });
  for (const [id, label, desc, colour] of TRUX_PERSONALITY_PRESETS) {
    const b = sxEl("button", { type: "button", role: "radio", class: "sx-preset" + (id === pz.preset ? " on" : ""), "aria-checked": String(id === pz.preset), style: "--pc:" + colour },
      sxEl("span", { class: "sx-preset-dot" }), sxEl("span", { class: "sx-preset-label", text: label }), sxEl("span", { class: "sx-preset-desc", text: desc }));
    b.addEventListener("click", () => {
      grid.querySelectorAll(".sx-preset").forEach(x => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", String(x === b)); });
      paintSample(id);
      sxPzNow({ preset: id });
    });
    grid.append(b);
  }
  page.append(sxGroup("Personality", "Sets tone, length and format in chat and Live.", sxEl("div", { class: "sx-pad" }, grid, sample)));

  /* about you */
  const nick = sxPzField("What should TruX call you?", "nickname", { placeholder: "A nickname or first name" });
  const job = sxPzField("What do you do?", "occupation", { placeholder: "For example: product designer, student, nurse" });
  const about = sxPzField("Anything else TruX should know?", "about", { multiline: true, rows: 4, placeholder: "Interests, goals, background, how you like to learn…" });
  page.append(sxGroup("About you", "TruX uses this to tailor answers. Only you can see it.",
    sxRow("What should TruX call you?", null, nick.input, { stack: true }),
    sxRow("What do you do?", null, job.input, { stack: true }),
    sxRow("Anything else TruX should know?", null, sxEl("div", { class: "sx-field" }, about.input, about.counter), { stack: true })));

  /* instructions */
  const instr = sxPzField("Custom instructions", "instructions", { multiline: true, rows: 6, placeholder: "For example: keep answers short, use bullet points, always show code first." });
  const chips = sxEl("div", { class: "sx-chips" }, TRUX_INSTRUCTION_SNIPPETS.map(([label, text]) => {
    const chip = sxEl("button", { type: "button", class: "sx-chip", text: "+ " + label });
    chip.addEventListener("click", () => {
      const cur = instr.input.value.trim();
      if (cur.includes(text)) return toast("Already added.");
      const next = (cur ? cur + "\n" : "") + text;
      if (next.length > TRUX_PERSONALIZATION_LIMITS.instructions) return toast("That would be too long.", "err");
      instr.input.value = next;
      instr.counter.textContent = next.length + " / " + TRUX_PERSONALIZATION_LIMITS.instructions;
      sxQueuePersonalization({ instructions: next });
    });
    return chip;
  }));
  page.append(sxGroup("Custom instructions", "Rules TruX follows in every chat. Tap a suggestion to add it.",
    sxRow("Instructions", null, sxEl("div", { class: "sx-field" }, instr.input, instr.counter, chips), { stack: true })));

  /* style */
  page.append(sxGroup("Response style", null,
    sxRow("Language", "The language TruX answers in.", sxSelect(TRUX_RESPONSE_LANGUAGES, pz.language, v => sxPzNow({ language: v }), "Response language")),
    sxRow("Length", "How much detail answers go into.", sxSegmented([["default", "Balanced"], ["short", "Short"], ["detailed", "Detailed"]], pz.length, v => sxPzNow({ length: v }), "Answer length")),
    sxRow("Emoji", "How often TruX uses emoji.", sxSegmented([["never", "Never"], ["default", "Sometimes"], ["often", "Often"]], pz.emoji, v => sxPzNow({ emoji: v }), "Emoji use"))));

  page.append(sxGroup("Memory", null,
    sxRow("Remember things about me", "TruX can save useful facts, like your preferences, to use in later chats. Manage them in the Memory section.",
      sxSwitch(pz.memoryEnabled, on => sxPzNow({ memoryEnabled: on }), "Remember things about me")),
    sxRow("Manage memories", null, sxButton("Open Memory", () => sxGo("memory")))));
  return page;
}

/* ================= Memory ================= */
function sxMemory() {
  const page = sxEl("div", { class: "sx-page" }, sxHead("Memory", "Things TruX saved from your chats so it can help you better next time."));
  if (!sxSignedIn()) { page.append(sxSignInNeeded("see your memories")); return page; }
  const holder = sxEl("div", { class: "sx-card sx-memory" }, sxEl("div", { class: "sx-loading", text: "Loading memories…" }));
  const head = sxEl("div", { class: "sx-toolbar" }, sxEl("span", { class: "sx-toolbar-count", id: "sxMemCount", text: "" }),
    sxButton("Forget everything", async () => { if (await clearAllMemories()) renderSettingsSection(); }, "danger"));
  page.append(sxGroup(null, null, sxRow("Memory is " + (truxPersonalization.memoryEnabled ? "on" : "off"),
    truxPersonalization.memoryEnabled ? "TruX can save new memories as you chat." : "TruX won't save anything new. Existing memories are still used.",
    sxButton("Change", () => sxGo("personalization")))));
  page.append(head, holder);
  fetchTruxMemories().then(list => {
    if (!sxOpen || sxSection !== "memory") return;
    const count = getEl("sxMemCount");
    if (count) count.textContent = list.length ? list.length + (list.length === 1 ? " memory" : " memories") : "";
    if (!list.length) { holder.replaceChildren(sxEl("div", { class: "sx-empty" }, sxEl("p", { text: "Nothing saved yet. As you chat, TruX will remember useful details about you here." }))); return; }
    holder.replaceChildren(...list.map(m => {
      const del = sxEl("button", { type: "button", class: "sx-icon-btn small", "aria-label": "Forget this memory" }, sxIcon("M6 7h12M10 7V5h4v2M8 7l1 12h6l1-12"));
      const row = sxEl("div", { class: "sx-mem" }, sxEl("div", { class: "sx-mem-copy" }, sxEl("div", { class: "sx-mem-text sx-selectable", text: m.text }),
        sxEl("div", { class: "sx-mem-meta", text: [m.topic, m.createdAt ? sxDate(m.createdAt) : ""].filter(Boolean).join(" · ") })), del);
      del.addEventListener("click", async () => {
        try { await deleteTruxMemory(m.id); row.remove(); const left = holder.querySelectorAll(".sx-mem").length; if (count) count.textContent = left ? left + (left === 1 ? " memory" : " memories") : ""; if (!left) renderSettingsSection(); }
        catch { toast("Couldn't forget that memory.", "err"); }
      });
      return row;
    }));
  }).catch(() => { if (sxOpen && sxSection === "memory") holder.replaceChildren(sxEl("div", { class: "sx-empty" }, sxEl("p", { text: "Couldn't load memories. Check your connection and reopen this page." }))); });
  return page;
}

/* ================= Voice & audio ================= */
function sxVoice() {
  const page = sxEl("div", { class: "sx-page" }, sxHead("Voice & audio", "How TruX sounds and how you talk to it."));
  const selected = truxSelectedVoice();
  const grid = sxEl("div", { class: "sx-voices", role: "radiogroup", "aria-label": "Voice" });
  for (const [id, style, gender] of TRUX_GEMINI_VOICES) {
    const play = sxEl("span", { class: "sx-voice-play", role: "button", tabindex: "0", "aria-label": "Preview " + id }, sxIcon("M8 5v14l11-7z"));
    const b = sxEl("div", { class: "sx-voice" + (id === selected ? " on" : ""), role: "radio", tabindex: "0", "aria-checked": String(id === selected) },
      sxEl("span", { class: "sx-voice-copy" }, sxEl("span", { class: "sx-voice-name", text: id }), sxEl("span", { class: "sx-voice-style", text: style + (gender === "f" ? " · Female" : " · Male") })), play);
    const choose = () => {
      grid.querySelectorAll(".sx-voice").forEach(x => { const on = x === b; x.classList.toggle("on", on); x.setAttribute("aria-checked", String(on)); });
      saveSpeechVoice(id);
    };
    b.addEventListener("click", event => { if (event.target.closest(".sx-voice-play")) return; choose(); });
    b.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(); } });
    const preview = event => { event.stopPropagation(); previewSpeechVoice(id, play); };
    play.addEventListener("click", preview);
    play.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") preview(e); });
    grid.append(b);
  }
  page.append(sxGroup("TruX's voice", "Used for TruX Live and read aloud. Tap the play button to hear a voice.", sxEl("div", { class: "sx-pad" }, grid)));
  const rate = String(store.getItem("trux_tts_rate") || "1");
  page.append(sxGroup("Read aloud", null,
    sxRow("Speaking speed", null, sxSelect([["0.8", "0.8x, slower"], ["1", "1x, normal"], ["1.2", "1.2x, faster"], ["1.5", "1.5x, fast"], ["2", "2x, fastest"]], ["0.8", "1", "1.2", "1.5", "2"].includes(rate) ? rate : "1", v => saveTTSRate(v), "Speaking speed")),
    sxRow("Read answers aloud", "Speak each answer when it finishes.", sxSwitch(truxAutoRead(), on => store.setItem("trux_auto_read", on ? "true" : "false"), "Read answers aloud"))));
  page.append(sxGroup("Dictation", "When you tap the microphone to speak a message.",
    sxRow("Language", null, sxSelect(TRUX_DICTATION_LANGUAGES, store.getItem("trux_dictation_language") || "auto", v => saveDictationLanguage(v), "Dictation language")),
    sxRow("Keep dictation history on this device", "Saves the last 30 phrases you dictated. Off by default.",
      sxSwitch(store.getItem("trux_dictation_history") === "true", on => { store.setItem("trux_dictation_history", on ? "true" : "false"); if (!on) store.removeItem("trux_dictation_history_items"); renderSettingsSection(); }, "Keep dictation history")),
    store.getItem("trux_dictation_history") === "true" ? sxRow("Saved phrases", dictationHistoryItems().length + " on this device", sxButton("Clear", () => { store.removeItem("trux_dictation_history_items"); renderSettingsSection(); toast("Dictation history cleared.", "ok"); }, "quiet")) : null));
  return page;
}

/* ================= Notifications ================= */
function sxNotifications() {
  const page = sxEl("div", { class: "sx-page" }, sxHead("Notifications", "Alerts from this device. Nothing is sent to your email."));
  const supported = "Notification" in window;
  const granted = supported && Notification.permission === "granted";
  const status = sxEl("span", { id: "notificationStatusText", text: supported ? (Notification.permission === "denied" ? "Blocked in your browser settings." : "Permission: " + Notification.permission) : "Not supported on this browser." });
  const toggle = sxSwitch(granted, async on => { await toggleTruxNotificationsSetting(on); renderSettingsSection(); }, "Response notifications");
  toggle.querySelector("input").id = "notificationsToggle";
  toggle.querySelector("input").disabled = !supported || Notification.permission === "denied";
  page.append(sxGroup("Responses", null, sxRow("Response alerts", null, toggle),
    sxEl("div", { class: "sx-row-note" }, "TruX alerts you when a long answer, image or video finishes while you're in another tab. ", status)));
  const on = store.getItem("trux_focus_reminder") === "true";
  page.append(sxGroup("Focus reminders", "A gentle nudge to take a break while TruX is open.",
    sxRow("Break reminders", null, sxSwitch(on, v => { store.setItem("trux_focus_reminder", v ? "true" : "false"); applyTimeManagementSettings(); renderSettingsSection(); }, "Break reminders")),
    on ? sxRow("Remind me every", null, sxSelect([["25", "25 minutes"], ["45", "45 minutes"], ["60", "1 hour"], ["90", "90 minutes"]], ["25", "45", "60", "90"].includes(store.getItem("trux_focus_interval")) ? store.getItem("trux_focus_interval") : "45", v => { store.setItem("trux_focus_interval", v); applyTimeManagementSettings(); }, "Reminder interval")) : null));
  return page;
}

/* ================= Usage & limits ================= */
function sxMeter(used, limit) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const bar = sxEl("div", { class: "sx-meter-bar" + (pct >= 100 ? " full" : pct >= 80 ? " warn" : "") }, sxEl("i", { style: "width:" + pct + "%" }));
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", String(limit || 0)); bar.setAttribute("aria-valuenow", String(Math.min(used, limit || used)));
  return bar;
}
function sxUsage() {
  const page = sxEl("div", { class: "sx-page" }, sxHead("Usage & limits", "What you've used and what's left on your plan."));
  if (!sxSignedIn()) { page.append(sxSignInNeeded("see your usage")); return page; }
  const owner = sxIsOwner();
  page.append(sxEl("section", { class: "sx-plan" },
    sxEl("div", null, sxEl("div", { class: "sx-plan-label", text: "Your plan" }), sxEl("div", { class: "sx-plan-name", text: sxPlanName() })),
    owner ? sxEl("div", { class: "sx-plan-note", text: "Every model, no limits." }) : sxButton("View plans", () => { closeSettings(); openSubscriptionPage(); }, "primary")));

  const rows = [];
  for (const m of TRUX_MODELS) {
    const locked = truxModelLocked(m.id), u = truxModelUsage(m.id);
    const title = sxEl("div", { class: "sx-use-title" }, m.name, m.plan ? sxEl("span", { class: "edge-tag", text: "Edge" }) : null);
    let body;
    if (locked) body = sxEl("div", { class: "sx-use-body" }, sxEl("div", { class: "sx-use-line", text: "Included with the Edge plan." }), sxButton("Upgrade to Edge", () => { closeSettings(); openSubscriptionPage(); }, "quiet"));
    else if (u.limit === null) body = sxEl("div", { class: "sx-use-body" }, sxEl("div", { class: "sx-use-line", text: m.id === "spark" ? "No daily limit." : "No daily limit on your plan." }));
    else body = sxEl("div", { class: "sx-use-body" }, sxMeter(u.used, u.limit),
      sxEl("div", { class: "sx-use-line" }, sxEl("b", { text: truxFormatTokens(u.used) }), " of " + truxFormatTokens(u.limit) + " tokens used today",
        sxEl("span", { class: "sx-use-left", text: u.remaining <= 0 ? "Limit reached" : truxFormatTokens(u.remaining) + " left" })));
    rows.push(sxEl("div", { class: "sx-use" }, sxEl("div", { class: "sx-use-head" }, title, sxEl("div", { class: "sx-use-desc", text: m.description })), body));
  }
  page.append(sxGroup("Daily model limits", "Quasar and Aegis have a daily token allowance. Tokens are the words TruX writes, plus the thinking it does before answering. Resets every day at " + truxResetLabel() + ".", ...rows));

  const monthly = truxUsage?.monthly;
  const tool = (label, desc, data) => {
    const body = !data ? sxEl("div", { class: "sx-use-line", text: "Loading…" })
      : data.limit === null ? sxEl("div", { class: "sx-use-line", text: "Unlimited on your plan." })
      : sxEl("div", { class: "sx-use-body" }, sxMeter(data.used, data.limit), sxEl("div", { class: "sx-use-line" }, sxEl("b", { text: String(data.used) }), " of " + data.limit + " used this month"));
    return sxEl("div", { class: "sx-use" }, sxEl("div", { class: "sx-use-head" }, sxEl("div", { class: "sx-use-title", text: label }), sxEl("div", { class: "sx-use-desc", text: desc })), body);
  };
  page.append(sxGroup("Monthly tools", "Resets on the first of each month.",
    tool("Image generation", "Images created in chat and in the Image workspace.", monthly?.images),
    tool("Deep research", "Long, source-backed research reports.", monthly?.deepResearch)));
  if (!truxUsage) page.append(sxEl("div", { class: "sx-status", text: "Fetching your latest numbers…" }));
  return page;
}

/* ================= Data & privacy ================= */
function sxData() {
  const page = sxEl("div", { class: "sx-page" }, sxHead("Data & privacy", "Control what TruX keeps and what this device shares."));
  const enabled = store.getItem("trux_location_enabled") !== "false";
  const loc = sxSwitch(enabled, on => { toggleTruxLocationAccess(on); }, "Use my location");
  loc.querySelector("input").id = "locationAccessToggle";
  page.append(sxGroup("Privacy", null,
    sxRow("Use my location", "Lets TruX answer things like “restaurants near me”. Your position is only sent with that message.", loc),
    sxEl("div", { class: "sx-row-note", id: "locationStatusText" })));
  try { updateLocationSettingUI(); } catch {}

  const archived = archivedChatList();
  const archivedRows = archived.map(([id, chat]) => sxRow(chat.title || "Untitled chat", null, sxButton("Restore", () => { restoreArchivedChat(id); renderSettingsSection(); }, "quiet")));
  page.append(sxGroup("Your data", null,
    sxRow("Export your data", "Download your chats, personalization and memories as a JSON file.", sxButton("Export", () => exportTruxMemory())),
    sxRow("Archive all chats", "Moves every chat out of your history. You can restore them below.", sxButton("Archive", () => { if (archiveAllHistory()) renderSettingsSection(); })),
    sxRow("Delete all chats", "Removes your chat history from every device. This can't be undone.", sxButton("Delete", () => { if (clearAllHistory()) renderSettingsSection(); }, "danger"))));
  if (archived.length) page.append(sxGroup("Archived chats", archived.length + (archived.length === 1 ? " chat" : " chats") + " you can restore.", ...archivedRows));

  page.append(sxGroup("This device", "Theme, text size, send key and similar choices are stored on this device only.",
    sxRow("Reset device settings", "Puts appearance and device choices back to the defaults. Your account, chats and memory aren't affected.", sxButton("Reset", () => { if (resetAllSettings()) renderSettingsSection(); }))));
  return page;
}

/* ================= Help & feedback ================= */
function sxForm(kind) {
  const form = sxEl("form", { class: "sx-form", onsubmit: event => (kind === "founder" ? submitFounderQuery(event) : submitHelpFeedback(event)) });
  if (kind === "feedback") form.append(sxEl("label", null, "What is it about?", sxEl("select", { class: "sx-select", name: "type" },
    [["bug-report", "A bug or problem"], ["product-feedback", "General feedback"], ["feature-request", "A feature idea"], ["general-feedback", "Something else"]].map(([v, t]) => sxEl("option", { value: v, text: t })))));
  form.append(sxEl("label", null, kind === "founder" ? "Subject" : "Subject (optional)", sxEl("input", { class: "sx-input", name: "subject", type: "text", maxlength: "160", required: kind === "founder" ? true : null, placeholder: kind === "founder" ? "What is your question about?" : "A short title" })),
    sxEl("label", null, "Details", sxEl("textarea", { class: "sx-input area", name: "message", rows: "5", minlength: "8", maxlength: "12000", required: true, placeholder: kind === "founder" ? "Write your question…" : "What happened, what you expected, and the steps to reproduce it. Please don't include passwords." })),
    sxEl("button", { type: "submit", class: "sx-btn primary", text: kind === "founder" ? "Send to the founder" : "Send feedback" }));
  return form;
}
function sxHelp() {
  const page = sxEl("div", { class: "sx-page" }, sxHead("Help & feedback", "Quick answers, and a direct line to the team."));
  const faq = (q, a) => sxEl("details", { class: "sx-faq" }, sxEl("summary", { text: q }), sxEl("p", { text: a }));
  page.append(sxGroup("Using TruX", null, sxEl("div", { class: "sx-pad flush" },
    faq("Which model should I pick?", "Spark is the fastest and doesn't reason. Quasar suits everyday tasks. Aegis is for complex, multi-step reasoning. Oracle, on the Edge plan, is for the toughest problems."),
    faq("How do daily limits work?", "Quasar has 100,000 tokens a day and Aegis has 50,000. Tokens count the words TruX writes plus its thinking. Spark has no daily limit. Limits reset every day, and Usage & limits shows what's left."),
    faq("What can I do with the + menu?", "Attach photos and files, take a picture, start Deep Research or create images. Tell TruX what you want done with an attachment."),
    faq("How do I use Live?", "Tap the wave button in the message bar to talk with TruX. Allow the microphone, and camera or screen only when you want TruX to see them."),
    faq("Where is my data stored?", "Chats, personalization and memories are tied to your account. You can export or delete them any time in Data & privacy."))));
  if (!sxSignedIn()) { page.append(sxSignInNeeded("send feedback")); }
  else {
    page.append(sxGroup("Send feedback or report a bug", "Goes straight to the founder.", sxEl("div", { class: "sx-pad" }, sxForm("feedback"))));
    page.append(sxGroup("Contact the founder", "Replies go to the email on your account.", sxEl("div", { class: "sx-pad" }, sxForm("founder"))));
  }
  page.append(sxGroup("Diagnostics", null,
    sxRow("Check connection", "Tests whether the TruX servers are reachable.", sxButton("Run check", () => checkApiLatency()))));
  return page;
}

/* ================= Developer (owner only) ================= */
function sxDeveloper() {
  const page = sxEl("div", { class: "sx-page" }, sxHead("Developer", "Tools for the TruX owner account."));
  if (!sxIsOwner()) { page.append(sxEl("div", { class: "sx-empty" }, sxEl("p", { text: "This section is only available to the owner account." }))); return page; }
  const select = sxEl("select", { class: "sx-select wide", id: "ownerGeminiModelSelect", "aria-label": "Model override", onchange: e => saveOwnerGeminiModel(e.target.value) }, sxEl("option", { value: "auto", text: "Off, use the selected TruX model" }));
  page.append(sxGroup("Model override", "Send chat to any model listed in Google Cloud instead of the TruX model you picked. Only affects your account.",
    sxRow("Active override", null, sxEl("b", { id: "ownerModelStateText", text: "Off" })),
    sxRow("Model", null, select, { stack: true }),
    sxRow("Catalog", null, sxEl("div", { class: "sx-inline" }, sxButton("Refresh models", () => loadOwnerGeminiModels(true)), sxEl("span", { class: "sx-row-desc", id: "ownerGeminiModelStatus", text: "Loading…" })))));
  void loadOwnerGeminiModels(false);
  return page;
}
