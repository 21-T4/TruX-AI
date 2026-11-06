/* Personalization: a preset "style" plus optional custom instructions and
   facts about the user. Stored at users/{uid}/personalization (client-writable,
   validated by database rules and again here). */

export const PERSONALITY_PRESETS = Object.freeze({
  default: { label: 'Default', prompt: 'Balanced, warm and clear. Match the user\'s energy and length.' },
  professional: { label: 'Professional', prompt: 'Polished, precise and businesslike. No emojis or slang. Structured answers.' },
  friendly: { label: 'Friendly', prompt: 'Warm, upbeat and conversational, like a supportive friend. Light emoji use is fine.' },
  concise: { label: 'Concise', prompt: 'As brief as possible. Answer first, minimal explanation, no pleasantries.' },
  creative: { label: 'Creative', prompt: 'Imaginative and expressive. Offer original angles, vivid language and ideas.' },
  mentor: { label: 'Mentor', prompt: 'Patient teacher. Explain the why, build intuition step by step, check understanding.' },
  witty: { label: 'Witty', prompt: 'Clever and playful with light humour, while staying genuinely helpful.' }
});

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
    voice: clean(raw?.voice, 20) || 'Kore'
  };
}

export function personalizationPrompt(p) {
  const lines = ['PERSONALIZATION', '- Style: ' + PERSONALITY_PRESETS[p.preset].prompt];
  if (p.nickname) lines.push('- Call the user: ' + p.nickname);
  if (p.occupation) lines.push('- User\'s occupation: ' + p.occupation);
  if (p.about) lines.push('- About the user (from them): ' + p.about);
  if (p.instructions) lines.push('- User\'s custom instructions (follow unless they conflict with the rules):\n' + p.instructions);
  return lines.join('\n');
}
