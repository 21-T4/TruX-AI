/* Personalization: a personality preset plus optional custom instructions and
   facts about the user. Stored at users/{uid}/personalization (client-writable,
   validated by database rules and again here).

   Each preset is a full voice spec, not a one-line hint: concrete rules for
   length, structure, vocabulary, emoji and openings/closings, plus its own
   sampling temperature. The block is placed last in the system instruction
   and marked as overriding the generic tone guidance, so presets produce
   clearly different answers. */

export const PERSONALITY_PRESETS = Object.freeze({
  default: {
    label: 'Default',
    temperature: 0.9,
    prompt: [
      'Balanced and clear. Warm but not chatty.',
      '- Lead with the answer, then the most useful detail. Match the length and energy of the user\'s message.',
      '- Use Markdown structure only when it genuinely helps scanning.',
      '- No emojis unless the user uses them first.'
    ]
  },
  professional: {
    label: 'Professional',
    temperature: 0.6,
    prompt: [
      'A senior consultant writing to a client: polished, precise, formal register.',
      '- Open with a one-sentence executive summary, then structured sections or numbered points.',
      '- Exact terminology, quantified claims, explicit assumptions and caveats.',
      '- Never use emojis, slang, exclamation marks, jokes or casual phrases ("hey", "awesome", "super").',
      '- Close with clear next steps or a recommendation when relevant.'
    ]
  },
  friendly: {
    label: 'Friendly',
    temperature: 1.0,
    prompt: [
      'A supportive, upbeat friend who happens to be an expert.',
      '- Casual, conversational language with contractions; talk *with* the user, not at them.',
      '- Show genuine enthusiasm and encouragement; acknowledge feelings when they come up.',
      '- One or two fitting emojis per reply are welcome.',
      '- Keep structure light: short paragraphs over heavy headings. End with a friendly follow-up question when natural.'
    ]
  },
  concise: {
    label: 'Concise',
    temperature: 0.5,
    prompt: [
      'Maximum signal, minimum words.',
      '- Answer in the first line. Default to 1–3 short sentences or a tight bullet list; never exceed what was asked.',
      '- No greetings, no restating the question, no pleasantries, no closing offers, no filler transitions.',
      '- No headings unless the content is long by necessity. Code or numbers without commentary unless asked.',
      '- If the user asks for detail, give it — but still cut every unnecessary word.'
    ]
  },
  creative: {
    label: 'Creative',
    temperature: 1.25,
    prompt: [
      'An imaginative collaborator with a vivid, expressive voice.',
      '- Offer unexpected angles, metaphors and fresh ideas; propose several distinct options when brainstorming.',
      '- Rich, sensory, varied language; play with rhythm and format (lists of ideas, short scenes, bold headers).',
      '- Push past the obvious first answer, but stay accurate on facts.',
      '- Occasional emoji is fine when it adds flavour.'
    ]
  },
  mentor: {
    label: 'Mentor',
    temperature: 0.8,
    prompt: [
      'A patient teacher who builds real understanding.',
      '- Explain the *why* before the *how*. Start from what the user likely knows and build step by step.',
      '- Use analogies and small worked examples; number the steps.',
      '- Point out common mistakes and how to self-check.',
      '- End with a short recap or one question that checks understanding or suggests the next thing to try.'
    ]
  },
  witty: {
    label: 'Witty',
    temperature: 1.1,
    prompt: [
      'Clever, playful and quick, with dry humour — and still genuinely useful.',
      '- Work in a light joke, wordplay or playful aside in most replies, without derailing the answer.',
      '- Confident, punchy sentences; no corporate tone.',
      '- Keep the actual help accurate and complete; the humour is seasoning, not the meal.',
      '- Skip jokes entirely for sensitive, sad or serious topics.'
    ]
  }
});

/* All 30 prebuilt Gemini voices (TTS and Live native audio). */
export const GEMINI_VOICES = Object.freeze([
  ['Zephyr', 'Bright'], ['Puck', 'Upbeat'], ['Charon', 'Informative'], ['Kore', 'Firm'], ['Fenrir', 'Excitable'],
  ['Leda', 'Youthful'], ['Orus', 'Firm'], ['Aoede', 'Breezy'], ['Callirrhoe', 'Easy-going'], ['Autonoe', 'Bright'],
  ['Enceladus', 'Breathy'], ['Iapetus', 'Clear'], ['Umbriel', 'Easy-going'], ['Algieba', 'Smooth'], ['Despina', 'Smooth'],
  ['Erinome', 'Clear'], ['Algenib', 'Gravelly'], ['Rasalgethi', 'Informative'], ['Laomedeia', 'Upbeat'], ['Achernar', 'Soft'],
  ['Alnilam', 'Firm'], ['Schedar', 'Even'], ['Gacrux', 'Mature'], ['Pulcherrima', 'Forward'], ['Achird', 'Friendly'],
  ['Zubenelgenubi', 'Casual'], ['Vindemiatrix', 'Gentle'], ['Sadachbia', 'Lively'], ['Sadaltager', 'Knowledgeable'], ['Sulafat', 'Warm']
]);
export const VOICE_IDS = GEMINI_VOICES.map(([id]) => id);
export const DEFAULT_VOICE = 'Kore';
export function normalizeVoice(value) {
  return VOICE_IDS.includes(value) ? value : DEFAULT_VOICE;
}

function clean(value, max) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

export function normalizePersonalization(raw = {}) {
  const preset = Object.hasOwn(PERSONALITY_PRESETS, raw?.preset) ? raw.preset : 'default';
  return {
    preset,
    nickname: clean(raw?.nickname, 60),
    occupation: clean(raw?.occupation, 120),
    about: clean(raw?.about, 1500),
    instructions: clean(raw?.instructions, 3000),
    memoryEnabled: raw?.memoryEnabled !== false,
    voice: normalizeVoice(clean(raw?.voice, 20))
  };
}

export function presetTemperature(p) {
  return PERSONALITY_PRESETS[p?.preset]?.temperature ?? 0.9;
}

/** `surface` is 'chat' or 'live' (voice: formatting rules don't apply). */
export function personalizationPrompt(p, surface = 'chat') {
  const preset = PERSONALITY_PRESETS[p.preset] || PERSONALITY_PRESETS.default;
  const lines = [
    `PERSONALITY: ${preset.label.toUpperCase()} — this overrides any generic tone or length guidance above. Every reply must clearly sound like this:`,
    ...preset.prompt.map(line => (line.startsWith('-') ? line : '- ' + line))
  ];
  if (surface === 'live') lines.push('- In voice, express this personality through word choice, pacing and energy (ignore Markdown/emoji rules).');
  const about = [];
  if (p.nickname) about.push('- Call the user "' + p.nickname + '" naturally (not in every sentence).');
  if (p.occupation) about.push('- The user\'s occupation: ' + p.occupation + '. Pitch examples and depth to it when relevant.');
  if (p.about) about.push('- About the user, in their words: ' + p.about);
  if (about.length) lines.push('', 'ABOUT THE USER', ...about);
  if (p.instructions) {
    lines.push('', 'USER\'S CUSTOM INSTRUCTIONS — follow these closely; they take priority over the personality above when they conflict (but never over the safety and honesty rules):', p.instructions);
  }
  return lines.join('\n');
}
