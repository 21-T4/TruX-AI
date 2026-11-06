/* Personalization and memory, stored per user in Realtime Database:
 *   users/{uid}/personalization  {preset, nickname, occupation, about, instructions, memoryEnabled, voice}
 *   users/{uid}/memories/{id}    {text, createdAt}  (written by the AI, deletable here)
 * The server reads both on every chat and Live turn, so changes apply to the
 * next message on every device. */
const TRUX_PERSONALITY_PRESETS = [
  ["default", "Default", "Balanced, warm and clear."],
  ["professional", "Professional", "Polished, precise, no slang."],
  ["friendly", "Friendly", "Warm and conversational."],
  ["concise", "Concise", "Answer first, minimal words."],
  ["creative", "Creative", "Imaginative, original angles."],
  ["mentor", "Mentor", "Explains the why, step by step."],
  ["witty", "Witty", "Clever and playful, still helpful."]
];
const TRUX_PERSONALIZATION_LIMITS = { nickname: 60, occupation: 120, about: 1500, instructions: 3000 };
let truxPersonalization = { preset: "default", nickname: "", occupation: "", about: "", instructions: "", memoryEnabled: true, voice: "Kore" };
let truxPersonalizationLoadedFor = "";
let truxPersonalizationSaveTimer = null;

async function loadTruxPersonalization(force = false) {
  const uid = auth?.currentUser?.uid;
  if (!uid || !rtdb) return truxPersonalization;
  if (!force && truxPersonalizationLoadedFor === uid) return truxPersonalization;
  try {
    const snap = await rtdb.ref(`users/${uid}/personalization`).get();
    const raw = snap.val() || {};
    truxPersonalization = {
      preset: TRUX_PERSONALITY_PRESETS.some(([id]) => id === raw.preset) ? raw.preset : "default",
      nickname: String(raw.nickname || ""), occupation: String(raw.occupation || ""),
      about: String(raw.about || ""), instructions: String(raw.instructions || ""),
      memoryEnabled: raw.memoryEnabled !== false,
      voice: String(raw.voice || store.getItem("trux_speech_voice") || "Kore")
    };
    truxPersonalizationLoadedFor = uid;
    if (raw.voice) store.setItem("trux_speech_voice", raw.voice);
  } catch (error) {
    console.warn("TruX personalization load failed", error?.message || error);
  }
  return truxPersonalization;
}

async function saveTruxPersonalization(patch, { quiet = false } = {}) {
  const uid = auth?.currentUser?.uid;
  const clean = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (key === "memoryEnabled") clean[key] = value === true;
    else if (key === "preset") clean[key] = TRUX_PERSONALITY_PRESETS.some(([id]) => id === value) ? value : "default";
    else if (key === "voice") clean[key] = String(value || "Kore").slice(0, 20);
    else if (TRUX_PERSONALIZATION_LIMITS[key]) clean[key] = String(value || "").slice(0, TRUX_PERSONALIZATION_LIMITS[key]);
  }
  Object.assign(truxPersonalization, clean);
  if (!uid || !rtdb) return;
  try {
    await rtdb.ref(`users/${uid}/personalization`).update(clean);
    if (!quiet) setPersonalizationStatus("Saved");
  } catch (error) {
    setPersonalizationStatus("Couldn't save. Check your connection.", true);
  }
}

function setPersonalizationStatus(text, isError = false) {
  const el = getEl("truxPersonalizationStatus");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("err", isError);
  clearTimeout(el._t);
  if (!isError) el._t = setTimeout(() => { el.textContent = ""; }, 1800);
}

/* Text fields save shortly after typing stops. */
function queuePersonalizationField(input) {
  const key = input?.dataset?.pfield;
  if (!key) return;
  const counter = getEl(input.id + "Count");
  if (counter) counter.textContent = `${input.value.length} / ${TRUX_PERSONALIZATION_LIMITS[key]}`;
  setPersonalizationStatus("Saving…");
  clearTimeout(truxPersonalizationSaveTimer);
  truxPersonalizationSaveTimer = setTimeout(() => saveTruxPersonalization({ [key]: input.value }), 600);
}

function selectPersonalityPreset(id) {
  document.querySelectorAll("[data-preset]").forEach(el => {
    const on = el.dataset.preset === id;
    el.classList.toggle("active", on);
    el.setAttribute("aria-checked", String(on));
  });
  void saveTruxPersonalization({ preset: id });
}

function setMemoryEnabled(on) {
  void saveTruxPersonalization({ memoryEnabled: !!on });
  const list = getEl("truxMemoryList");
  if (list) list.classList.toggle("disabled", !on);
}

