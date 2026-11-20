/* Model selection and usage.
 *
 * Four TruX-2 models; the Gemini model behind each one is decided on the server and never shown here.
 * /api/usage returns the plan, which models are locked and how many tokens were used today. It is cached
 * briefly and refreshed after each turn, so the picker and Settings → Usage & limits always agree. */
/* Thinking levels each model really supports (the server enforces the same lists). "Max" is the Gemini 4 top level. */
const TRUX_LEVELS_3 = ["low", "medium", "high"];
const TRUX_LEVELS_4 = ["low", "medium", "high", "max"];
const TRUX_MODELS = [
  { id: "spark",  name: "TruX-2 Spark",  short: "Spark",  description: "Fastest answers, light reasoning", levels: TRUX_LEVELS_3, thinking: "low" },
  { id: "quasar", name: "TruX-2 Quasar", short: "Quasar", description: "Everyday tasks, quick and capable", levels: TRUX_LEVELS_3, thinking: "medium" },
  { id: "aegis",  name: "TruX-2 Aegis",  short: "Aegis",  description: "Complex reasoning and multi-step work", levels: TRUX_LEVELS_4, thinking: "medium" },
  { id: "oracle", name: "TruX-2 Oracle", short: "Oracle", description: "Toughest problems, frontier reasoning", levels: TRUX_LEVELS_4, thinking: "high", plan: "edge" }
];
const TRUX_DEFAULT_MODEL = "quasar";
const TRUX_THINKING_LEVELS = [
  { id: "low",    label: "Low",    description: "A little thinking for quick, solid answers" },
  { id: "medium", label: "Medium", description: "Balanced thinking for most questions" },
  { id: "high",   label: "High",   description: "More thinking for multi-step work" },
  { id: "max",    label: "Max",    description: "Deepest thinking, slowest answers" }
];
const truxThinkingLevelById = id => TRUX_THINKING_LEVELS.find(l => l.id === id) || null;

/** The level in use for a model: what you chose for it (if that model offers it), otherwise the model's own default. */
function truxThinkingFor(modelId) {
  const model = truxModelById(modelId);
  const saved = store.getItem("trux_thinking_" + modelId);
  return model?.levels.includes(saved) ? saved : (model?.thinking || "medium");
}
function setTruxThinking(modelId, level) {
  const model = truxModelById(modelId);
  if (!model?.levels.includes(level)) return;
  if (level === model.thinking) store.removeItem("trux_thinking_" + modelId);
  else store.setItem("trux_thinking_" + modelId, level);
  renderModelPicker();
  try { if (typeof renderSettingsGeneral === "function") renderSettingsGeneral(); } catch {}
}
const TRUX_FALLBACK_LIMITS = { spark: 250000, quasar: 100000, aegis: 50000 };   // shown until the server answers
let truxUsage = null;                 // last /api/usage payload
let truxUsageAt = 0;
let truxUsageInFlight = null;
let truxSelectedModel = TRUX_DEFAULT_MODEL;

const truxModelById = id => TRUX_MODELS.find(m => m.id === id) || null;

function truxIsOwner() { try { return isTruxDeveloper(auth?.currentUser); } catch { return false; } }

function truxModelLocked(id) {
  const model = truxModelById(id);
  if (!model?.plan) return false;
  if (truxIsOwner() || truxUsage?.owner) return false;
  return (truxUsage?.tier || currentPlanTier) !== model.plan;
}

/** Daily numbers for a model: { used, limit, remaining } where limit is null when there is none. */
function truxModelUsage(id) {
  const fromServer = truxUsage?.models?.[id];
  if (fromServer) return fromServer;
  const limit = truxIsOwner() ? null : (TRUX_FALLBACK_LIMITS[id] ?? null);
  return { used: 0, limit, remaining: limit };
}

function truxModelExhausted(id) {
  const u = truxModelUsage(id);
  return u.limit !== null && u.remaining !== null && u.remaining <= 0;
}

/** Empty string when the model can be used right now, otherwise the reason. */
function truxModelBlockReason(id) {
  const model = truxModelById(id);
  if (!model) return "Pick a model first.";
  if (truxModelLocked(id)) return model.name + " is available on the Edge plan.";
  if (truxModelExhausted(id)) return "You've used today's " + model.short + " tokens. Pick another model, or try again after " + truxResetLabel() + ".";
  return "";
}

function truxFormatTokens(n) {
  n = Math.max(0, Math.round(Number(n) || 0));
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0).replace(/\.0$/, "") + "M";
  if (n >= 1e4) return Math.round(n / 1e3) + "k";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

