/**
 * Herald's own volume, independent of the system volume (per device).
 *
 *   voice   0..150 % (above 100 % is a gain boost), default 100 %
 *   tones   0..150 %; with "tones follow voice" (default on) the tones' gain is
 *           tones x voice, so turning Herald down turns its tones down too.
 *
 * Applied as gain nodes INSIDE Herald's audio graph (`audioGraph.ts`): the
 * echo canceller's reference is taken after them (and after the output
 * clamp), so it always gets exactly the samples that are played. Web Speech
 * (the fallback voice) gets `min(1, voice)` as its utterance volume.
 *
 * Stored in localStorage (per device, never synced); a profile can set a
 * default (Gaming: 80 %). Voice commands step it by 15 %.
 */

export const VOLUME_MIN = 0;
export const VOLUME_MAX = 1.5;
export const VOLUME_DEFAULT = 1;
/** "louder" / "quieter" move the voice volume by this much. */
export const VOLUME_STEP = 0.15;
/** Voice commands never step below this (so "quieter" cannot silence Herald by accident). */
export const VOLUME_STEP_FLOOR = 0.1;

export interface HeraldVolume {
  /** Voice gain, 0..1.5. */
  voice: number;
  /** Tones gain, 0..1.5 (relative to the voice when `tonesFollowVoice`). */
  tones: number;
  tonesFollowVoice: boolean;
}

export const DEFAULT_VOLUME: HeraldVolume = { voice: VOLUME_DEFAULT, tones: VOLUME_DEFAULT, tonesFollowVoice: true };

const round2 = (v: number) => Math.round(v * 100) / 100;

export function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return VOLUME_DEFAULT;
  return round2(Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, v)));
}

/** Next voice volume for "louder" / "quieter"; null when already at the limit. */
export function stepVolume(v: number, dir: 1 | -1): number | null {
  const cur = clampVolume(v);
  const floor = dir < 0 ? Math.min(cur, VOLUME_STEP_FLOOR) : VOLUME_MIN;
  const next = round2(Math.min(VOLUME_MAX, Math.max(floor, cur + dir * VOLUME_STEP)));
  return Math.abs(next - cur) < 0.001 ? null : next;
}

/** 0..1.5 -> "85%". */
export function volumePercent(v: number): number {
  return Math.round(clampVolume(v) * 100);
}

/** The gains the graph applies: the voice bus and the tones bus. */
export function busGains(v: HeraldVolume): { voice: number; tones: number } {
  const voice = clampVolume(v.voice);
  const tones = clampVolume(v.tones);
  return { voice, tones: round2(v.tonesFollowVoice ? tones * voice : tones) };
}

/** Web Speech cannot boost: its utterance volume is 0..1. */
export function webSpeechVolume(v: HeraldVolume): number {
  return Math.min(1, clampVolume(v.voice));
}

const KEY = 'herald_volume';

export function parseVolume(raw: string | null): HeraldVolume {
  if (!raw) return DEFAULT_VOLUME;
  try {
    const p = JSON.parse(raw) as Partial<HeraldVolume>;
    return {
      voice: typeof p.voice === 'number' ? clampVolume(p.voice) : DEFAULT_VOLUME.voice,
      tones: typeof p.tones === 'number' ? clampVolume(p.tones) : DEFAULT_VOLUME.tones,
      tonesFollowVoice: typeof p.tonesFollowVoice === 'boolean' ? p.tonesFollowVoice : DEFAULT_VOLUME.tonesFollowVoice,
    };
  } catch {
    return DEFAULT_VOLUME;
  }
}

function load(): HeraldVolume {
  try {
    return parseVolume(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_VOLUME;
  }
}

let state: HeraldVolume = load();
const listeners = new Set<(v: HeraldVolume) => void>();

function set(patch: Partial<HeraldVolume>): void {
  const next = parseVolume(JSON.stringify({ ...state, ...patch }));
  if (next.voice === state.voice && next.tones === state.tones && next.tonesFollowVoice === state.tonesFollowVoice) return;
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // storage unavailable: applies for this session only
  }
  for (const l of [...listeners]) {
    try {
      l(state);
    } catch {
      // listener errors are not ours
    }
  }
}

