/* Personalization and memory data, stored per user in Realtime Database:
 *   users/{uid}/personalization  {preset, nickname, occupation, about, instructions, memoryEnabled, voice, language, length, emoji}
 *   users/{uid}/memories/{id}    {text, kind, topic, importance, createdAt, updatedAt}  (written by the AI, deletable here)
 * Everything goes through /api/data (Admin SDK), so it works whatever state the database rules are in.
 * The server reads both on every chat and Live turn, so a change applies to the next message on every device.
 * The screens that edit all of this are in settings-ui.js. */
const TRUX_PERSONALITY_PRESETS = [
  // id, label, one-line description, accent colour
  ["default", "Balanced", "Clear and warm. The all-rounder.", "#4d7dff"],
  ["professional", "Professional", "Formal and structured, no emoji.", "#5fa0ff"],
  ["friendly", "Friendly", "Casual, upbeat and encouraging.", "#e8a317"],
  ["concise", "Concise", "The shortest useful answer.", "#2fb99f"],
  ["creative", "Creative", "Vivid ideas and fresh angles.", "#e0559f"],
  ["mentor", "Mentor", "Teaches the why, step by step.", "#3fb37a"],
  ["witty", "Witty", "Dry humour, still useful.", "#8f6bf0"]
];
const TRUX_PRESET_SAMPLES = {
  default: "Boil water, lower the eggs in gently and cook 7 minutes for a jammy yolk or 10 for firm. Move them to ice water for a minute so they peel easily.",
  professional: "Summary: 10 minutes yields a fully set yolk.\n1. Bring water to a rolling boil.\n2. Lower eggs in; cook 7 min (soft) or 10 min (firm).\n3. Transfer to ice water for 60 s before peeling.",
  friendly: "Ooh, egg time! Get your water bubbling, pop the eggs in gently and give them about 7 minutes if you love a jammy middle (10 for firm). A quick ice bath and they'll peel like a dream. What are you making?",
  concise: "Boiling water. 7 min jammy, 10 min firm. Ice bath, peel.",
  creative: "Picture a tiny hot spring: eggs slip in, and the clock decides their fate. Seven minutes gives a molten, sunset-orange heart; ten sets it like golden fudge. Then a cold plunge to make the shells let go.",
  mentor: "Heat sets egg proteins from the outside in, so time controls the yolk.\n1. Start with boiling water so timing is predictable.\n2. 7 minutes: set white, jammy yolk. 10 minutes: firm.\n3. Ice water stops the cooking and shrinks the egg from the shell.\nTry one at 7 and one at 10 and see which you prefer.",
  witty: "Eggs: the only thing that gets harder the longer it's in hot water. 7 minutes for jammy, 10 for firm, then an ice bath so the shell stops clinging like a bad ex."
};
const TRUX_INSTRUCTION_SNIPPETS = [
  ["Metric units", "Use metric units."],
  ["No long intros", "Skip long introductions; start with the answer."],
  ["Show sources", "Mention sources or how sure you are when it matters."],
  ["Code first", "For coding questions, lead with the code, then a short explanation."],
  ["Explain simply", "Explain things simply, as if I'm new to the topic."],
  ["Ask first", "Ask a clarifying question when my request is ambiguous."]
];
const TRUX_RESPONSE_LANGUAGES = [
  ["auto", "Match what I write"], ["en", "English"], ["hi", "Hindi"], ["bn", "Bengali"], ["ta", "Tamil"], ["te", "Telugu"], ["mr", "Marathi"],
  ["gu", "Gujarati"], ["pa", "Punjabi"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["pt", "Portuguese"], ["it", "Italian"],
  ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"], ["ar", "Arabic"], ["ru", "Russian"]
];
const TRUX_PERSONALIZATION_LIMITS = { nickname: 60, occupation: 120, about: 1500, instructions: 3000 };
const TRUX_PERSONALIZATION_DEFAULTS = { preset: "default", nickname: "", occupation: "", about: "", instructions: "", memoryEnabled: true, voice: "Kore", language: "auto", length: "default", emoji: "default" };
let truxPersonalization = { ...TRUX_PERSONALIZATION_DEFAULTS };
let truxPersonalizationLoadedFor = "";
const truxPresetOf = id => TRUX_PERSONALITY_PRESETS.find(([key]) => key === id) || TRUX_PERSONALITY_PRESETS[0];

function truxPersonalizationStatus(text, error = false) {
  window.dispatchEvent(new CustomEvent("trux-personalization-status", { detail: { text, error } }));
}

function normalizeClientPersonalization(raw = {}) {
  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  return {
    preset: pick(raw.preset, TRUX_PERSONALITY_PRESETS.map(p => p[0]), "default"),
    nickname: String(raw.nickname || ""), occupation: String(raw.occupation || ""),
    about: String(raw.about || ""), instructions: String(raw.instructions || ""),
    memoryEnabled: raw.memoryEnabled !== false,
    voice: String(raw.voice || store.getItem("trux_speech_voice") || "Kore"),
    language: pick(raw.language, TRUX_RESPONSE_LANGUAGES.map(l => l[0]), "auto"),
    length: pick(raw.length, ["default", "short", "detailed"], "default"),
    emoji: pick(raw.emoji, ["default", "never", "often"], "default")
  };
}

async function loadTruxPersonalization(force = false) {
  const uid = auth?.currentUser?.uid;
  if (!uid) return truxPersonalization;
  if (!force && truxPersonalizationLoadedFor === uid) return truxPersonalization;
  try {
    truxPersonalization = normalizeClientPersonalization((await truxDataApi("personalization")).personalization || {});
    truxPersonalizationLoadedFor = uid;
    if (typeof TRUX_TTS_VOICES !== "undefined" && TRUX_TTS_VOICES.some(([id]) => id === truxPersonalization.voice)) store.setItem("trux_speech_voice", truxPersonalization.voice);
  } catch (error) {
    console.warn("TruX personalization load failed", error?.message || error);
  }
  return truxPersonalization;
}

async function saveTruxPersonalization(patch, { quiet = false } = {}) {
  const uid = auth?.currentUser?.uid;
  const clean = {};
  const candidate = normalizeClientPersonalization({ ...truxPersonalization, ...patch });
  for (const key of Object.keys(patch || {})) {
    if (key in candidate) clean[key] = TRUX_PERSONALIZATION_LIMITS[key] ? candidate[key].slice(0, TRUX_PERSONALIZATION_LIMITS[key]) : candidate[key];
  }
  Object.assign(truxPersonalization, clean);
  if (!uid) return;
  try {
    await truxDataApi("personalization", { patch: clean });
    if (!quiet) truxPersonalizationStatus("Saved");
  } catch (error) {
    truxPersonalizationStatus("Couldn't save. Check your connection.", true);
  }
}

/* ---------- memory ---------- */
async function fetchTruxMemories() {
  return ((await truxDataApi("memories")).memories) || [];
}

async function deleteTruxMemory(id) {
  await truxDataApi("memories", { action: "delete", id });
}

async function clearAllMemories() {
  if (!auth?.currentUser || !confirm("Forget everything TruX has saved about you?")) return false;
  try {
    await truxDataApi("memories", { action: "clear" });
    toast("All memories cleared.", "ok");
    refreshTruxMemoryList();
    return true;
  } catch {
    toast("Couldn't clear memories.", "err");
    return false;
  }
}

/* Called when the AI saves a memory mid-chat; Settings repaints its list if it is open. */
function refreshTruxMemoryList() {
  window.dispatchEvent(new CustomEvent("trux-memory-changed"));
}

/* ---------- export ---------- */
async function exportTruxMemory() {
  if (!auth?.currentUser) { toast("Sign in to export your data.", "err"); return; }
  try {
    const [{ chats }, { personalization }, { memories }] = await Promise.all([truxDataApi("chats"), truxDataApi("personalization"), truxDataApi("memories")]);
    const messages = {};
    for (const id of Object.keys(chats || {}).slice(0, 200)) messages[id] = (await truxDataApi("messages?chatId=" + encodeURIComponent(id))).messages || {};
    const payload = { version: 3, exportedAt: new Date().toISOString(), email: auth.currentUser.email || "", chats, messages, personalization, memories, pinnedInsights };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `trux-export-${Date.now()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast("Your data was exported.", "ok");
  } catch { toast("Export failed. Check your connection.", "err"); }
}

function exportChatData() { return exportTruxMemory(); }

/* Pull the saved personality and voice as soon as someone signs in. */
window.addEventListener("trux-auth", event => {
  if (event.detail?.signedIn) void loadTruxPersonalization(true);
  else { truxPersonalization = { ...TRUX_PERSONALIZATION_DEFAULTS }; truxPersonalizationLoadedFor = ""; }
});
