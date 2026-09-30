/**
 * Strip the wake phrase Whisper transcribed at the start of a woken utterance
 * ("Hey Jarvis, anything for me?" -> "anything for me?").
 *
 * Whisper spells an unfamiliar name several ways, so the name list is loose.
 * To add a custom wake word later (e.g. a trained "hey_herald" model), extend
 * WAKE_NAMES; see the Herald section of CLAUDE.md for the model side.
 */

export const WAKE_NAMES = ['jarvis', 'jervis', 'jarvas', 'jarvus', 'javis', 'travis'];

const LEAD = '(?:hey|hi|hay|a|okay|ok|yo)';

const WAKE_RE = new RegExp(
  `^\\s*(?:${LEAD}[\\s,.!-]*)?(?:${WAKE_NAMES.join('|')})\\b[\\s,.!?:;-]*`,
  'i'
);

export function stripWakePhrase(text: string): string {
  const t = text.trim();
  const m = WAKE_RE.exec(t);
  if (!m) return t;
  const rest = t.slice(m[0].length).trim();
  // Re-capitalise the first letter of what's left.
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : '';
}
