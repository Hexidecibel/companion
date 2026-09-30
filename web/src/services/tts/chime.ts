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
 * Two soft sine notes. Blocked rises a fourth (a gentle "hey"), finished falls
 * a major third (a settled "done"). Quiet on purpose: about -26 dBFS peak.
 */
export type ToneKind = ChimeKind | 'wake';

const NOTES: Record<ToneKind, [number, number]> = {
  blocked: [659.25, 880.0], // E5 -> A5
  finished: [783.99, 622.25], // G5 -> Eb5
  wake: [1046.5, 1318.51], // C6 -> E6: a quick bright "I'm listening"
};

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
    master.gain.value = volume;
    master.connect(c.destination);
    NOTES[kind].forEach((freq, i) => {
      const start = t0 + i * 0.13;
      const dur = i === 0 ? 0.32 : 0.55;
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      // Soft attack, exponential tail: a struck-glass feel, no click.
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(1, start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(g);
      g.connect(master);
      osc.start(start);
      osc.stop(start + dur + 0.05);
      // A quiet octave partial adds a little shimmer.
      const partial = c.createOscillator();
      const pg = c.createGain();
      partial.type = 'sine';
      partial.frequency.value = freq * 2;
      pg.gain.setValueAtTime(0.0001, start);
      pg.gain.exponentialRampToValueAtTime(0.18, start + 0.01);
      pg.gain.exponentialRampToValueAtTime(0.0001, start + dur * 0.6);
      partial.connect(pg);
      pg.connect(master);
      partial.start(start);
      partial.stop(start + dur);
    });
    setTimeout(() => master.disconnect(), 1200);
  } catch {
    // audio graph failures are never fatal
  }
}