function truxResetLabel() {
  const at = truxUsage?.resetsAt;
  if (!at) return "the daily reset";
  const d = new Date(at);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function truxLoadSelectedModel() {
  const saved = store.getItem("trux_model");
  truxSelectedModel = truxModelById(saved) && !truxModelLocked(saved) ? saved : TRUX_DEFAULT_MODEL;
}

async function refreshTruxUsage({ force = false } = {}) {
  if (!auth?.currentUser) return truxUsage;
  if (!force && truxUsage && Date.now() - truxUsageAt < 15000) return truxUsage;
  if (truxUsageInFlight) return truxUsageInFlight;
  truxUsageInFlight = (async () => {
    try {
      const response = await truxAuthenticatedFetch("/api/usage", { cache: "no-store" });
      if (!response.ok) throw new Error("usage " + response.status);
      truxUsage = await response.json();
      truxUsageAt = Date.now();
      if (truxUsage.tier) currentPlanTier = truxUsage.tier;
      if (truxModelLocked(truxSelectedModel)) { truxSelectedModel = TRUX_DEFAULT_MODEL; store.setItem("trux_model", truxSelectedModel); }
    } catch (error) {
      console.warn("TruX usage unavailable", error?.message || error);
    } finally {
      truxUsageInFlight = null;
    }
    renderModelPicker();
    try { if (typeof renderSettingsUsage === "function") renderSettingsUsage(); } catch {}
    return truxUsage;
  })();
  return truxUsageInFlight;
}

/** The server reports the new daily total at the end of each turn. */
function applyTruxUsageEvent(event) {
  if (!event?.model || !Number.isFinite(event.used)) return;
  if (!truxUsage) truxUsage = { models: {}, monthly: {} };
  truxUsage.models = truxUsage.models || {};
  const limit = event.limit ?? truxUsage.models[event.model]?.limit ?? null;
  truxUsage.models[event.model] = { used: event.used, limit, remaining: limit === null ? null : Math.max(0, limit - event.used) };
  truxUsageAt = Date.now();
  renderModelPicker();
  try { if (typeof renderSettingsUsage === "function") renderSettingsUsage(); } catch {}
}

function renderModelPicker() {
  const label = getEl("modelPickerLabel");
  const model = truxModelById(truxSelectedModel) || truxModelById(TRUX_DEFAULT_MODEL);
  if (label) label.textContent = model.short;
  const level = truxThinkingFor(model.id);
  const think = getEl("modelPickerThink");
  if (think) think.textContent = truxThinkingLevelById(level)?.label || "";
  renderThinkingLevels(model.id, level);
  const list = getEl("modelList");
  if (!list) return;
  const frag = document.createDocumentFragment();
  for (const m of TRUX_MODELS) {
    const locked = truxModelLocked(m.id);
    const usage = truxModelUsage(m.id);
    const exhausted = !locked && truxModelExhausted(m.id);
    const active = m.id === truxSelectedModel && !locked;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "mp-item" + (active ? " active" : "") + (locked ? " locked" : "") + (exhausted ? " exhausted" : "");
    row.dataset.model = m.id;
    row.setAttribute("role", "menuitemradio");
    row.setAttribute("aria-checked", String(active));
    const copy = document.createElement("span");
    copy.className = "mp-copy";
    const name = document.createElement("span");
    name.className = "mp-name";
    name.textContent = m.name;
    if (m.plan) {
      const tag = document.createElement("span");
      tag.className = "edge-tag";
      tag.textContent = "Edge";
      name.append(tag);
    }
    const desc = document.createElement("span");
    desc.className = "mp-desc";
    desc.textContent = m.description;
    copy.append(name, desc);
    const side = document.createElement("span");
    side.className = "mp-side";
    if (locked) {
      side.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2.2"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/></svg>';
    } else if (exhausted) {
      side.textContent = "Limit reached";
      side.classList.add("mp-note");
    } else {
      if (usage.limit !== null && usage.remaining !== null) {
        const note = document.createElement("span");
        note.className = "mp-note";
        note.textContent = truxFormatTokens(usage.remaining) + " left today";
        side.append(note);
      }
      side.insertAdjacentHTML("beforeend", '<svg class="mp-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>');
    }
    row.append(copy, side);
    row.addEventListener("click", event => selectModel(m.id, event));
    frag.appendChild(row);
  }
  list.replaceChildren(frag);
  const foot = getEl("modelFootNote");
  if (foot) {
    const limited = ["spark", "quasar", "aegis"].some(id => truxModelUsage(id).limit !== null);
    foot.hidden = !limited;
    if (limited) foot.textContent = "Spark, Quasar and Aegis have daily token limits that include thinking. Resets at " + truxResetLabel() + ".";
  }
}

/* The thinking levels of the selected model, shown as one row of choices under the model list. */
function renderThinkingLevels(modelId, level) {
  const model = truxModelById(modelId);
  const list = getEl("thinkList");
  if (!list || !model) return;
  const forModel = getEl("thinkFor");
  if (forModel) forModel.textContent = model.short;
  const desc = getEl("thinkDesc");
  if (desc) desc.textContent = truxThinkingLevelById(level)?.description || "";
  const frag = document.createDocumentFragment();
  for (const id of model.levels) {
    const info = truxThinkingLevelById(id);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "mp-level" + (id === level ? " active" : "");
    chip.setAttribute("role", "radio");
    chip.setAttribute("aria-checked", String(id === level));
    chip.textContent = info.label;
    chip.title = info.description + (id === model.thinking ? " (default)" : "");
    chip.addEventListener("click", event => { event.stopPropagation(); setTruxThinking(modelId, id); });
    frag.appendChild(chip);
  }
  list.style.setProperty("--levels", String(model.levels.length));
  list.replaceChildren(frag);
}

/* Escape closes the model sheet. */
document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || getEl("modelPage")?.hidden !== false) return;
  event.stopPropagation();
  closeModelDropdown();
}, true);

function selectModel(id, event) {
  event?.stopPropagation();
  const model = truxModelById(id);
  if (!model) return;
  if (truxModelLocked(id)) {
    closeModelDropdown();
    toast(model.name + " is available on the Edge plan.");
    if (typeof openSubscriptionPage === "function") openSubscriptionPage();
    return;
  }
  if (truxModelExhausted(id)) { toast(truxModelBlockReason(id), "err"); return; }
  truxSelectedModel = id;
  store.setItem("trux_model", id);
  renderModelPicker();
  try { if (typeof renderSettingsGeneral === "function") renderSettingsGeneral(); } catch {}
  closeModelDropdown();
}

truxLoadSelectedModel();

/* A different account may have a different plan and different usage. */
window.addEventListener("trux-auth", event => {
  truxUsage = null;
  truxUsageAt = 0;
  truxLoadSelectedModel();
  renderModelPicker();
  if (event.detail?.signedIn) void refreshTruxUsage({ force: true });
});
