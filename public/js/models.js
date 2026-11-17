/* Model selection and usage.
 *
 * Four TruX-2 models; the Gemini model behind each one is decided on the server and never shown here.
 * /api/usage returns the plan, which models are locked and how many tokens were used today. It is cached
 * briefly and refreshed after each turn, so the picker and Settings → Usage & limits always agree. */
const TRUX_MODELS = [
  { id: "spark",  name: "TruX-2 Spark",  short: "Spark",  description: "Fastest answers, no reasoning", thinking: "minimal" },
  { id: "quasar", name: "TruX-2 Quasar", short: "Quasar", description: "Everyday tasks, quick and capable", thinking: "auto" },
  { id: "aegis",  name: "TruX-2 Aegis",  short: "Aegis",  description: "Complex reasoning and multi-step work", thinking: "medium" },
  { id: "oracle", name: "TruX-2 Oracle", short: "Oracle", description: "Toughest problems, frontier reasoning", thinking: "high", plan: "edge" }
];
const TRUX_DEFAULT_MODEL = "quasar";
/* Thinking levels every model offers. The level you pick is remembered per model; each model starts at its own default. */
const TRUX_THINKING_LEVELS = [
  { id: "auto",    label: "Adaptive", description: "Thinks only as much as each question needs" },
  { id: "minimal", label: "Instant",  description: "Answers right away, no thinking" },
  { id: "low",     label: "Light",    description: "A little thinking for quick, solid answers" },
  { id: "medium",  label: "Extended", description: "More thinking for multi-step work" },
  { id: "high",    label: "Max",      description: "Deepest thinking, slowest answers" }
];
const truxThinkingLevelById = id => TRUX_THINKING_LEVELS.find(l => l.id === id) || null;

/** The level in use for a model: what you chose for it, otherwise the model's own default. */
function truxThinkingFor(modelId) {
  const model = truxModelById(modelId);
  const saved = store.getItem("trux_thinking_" + modelId);
  return truxThinkingLevelById(saved) ? saved : (model?.thinking || "auto");
}
function setTruxThinking(modelId, level) {
  if (!truxThinkingLevelById(level)) return;
  if (level === truxModelById(modelId)?.thinking) store.removeItem("trux_thinking_" + modelId);
  else store.setItem("trux_thinking_" + modelId, level);
  renderModelPicker();
  try { if (typeof renderSettingsGeneral === "function") renderSettingsGeneral(); } catch {}
}
const TRUX_FALLBACK_LIMITS = { quasar: 100000, aegis: 50000 };   // shown until the server answers
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
    const quasar = truxModelUsage("quasar"), aegis = truxModelUsage("aegis");
    const limited = quasar.limit !== null || aegis.limit !== null;
    foot.hidden = !limited;
    if (limited) foot.textContent = "Quasar and Aegis have daily token limits that include thinking. Resets at " + truxResetLabel() + ".";
  }
}

/* "Thinking level" under the model list: one row showing the current level that opens the five choices. */
function renderThinkingLevels(modelId, level) {
  const current = getEl("thinkCurrent");
  if (current) current.textContent = truxThinkingLevelById(level)?.label || "";
  const list = getEl("thinkList");
  if (!list) return;
  const frag = document.createDocumentFragment();
  for (const l of TRUX_THINKING_LEVELS) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "mp-item mp-level" + (l.id === level ? " active" : "");
    row.setAttribute("role", "menuitemradio");
    row.setAttribute("aria-checked", String(l.id === level));
    row.innerHTML = '<span class="mp-copy"><span class="mp-name"></span><span class="mp-desc"></span></span><span class="mp-side"><svg class="mp-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></span>';
    row.querySelector(".mp-name").textContent = l.label + (l.id === truxModelById(modelId)?.thinking ? " · default" : "");
    row.querySelector(".mp-desc").textContent = l.description;
    row.addEventListener("click", event => { event.stopPropagation(); setTruxThinking(modelId, l.id); });
    frag.appendChild(row);
  }
  list.replaceChildren(frag);
}

function toggleThinkingLevels(event) {
  event?.stopPropagation();
  const section = getEl("thinkSection");
  if (!section) return;
  const open = section.classList.toggle("open");
  getEl("thinkHead")?.setAttribute("aria-expanded", String(open));
  if (open) setTimeout(() => getEl("thinkList")?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 120);
}

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