/** The per-device volume store (module level, shared by the graph, the menu and the tray). */
export const heraldVolumeStore = {
  get: (): HeraldVolume => state,
  subscribe(l: (v: HeraldVolume) => void): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  setVoice: (voice: number) => set({ voice }),
  setTones: (tones: number) => set({ tones }),
  setTonesFollowVoice: (tonesFollowVoice: boolean) => set({ tonesFollowVoice }),
  /** Tests only. */
  reset(): void {
    state = load();
    listeners.clear();
  },
};

// ---------------------------------------------------------------------------
// Voice commands: "louder", "quieter", "volume up", "volume 50", "softer".
// Whole utterance only (after the same normalising as the other commands), so
// "turn up the logging" or "what's the volume on the build" go to the brain.

export type VolumeCommand = { kind: 'step'; dir: 1 | -1 } | { kind: 'set'; value: number };

const UP = new Set([
  'louder', 'a bit louder', 'a little louder', 'little louder', 'bit louder', 'louder please', 'speak up',
  'volume up', 'turn it up', 'turn up', 'turn you up', 'turn the volume up', 'turn up the volume', 'turn volume up',
  'more volume', 'increase volume', 'increase the volume', 'raise the volume', 'raise volume', 'up the volume',
  'pump it up', 'cant hear you', 'i cant hear you',
]);
const DOWN = new Set([
  'quieter', 'a bit quieter', 'a little quieter', 'little quieter', 'bit quieter', 'softer', 'a bit softer',
  'a little softer', 'speak softer', 'talk softer', 'volume down', 'turn it down', 'turn down', 'turn you down',
  'turn the volume down', 'turn down the volume', 'turn volume down', 'less volume', 'lower volume',
  'lower the volume', 'decrease volume', 'decrease the volume', 'not so loud', 'too loud', 'youre too loud',
]);
const MAX = new Set(['max volume', 'maximum volume', 'full volume', 'volume max', 'volume maximum', 'full blast']);
const NORMAL = new Set(['normal volume', 'volume normal', 'reset volume', 'reset the volume', 'default volume', 'volume default']);

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** "50", "fifty", "eighty five", "one hundred", "a hundred and twenty" -> number; null otherwise. */
export function parseSpokenNumber(words: string[]): number | null {
  if (words.length === 0) return null;
  if (words.length === 1 && /^\d{1,3}$/.test(words[0])) return Number(words[0]);
  let total = 0;
  let cur = 0;
  let seen = false;
  for (const w of words) {
    if (w === 'and') continue;
    if (w === 'a' && !seen) {
      cur = 1;
      continue;
    }
    if (w in SMALL) cur += SMALL[w];
    else if (w in TENS) cur += TENS[w];
    else if (w === 'hundred') {
      cur = (cur || 1) * 100;
      total += cur;
      cur = 0;
    } else if (/^\d{1,3}$/.test(w)) cur += Number(w);
    else return null;
    seen = true;
  }
  return seen ? total + cur : null;
}

const FILLERS = new Set(['uh', 'um', 'umm', 'please', 'okay', 'ok', 'just', 'now', 'herald', 'jarvis', 'hey', 'so']);

/**
 * The volume command a whole (already normalised: lowercase, no punctuation)
 * utterance expresses, or null. `normalized` comes from voiceCommands'
 * normalizeUtterance + stripAddress.
 */
export function matchVolumePhrase(normalized: string): VolumeCommand | null {
  const words = normalized.split(' ').filter((w) => w && !FILLERS.has(w));
  if (words.length === 0 || words.length > 7) return null;
  const phrase = words.join(' ');
  if (UP.has(phrase)) return { kind: 'step', dir: 1 };
  if (DOWN.has(phrase)) return { kind: 'step', dir: -1 };
  if (MAX.has(phrase)) return { kind: 'set', value: VOLUME_MAX };
  if (NORMAL.has(phrase)) return { kind: 'set', value: VOLUME_DEFAULT };
  // "volume 50", "set volume to 50 percent", "set the volume to fifty", "volume at 80".
  const m = /^(?:set |change |put )?(?:the |your )?volume (?:to |at |is )?(.+?)(?: percent| per cent)?$/.exec(phrase);
  if (!m) return null;
  const n = parseSpokenNumber(m[1].split(' '));
  if (n === null || n < 0 || n > VOLUME_MAX * 100) return null;
  return { kind: 'set', value: clampVolume(n / 100) };
}
