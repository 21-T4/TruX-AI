/* Device preferences: theme, text size, glow, send key, read-aloud, dictation, focus reminders, archive helpers.
   These live in localStorage on this device. Account-wide preferences (personality, memory, voice) are in
   personalization.js; the Settings screen itself is in settings-ui.js. */
const TRUX_NOTIFICATION_CATEGORIES = ["responses"];
let truxFocusReminderTimer = null;

/* ---------- appearance: System, Light or Dark. Old saved themes migrate to the nearest of the two ---------- */
const TRUX_THEME_MIGRATION = { oled: "dark", dracula: "dark", nord: "dark", "rose-pine": "dark", monokai: "dark", solarized: "dark", hacker: "dark", graphite: "dark", midnight: "dark", forest: "dark", sand: "light" };
const truxSystemLight = window.matchMedia ? matchMedia("(prefers-color-scheme: light)") : null;

function truxNormalizeTheme(theme) {
  const value = TRUX_THEME_MIGRATION[theme] || String(theme || "system");
  return value === "light" || value === "dark" ? value : "system";
}

function applyTruxTheme(theme, persist) {
  const choice = truxNormalizeTheme(theme);
  const resolved = choice === "system" ? (truxSystemLight?.matches ? "light" : "dark") : choice;
  const root = document.documentElement;
  if (root.dataset.theme && root.dataset.theme !== resolved) {          /* ease between themes */
    root.classList.add("theme-fade");
    setTimeout(() => root.classList.remove("theme-fade"), 450);
  }
  root.dataset.theme = resolved;
  root.dataset.scheme = resolved;
  if (persist !== false || choice !== theme) store.setItem("trux_theme", choice);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue("--bg").trim() || (resolved === "light" ? "#faf9f5" : "#262624");
  window.dispatchEvent(new CustomEvent("trux-theme", { detail: { theme: resolved, choice } }));
}
applyTruxTheme(store.getItem("trux_theme") || "system", false);
truxSystemLight?.addEventListener?.("change", () => { if (truxNormalizeTheme(store.getItem("trux_theme") || "system") === "system") applyTruxTheme("system", false); });

/* ---------- reading size ---------- */
const TRUX_TEXT_SIZES = ["small", "default", "large"];
function applyTruxTextSize(size, persist) {
  const next = TRUX_TEXT_SIZES.includes(size) ? size : "default";
  document.documentElement.dataset.textSize = next;
  if (persist !== false) store.setItem("trux_text_size", next);
}
applyTruxTextSize(store.getItem("trux_text_size") || "default", false);

/* ---------- glow, send key, read aloud ---------- */
function applyAmbientGlow(on, persist) {
  const bg = getEl("bg");
  if (bg) bg.style.display = on ? "block" : "none";
  if (persist !== false) store.setItem("trux_ambient_glow", on ? "true" : "false");
}
const truxEnterToSend = () => store.getItem("trux_enter_to_send") !== "false";
const truxAutoRead = () => store.getItem("trux_auto_read") === "true";
function saveTTSRate(value) { store.setItem("trux_tts_rate", String(value)); }

/* ---------- dictation ---------- */
const TRUX_DICTATION_LANGUAGES = [
  ["auto", "Same as my device"], ["en-US", "English (United States)"], ["en-GB", "English (United Kingdom)"], ["en-IN", "English (India)"],
  ["hi-IN", "Hindi"], ["fr-FR", "French"], ["es-ES", "Spanish"], ["de-DE", "German"], ["ja-JP", "Japanese"]
];
function saveDictationLanguage(language) {
  const next = TRUX_DICTATION_LANGUAGES.some(([id]) => id === language) ? language : "auto";
  store.setItem("trux_dictation_language", next);
  if (recognition) recognition.lang = next === "auto" ? (navigator.language || "en-US") : next;
}

function dictationHistoryItems() {
  const rows = store.json("trux_dictation_history_items", []);
  return Array.isArray(rows) ? rows : [];
}

function storeDictationHistory(text) {
  if (store.getItem("trux_dictation_history") !== "true" || !String(text || "").trim()) return;
  const list = dictationHistoryItems();
  list.unshift({ text: String(text).trim().slice(0, 1000), at: new Date().toISOString() });
  store.setItem("trux_dictation_history_items", JSON.stringify(list.slice(0, 30)));
}

/* ---------- focus reminders ---------- */
function applyTimeManagementSettings() {
  if (truxFocusReminderTimer) { clearTimeout(truxFocusReminderTimer); truxFocusReminderTimer = null; }
  if (store.getItem("trux_focus_reminder") !== "true") return;
  const minutes = Math.max(5, Math.min(180, Number(store.getItem("trux_focus_interval") || 45)));
  truxFocusReminderTimer = setTimeout(() => {
    if (!document.hidden) toast("Time for a short break. Stretch, rest your eyes, or step away briefly.", "ok");
    applyTimeManagementSettings();
  }, minutes * 60000);
}

/* ---------- chat history helpers ---------- */
function archivedChatList() {
  return Object.entries(chatSessions || {}).filter(([, chat]) => chat && chat.archived && !chat.incognito);
}

function restoreArchivedChat(id) {
  const chat = chatSessions && chatSessions[id];
  if (!chat || !chat.archived) return;
  chat.archived = false;
  saveChatSessions();
  renderSidebar();
  toast("Chat restored to history.", "ok");
}

function archiveAllHistory() {
  const entries = Object.entries(chatSessions || {}).filter(([, chat]) => chat && !chat.incognito && !chat.archived);
  if (!entries.length) { toast("There are no active chats to archive."); return false; }
  if (!confirm("Archive all chats? You can restore them later from Settings.")) return false;
  entries.forEach(([, chat]) => { chat.archived = true; });
  saveChatSessions();
  if (currentChatId && chatSessions[currentChatId]?.archived) { currentChatId = null; startNewChat(); }
  renderSidebar();
  toast("Chat history archived.", "ok");
  return true;
}

function clearAllHistory() {
  if (!confirm("Remove all chats from your account on every device?")) return false;
  chatSessions = {};
  saveChatSessions();          /* hides them everywhere; stored data is kept */
  currentChatId = null;
  startNewChat();
  renderSidebar();
  toast("Chat history cleared.", "ok");
  return true;
}

/* ---------- start-up: apply everything saved on this device ---------- */
function loadSettings() {
  applyAmbientGlow(store.getItem("trux_ambient_glow") !== "false", false);
  applyTruxTextSize(store.getItem("trux_text_size") || "default", false);
  applyTimeManagementSettings();
}

function resetAllSettings() {
  if (!confirm("Reset the settings stored on this device? Your account, chats and memory are not affected.")) return false;
  ["trux_auto_read", "trux_ambient_glow", "trux_tts_rate", "trux_home_look", "trux_location_enabled", "trux_location_granted", "trux_location_prompted",
   "trux_avatar_override", "trux_theme", "trux_accent", "trux_text_size", "trux_enter_to_send", "trux_model", "trux_dictation_language", "trux_speech_voice",
   "trux_dictation_history", "trux_dictation_history_items", "trux_focus_reminder", "trux_focus_interval", "trux_owner_gemini_model",
   ...TRUX_NOTIFICATION_CATEGORIES.map(k => "trux_notification_cat_" + k)].forEach(k => store.removeItem(k));
  applyTruxTheme("system", false);
  applyTruxAccent("blue", false);
  applyTruxTextSize("default", false);
  truxLoadSelectedModel();
  renderModelPicker();
  loadSettings();
  try { applyStoredAvatar(auth?.currentUser); } catch {}
  return true;
}
