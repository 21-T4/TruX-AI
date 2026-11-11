/* Device-local settings: theme, dictation, read-aloud speed, focus reminders,
   archive. Personalization and memory live in personalization.js (RTDB). */
const TRUX_LOCAL_PREFERENCES = ["dictation_history", "focus_reminder", "focus_interval"];
const TRUX_NOTIFICATION_CATEGORIES = ["responses"];
let truxFocusReminderTimer = null;

function saveProfilePreference(key, value) {
  if (!TRUX_LOCAL_PREFERENCES.includes(key)) return;
  store.setItem("trux_" + key, typeof value === "boolean" ? (value ? "true" : "false") : String(value ?? ""));
  if (key === "dictation_history" && !value) store.removeItem("trux_dictation_history_items");
}

/* Appearance: System, Light or Dark. Old saved themes migrate to the nearest of the two. */
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
  root.dataset.theme = resolved;
  root.dataset.scheme = resolved;
  if (persist !== false || choice !== theme) store.setItem("trux_theme", choice);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue("--bg").trim() || (resolved === "light" ? "#faf9f5" : "#262624");
  const select = getEl("truxThemeSelect"); if (select) select.value = choice;
  window.dispatchEvent(new CustomEvent("trux-theme", { detail: { theme: resolved } }));
}
applyTruxTheme(store.getItem("trux_theme") || "system", false);
truxSystemLight?.addEventListener?.("change", () => { if (truxNormalizeTheme(store.getItem("trux_theme") || "system") === "system") applyTruxTheme("system", false); });

function saveDictationLanguage(language) {
  const allowed = new Set(["auto", "en-US", "en-GB", "hi-IN", "fr-FR", "es-ES", "de-DE", "ja-JP"]);
  const next = allowed.has(language) ? language : "auto";
  store.setItem("trux_dictation_language", next);
  if (recognition) recognition.lang = next === "auto" ? (navigator.language || "en-US") : next;
}

function storeDictationHistory(text) {
  if (store.getItem("trux_dictation_history") !== "true" || !String(text || "").trim()) return;
  const rows = store.json("trux_dictation_history_items", []);
  const list = Array.isArray(rows) ? rows : [];
  list.unshift({ text: String(text).trim().slice(0, 1000), at: new Date().toISOString() });
  store.setItem("trux_dictation_history_items", JSON.stringify(list.slice(0, 30)));
}

function showDictationHistory() {
  const host = getEl("truxDictationHistoryList"); if (!host) return;
  host.replaceChildren();
  const rows = store.json("trux_dictation_history_items", []);
  const list = Array.isArray(rows) ? rows : [];
  const note = document.createElement("p"); note.className = "mrow-sub";
  note.textContent = store.getItem("trux_dictation_history") === "true" ? "Saved locally on this device." : "History saving is off. Turn it on to keep future recognized phrases.";
  host.appendChild(note);
  list.forEach(row => { const item = document.createElement("p"); item.className = "dictation-history-item"; item.textContent = (row.at ? new Date(row.at).toLocaleString() + " - " : "") + String(row.text || ""); host.appendChild(item); });
  if (list.length) {
    const clear = document.createElement("button"); clear.type = "button"; clear.className = "mbtn danger"; clear.textContent = "Delete dictation history";
    clear.onclick = () => { store.removeItem("trux_dictation_history_items"); showDictationHistory(); };
    host.appendChild(clear);
  }
}

function applyTimeManagementSettings() {
  if (truxFocusReminderTimer) { clearTimeout(truxFocusReminderTimer); truxFocusReminderTimer = null; }
  if (store.getItem("trux_focus_reminder") !== "true") return;
  const minutes = Math.max(5, Math.min(180, Number(store.getItem("trux_focus_interval") || 45)));
  truxFocusReminderTimer = setTimeout(() => {
    if (!document.hidden) toast("Time for a short break. Stretch, rest your eyes, or step away briefly.", "ok");
    applyTimeManagementSettings();
  }, minutes * 60000);
}

function openPluginsFromSettings() {
  closeProfileModal();
  if (typeof openPluginsPage === "function") openPluginsPage(); else toast("Plugins are not available right now. Please refresh TruX.", "err");
}

function viewArchivedChats() {
  const host = getEl("archivedChatsList"); if (!host) return;
  host.replaceChildren();
  const rows = Object.entries(chatSessions || {}).filter(([, chat]) => chat && chat.archived && !chat.incognito);
  const title = document.createElement("p"); title.className = "mrow-sub"; title.textContent = rows.length ? "Archived conversations" : "No archived chats.";
  host.appendChild(title);
  rows.forEach(([id, chat]) => {
    const row = document.createElement("div"); row.className = "archived-chat-row";
    const label = document.createElement("span"); label.textContent = chat.title || "Untitled chat";
    const restore = document.createElement("button"); restore.type = "button"; restore.className = "mbtn"; restore.textContent = "Restore";
    restore.onclick = () => restoreArchivedChat(id);
    row.append(label, restore); host.appendChild(row);
  });
}

function restoreArchivedChat(id) {
  const chat = chatSessions && chatSessions[id]; if (!chat || !chat.archived) return;
  chat.archived = false; saveChatSessions(); renderSidebar(); viewArchivedChats(); toast("Chat restored to history.", "ok");
}

function archiveAllHistory() {
  const entries = Object.entries(chatSessions || {}).filter(([, chat]) => chat && !chat.incognito && !chat.archived);
  if (!entries.length) { toast("There are no active chats to archive."); viewArchivedChats(); return; }
  if (!confirm("Archive all regular chat history? You can restore archived chats later.")) return;
  entries.forEach(([, chat]) => { chat.archived = true; });
  saveChatSessions();
  if (currentChatId && chatSessions[currentChatId]?.archived) { currentChatId = null; startNewChat(); }
  renderSidebar(); viewArchivedChats(); toast("Chat history archived.", "ok");
}

function saveTTSRate(val) { store.setItem("trux_tts_rate", val); }
function toggleAmbientGlow(el) { const bg = getEl("bg"); if (bg) bg.style.display = el.checked ? "block" : "none"; store.setItem("trux_ambient_glow", el.checked ? "true" : "false"); }

function loadSettings() {
  const nT = getEl("neonGlowToggle"), aR = getEl("autoReadToggle"), tts = getEl("ttsRateSelect");
  if (nT) { nT.checked = store.getItem("trux_ambient_glow") !== "false"; toggleAmbientGlow(nT); }
  if (aR) aR.checked = store.getItem("trux_auto_read") === "true";
  if (tts) tts.value = store.getItem("trux_tts_rate") || "1.0";
  const values = { truxThemeSelect: ["trux_theme", "system"], truxDictationLanguage: ["trux_dictation_language", "auto"], truxFocusInterval: ["trux_focus_interval", "45"] };
  Object.entries(values).forEach(([id, [key, fallback]]) => { const el = getEl(id); if (el) el.value = store.getItem(key) ?? fallback; });
  const checks = { truxDictationHistoryToggle: ["trux_dictation_history", false], truxFocusReminderToggle: ["trux_focus_reminder", false] };
  Object.entries(checks).forEach(([id, [key, fallback]]) => { const el = getEl(id); if (el) el.checked = store.getItem(key) == null ? fallback : store.getItem(key) === "true"; });
  populateTruxSpeechVoices();
  updateLocationSettingUI();
  updateNotificationSettingsUI();
  applyTimeManagementSettings();
  try { renderPersonalizationForm(); } catch {}
}