async function renderPersonalizationForm() {
  const host = getEl("truxPresetGrid");
  if (host && !host.childElementCount) {
    for (const [id, label, hint] of TRUX_PERSONALITY_PRESETS) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "preset-chip"; b.dataset.preset = id;
      b.setAttribute("role", "radio");
      b.innerHTML = `<b>${escapeHtml(label)}</b><small>${escapeHtml(hint)}</small>`;
      b.onclick = () => selectPersonalityPreset(id);
      host.appendChild(b);
    }
  }
  if (!auth?.currentUser) return;
  const p = await loadTruxPersonalization();
  document.querySelectorAll("[data-preset]").forEach(el => {
    const on = el.dataset.preset === p.preset;
    el.classList.toggle("active", on); el.setAttribute("aria-checked", String(on));
  });
  document.querySelectorAll("[data-pfield]").forEach(el => {
    if (document.activeElement === el) return;
    el.value = p[el.dataset.pfield] || "";
    const counter = getEl(el.id + "Count");
    if (counter) counter.textContent = `${el.value.length} / ${TRUX_PERSONALIZATION_LIMITS[el.dataset.pfield]}`;
  });
  const mem = getEl("truxMemoryEnabledToggle"); if (mem) mem.checked = p.memoryEnabled;
  const voice = getEl("truxSpeechVoiceSelect"); if (voice) voice.value = TRUX_TTS_VOICES.some(([id]) => id === p.voice) ? p.voice : "Kore";
  await refreshTruxMemoryList();
}

async function refreshTruxMemoryList() {
  const list = getEl("truxMemoryList");
  const uid = auth?.currentUser?.uid;
  if (!list || !uid || !rtdb) return;
  let rows = [];
  try {
    const snap = await rtdb.ref(`users/${uid}/memories`).orderByChild("createdAt").limitToLast(200).get();
    const raw = snap.val() || {};
    rows = Object.entries(raw).map(([id, m]) => ({ id, text: String(m?.text || ""), createdAt: Number(m?.createdAt) || 0 }))
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    list.innerHTML = '<p class="mrow-sub">Could not load memories.</p>';
    return;
  }
  list.replaceChildren();
  const count = getEl("truxMemoryCount"); if (count) count.textContent = rows.length ? `${rows.length} saved` : "";
  if (!rows.length) {
    list.innerHTML = '<p class="mrow-sub">Nothing saved yet. TruX notes useful details on its own as you chat, like your preferences or ongoing projects.</p>';
    return;
  }
  for (const m of rows) {
    const row = document.createElement("div"); row.className = "memory-item";
    const text = document.createElement("span"); text.textContent = m.text;
    const del = document.createElement("button"); del.type = "button"; del.className = "memory-del"; del.title = "Forget this"; del.setAttribute("aria-label", "Forget this memory");
    del.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    del.onclick = async () => {
      try { await rtdb.ref(`users/${uid}/memories/${m.id}`).remove(); row.remove(); toast("Memory forgotten.", "ok"); if (!list.childElementCount) refreshTruxMemoryList(); }
      catch { toast("Couldn't delete that memory.", "err"); }
    };
    row.append(text, del); list.appendChild(row);
  }
}

async function clearAllMemories() {
  const uid = auth?.currentUser?.uid;
  if (!uid || !confirm("Forget everything TruX has saved about you?")) return;
  try { await rtdb.ref(`users/${uid}/memories`).remove(); toast("All memories cleared.", "ok"); refreshTruxMemoryList(); }
  catch { toast("Couldn't clear memories.", "err"); }
}

/* Export everything stored for this account as one JSON file. */
async function exportTruxMemory() {
  const uid = auth?.currentUser?.uid;
  if (!uid || !rtdb) { toast("Sign in to export your data.", "err"); return; }
  try {
    const [chats, messages, personalization, memories] = await Promise.all(
      ["chats", "messages", "personalization", "memories"].map(k => rtdb.ref(`users/${uid}/${k}`).get().then(s => s.val() || {}))
    );
    const payload = { version: 3, exportedAt: new Date().toISOString(), email: auth.currentUser.email || "", chats, messages, personalization, memories, pinnedInsights };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `trux-export-${Date.now()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch { toast("Export failed. Check your connection.", "err"); }
}

function exportChatData() { return exportTruxMemory(); }

function resetAllSettings() {
  if (!confirm("Reset all settings on this device?")) return;
  ["trux_auto_read", "trux_ambient_glow", "trux_tts_rate", "trux_home_look", "trux_location_enabled", "trux_location_granted", "trux_location_prompted",
   "trux_avatar_override", "trux_theme", "trux_dictation_language", "trux_speech_voice", "trux_dictation_history", "trux_dictation_history_items",
   "trux_focus_reminder", "trux_focus_interval", ...TRUX_NOTIFICATION_CATEGORIES.map(k => "trux_notification_cat_" + k)].forEach(k => store.removeItem(k));
  applyTruxTheme("dark", false);
  loadSettings();
}
