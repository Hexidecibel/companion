import type { ChimeKind } from './heraldSpeech';
import { getAudioGraph } from '../voice/audioGraph';

type AudioCtor = typeof AudioContext;

function getCtor(): AudioCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Tones play through Herald's shared graph, so the echo canceller hears them as Herald's own. */
function getContext(): AudioContext | null {
  return getAudioGraph().context();
}

export function chimeSupported(): boolean {
  return !!getCtor();
}

/** Call inside a user gesture so later chimes are not blocked by autoplay rules. */
export function unlockChime(): void {
  const c = getContext();
  if (c && c.state === 'suspended') void c.resume().catch(() => {});
}

/**
 * Herald's signature earcon: a rising G-C-E motif (a fourth, then a major
 * third) that is meant to be learned, so the user knows "Herald has something"
 * without a word being spoken. Priority variants keep the motif:
 *   blocked  - the motif, a touch louder, with the top note struck twice
 *              (more insistent: something is waiting on you)
 *   finished - the motif descending and softer (settled: something is done)
 *   wake     - a quick bright two-note "I'm listening"
 *   ok       - one soft note (a voice command was taken)
 *   error    - a low falling pair, off the motif (could not do that: e.g. the
 *              mic is not available to a remote trigger in a background tab)
 *   remote   - a double tap then a high note: a REMOTE trigger (another
 *              machine's hotkey) just opened this device's mic
 *   tick     - a tiny G-C grace note (under 80 ms): "heard you, working on it",
 *              the moment a voice turn ends, so the wait is not dead air
 * Quiet on purpose: about -26 dBFS peak at the default volume.
 */
export type ToneKind = ChimeKind | 'wake' | 'ok' | 'error' | 'remote' | 'tick';

interface Note {
  freq: number;
  /** Seconds after the tone starts. */
  at: number;
  dur: number;
  gain: number;
}

const G5 = 783.99;
const C6 = 1046.5;
const E6 = 1318.51;
const B5 = 987.77;

export const TONES: Record<ToneKind, Note[]> = {
  blocked: [
    { freq: G5, at: 0, dur: 0.22, gain: 0.9 },
    { freq: C6, at: 0.11, dur: 0.22, gain: 0.95 },
    { freq: E6, at: 0.22, dur: 0.2, gain: 1 },
    { freq: E6, at: 0.4, dur: 0.6, gain: 1 },
  ],
  finished: [
    { freq: E6, at: 0, dur: 0.3, gain: 0.55 },
    { freq: C6, at: 0.15, dur: 0.3, gain: 0.55 },
    { freq: G5, at: 0.3, dur: 0.7, gain: 0.6 },
  ],
  // Two rising notes, then an off-motif short third a semitone under the
  // resolution: "look at this", softer than blocked, distinct from finished.
  risk: [
    { freq: G5, at: 0, dur: 0.2, gain: 0.6 },
    { freq: C6, at: 0.13, dur: 0.22, gain: 0.62 },
    { freq: B5, at: 0.3, dur: 0.14, gain: 0.5 },
  ],
  wake: [
    { freq: C6, at: 0, dur: 0.25, gain: 1 },
    { freq: E6, at: 0.1, dur: 0.4, gain: 1 },
  ],
  ok: [{ freq: C6, at: 0, dur: 0.35, gain: 0.7 }],
  remote: [
    { freq: G5, at: 0, dur: 0.1, gain: 0.8 },
    { freq: G5, at: 0.13, dur: 0.1, gain: 0.8 },
    { freq: E6, at: 0.26, dur: 0.4, gain: 1 },
  ],
  error: [
    { freq: 392.0, at: 0, dur: 0.22, gain: 0.8 },
    { freq: 311.13, at: 0.14, dur: 0.4, gain: 0.8 },
  ],
  tick: [
    { freq: G5 * 2, at: 0, dur: 0.035, gain: 0.7 },
    { freq: C6 * 2, at: 0.018, dur: 0.045, gain: 0.45 },
  ],
};

/** Volume of the acknowledgement tick: softer than the news tones. */
export const TICK_VOLUME = 0.03;

/** Total length of a tone in seconds (tests, scheduling). */
export function toneDuration(kind: ToneKind): number {
  return Math.max(...TONES[kind].map((n) => n.at + n.dur));
}

export function playChime(kind: ToneKind, volume = 0.05): void {
  const c = getContext();
  if (!c) return;
  if (c.state === 'suspended') {
    // Without a prior gesture this stays suspended; then we simply stay silent.
    void c.resume().catch(() => {});
  }
  try {
    const t0 = c.currentTime + 0.02;
    const master = c.createGain();
    master.gain.value = kind === 'blocked' ? volume * 1.15 : volume;
    master.connect(getAudioGraph().toneBus() ?? c.destination);
    for (const note of TONES[kind]) {
      const start = t0 + note.at;
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = note.freq;
      // Soft attack, exponential tail: a struck-glass feel, no click.
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(note.gain, start + (kind === 'tick' ? 0.004 : 0.012));
      g.gain.exponentialRampToValueAtTime(0.0001, start + note.dur);
      osc.connect(g);
      g.connect(master);
      osc.start(start);
      // The tick must stay short: no tail past its own envelope.
      osc.stop(start + note.dur + (kind === 'tick' ? 0.005 : 0.05));
      // A quiet octave partial adds a little shimmer.
      const partial = c.createOscillator();
      const pg = c.createGain();
      partial.type = 'sine';
      partial.frequency.value = note.freq * 2;
      pg.gain.setValueAtTime(0.0001, start);
      pg.gain.exponentialRampToValueAtTime(0.16 * note.gain, start + 0.01);
      pg.gain.exponentialRampToValueAtTime(0.0001, start + note.dur * 0.6);
      partial.connect(pg);
      pg.connect(master);
      partial.start(start);
      partial.stop(start + note.dur);
    }
    setTimeout(() => master.disconnect(), (toneDuration(kind) + 0.4) * 1000);
  } catch {
    // audio graph failures are never fatal
  }
}

/**
 * A very soft "thinking" shimmer: a slow swell of two high partials every
 * SHIMMER_PERIOD_S until stopped. Plays through Herald's tone bus, so the
 * echo canceller hears it as Herald's own. Returns the stop function (safe to
 * call twice). Off by default (setting: Advanced > Thinking tone).
 */
export const SHIMMER_PERIOD_S = 1.6;
export const SHIMMER_VOLUME = 0.012;

export function startShimmer(volume = SHIMMER_VOLUME): () => void {
  const c = getContext();
  if (!c) return () => {};
  if (c.state === 'suspended') void c.resume().catch(() => {});
  let master: GainNode;
  try {
    master = c.createGain();
    master.gain.value = volume;
    master.connect(getAudioGraph().toneBus() ?? c.destination);
  } catch {
    return () => {};
  }
  const swell = () => {
    try {
      const t0 = c.currentTime + 0.02;
      for (const [freq, gain] of [[E6, 1], [E6 * 1.5, 0.45]] as const) {
        const osc = c.createOscillator();
        const g = c.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(gain, t0 + 0.45);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.25);
        osc.connect(g);
        g.connect(master);
        osc.start(t0);
        osc.stop(t0 + 1.3);
      }
    } catch {
      // never fatal
    }
  };
  swell();
  const timer = setInterval(swell, SHIMMER_PERIOD_S * 1000);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    try {
      master.gain.setTargetAtTime(0.0001, c.currentTime, 0.05);
      setTimeout(() => master.disconnect(), 400);
    } catch {
      // ignore
    }
  };
}
