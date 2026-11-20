/* The TruX-2 model line-up shown in the app.
 *
 * Users pick one of these by id; the Gemini model behind each one never leaves the server.
 * Daily token limits count what the model actually generates for the turn, thinking tokens included
 * (set COUNT_INPUT_TOKENS to true to also count the prompt side).
 */
export const COUNT_INPUT_TOKENS = false;

/* Thinking levels each model really supports. 'max' is sent to Vertex as XHIGH, which only Gemini 4 models accept. */
const LEVELS_3 = Object.freeze(['low', 'medium', 'high']);
const LEVELS_4 = Object.freeze(['low', 'medium', 'high', 'max']);

export const TRUX_MODELS = Object.freeze({
  spark: Object.freeze({
    id: 'spark', name: 'TruX-2 Spark', short: 'Spark',
    description: 'Fastest answers, light reasoning',
    vertex: 'gemini-3.5-flash-lite', levels: LEVELS_3, thinking: 'low', dailyTokens: 250_000, plan: null
  }),
  quasar: Object.freeze({
    id: 'quasar', name: 'TruX-2 Quasar', short: 'Quasar',
    description: 'Everyday tasks, quick and capable',
    vertex: 'gemini-3.8-flash', levels: LEVELS_3, thinking: 'medium', dailyTokens: 100_000, plan: null
  }),
  aegis: Object.freeze({
    id: 'aegis', name: 'TruX-2 Aegis', short: 'Aegis',
    description: 'Complex reasoning and multi-step work',
    vertex: 'gemini-4-hydrogen', levels: LEVELS_4, thinking: 'medium', dailyTokens: 50_000, plan: null
  }),
  oracle: Object.freeze({
    id: 'oracle', name: 'TruX-2 Oracle', short: 'Oracle',
    description: 'Toughest problems, frontier reasoning',
    vertex: 'gemini-4-neon', levels: LEVELS_4, thinking: 'high', dailyTokens: null, plan: 'edge'
  })
});

export const MODEL_ORDER = Object.freeze(['spark', 'quasar', 'aegis', 'oracle']);
export const DEFAULT_MODEL = 'quasar';

/** Owners can use every model; Oracle also needs the Edge plan. */
export function canUseModel(user, model) {
  if (user?.owner) return true;
  if (!model.plan) return true;
  return user?.tier === model.plan;
}

/** Daily token allowance for this user on this model (Infinity when there is none). */
export function dailyLimitFor(user, model) {
  if (user?.owner) return Infinity;
  return model.dailyTokens ?? Infinity;
}

/** Public description of the catalog for the client (no Gemini names). */
export function publicCatalog(user) {
  return MODEL_ORDER.map(id => {
    const m = TRUX_MODELS[id];
    const limit = dailyLimitFor(user, m);
    return {
      id: m.id, name: m.name, short: m.short, description: m.description,
      levels: [...m.levels], defaultLevel: m.thinking,
      plan: m.plan, locked: !canUseModel(user, m),
      dailyLimit: Number.isFinite(limit) ? limit : null
    };
  });
}

export function resolveModel(id) {
  return Object.hasOwn(TRUX_MODELS, id) ? TRUX_MODELS[id] : TRUX_MODELS[DEFAULT_MODEL];
}

/** The thinking level to use: the person's choice when this model offers it, otherwise the model's default. */
export function levelFor(model, requested) {
  return model.levels.includes(requested) ? requested : model.thinking;
}
