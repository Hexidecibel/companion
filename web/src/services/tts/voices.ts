import type { TtsVoice } from './types';

/** Novelty / effect voices shipped with macOS and friends. Never auto-pick. */
const NOVELTY = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|hysterical|deranged|pipe organ|fred|junior|kathy|ralph|princess|grandma|grandpa|eddy|flo|reed|rocko|sandy|shelley)\b/i;
const ROBOTIC = /espeak|e-speak|mbrola|festival|pico|robot/i;
const NATURAL = /natural|neural|online|premium|enhanced|wavenet|studio|journey|siri/i;
const GOOD_NAMES = /\b(samantha|ava|allison|evan|zoe|nathan|susan|tom|karen|daniel|serena|moira|tessa|aria|jenny|guy|libby|sonia|ryan|emma|brian|andrew|michelle)\b/i;

/**
 * Heuristic voice quality score; higher is better. English first, then
 * natural/neural voices over robotic system defaults.
 */
export function scoreVoice(v: TtsVoice, preferredLang = 'en-US'): number {
  let s = 0;
  const lang = v.lang.replace('_', '-').toLowerCase();
  const pref = preferredLang.toLowerCase();
  if (lang === pref) s += 40;
  else if (lang.startsWith('en')) s += 30;
  else if (lang.split('-')[0] === pref.split('-')[0]) s += 25;
  else s -= 100;
  if (NATURAL.test(v.name)) s += 30;
  if (/google/i.test(v.name)) s += 18;
  if (GOOD_NAMES.test(v.name)) s += 14;
  if (/microsoft/i.test(v.name) && !NATURAL.test(v.name)) s -= 4; // "Desktop" SAPI voices
  if (ROBOTIC.test(v.name)) s -= 60;
  if (NOVELTY.test(v.name)) s -= 80;
  if (v.local) s += 2; // lower latency, all else equal
  if (v.isDefault) s += 1;
  return s;
}

export function rankVoices(voices: TtsVoice[], preferredLang = 'en-US'): TtsVoice[] {
  return [...voices].sort((a, b) => scoreVoice(b, preferredLang) - scoreVoice(a, preferredLang) || a.name.localeCompare(b.name));
}

/** The voice to use: the saved one if still present, otherwise the best ranked. */
export function pickVoice(voices: TtsVoice[], savedId: string | null, preferredLang = 'en-US'): TtsVoice | null {
  if (voices.length === 0) return null;
  if (savedId) {
    const saved = voices.find((v) => v.id === savedId);
    if (saved) return saved;
  }
  return rankVoices(voices, preferredLang)[0] ?? null;
}

/** Voices worth listing in the picker: English first (ranked), then the rest. */
export function voicesForPicker(voices: TtsVoice[], preferredLang = 'en-US'): { recommended: TtsVoice[]; other: TtsVoice[] } {
  const ranked = rankVoices(voices, preferredLang);
  const recommended = ranked.filter((v) => v.lang.toLowerCase().startsWith('en') && !NOVELTY.test(v.name));
  const other = ranked.filter((v) => !recommended.includes(v));
  return { recommended, other };
}
