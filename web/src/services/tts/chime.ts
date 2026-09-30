import type { ChimeKind } from './heraldSpeech';

type AudioCtor = typeof AudioContext;

let ctx: AudioContext | null = null;

function getCtor(): AudioCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function getContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = getCtor();
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    ctx = null;
  }
  return ctx;
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
 * Quiet on purpose: about -26 dBFS peak at the default volume.
 */
export type ToneKind = ChimeKind | 'wake' | 'ok';

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
  wake: [
    { freq: C6, at: 0, dur: 0.25, gain: 1 },
    { freq: E6, at: 0.1, dur: 0.4, gain: 1 },
  ],
  ok: [{ freq: C6, at: 0, dur: 0.35, gain: 0.7 }],
};

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
    master.connect(c.destination);
    for (const note of TONES[kind]) {
      const start = t0 + note.at;
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = note.freq;
      // Soft attack, exponential tail: a struck-glass feel, no click.
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(note.gain, start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, start + note.dur);
      osc.connect(g);
      g.connect(master);
      osc.start(start);
      osc.stop(start + note.dur + 0.05);
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
