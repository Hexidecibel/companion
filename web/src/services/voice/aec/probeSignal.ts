/**
 * A deterministic speech-like signal (glottal pulses through three formant
 * resonators, syllabic envelope). The echo check plays it when Herald's neural
 * voice is unavailable, and tests use it as a talker. Not speech: just close
 * enough in spectrum and rhythm that echo cancellers and VADs treat it as such.
 */

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export interface SpeechOpts {
  f0?: number;
  /** Syllables per second. */
  rate?: number;
  /** Syllable phase offset (0..1): keeps two talkers' pauses apart. */
  phase?: number;
  /** Formant scale (a different vocal tract). */
  formantScale?: number;
  peak?: number;
}

export function synthSpeech(sr: number, secs: number, seed: number, o: SpeechOpts = {}): Float32Array {
  const f0 = o.f0 ?? 120;
  const rate = o.rate ?? 4;
  const phase = o.phase ?? 0;
  const fs = o.formantScale ?? 1;
  const r = rng(seed);
  const n = Math.floor(sr * secs);
  const out = new Float32Array(n);
  const forms: Array<[number, number]> = [[700, 130], [1220, 70], [2600, 160]];
  const st = forms.map(() => [0, 0]);
  let ph = 0;
  let vowel = 0;
  const syll = Math.floor(sr / rate);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    if (i % syll === 0) vowel = r();
    const f = f0 * (1 + 0.15 * Math.sin(2 * Math.PI * 0.7 * t) + 0.05 * vowel);
    ph += f / sr;
    let x = (r() - 0.5) * 0.05;
    if (ph >= 1) {
      ph -= 1;
      x += 1;
    }
    let y = 0;
    for (let k = 0; k < forms.length; k++) {
      const [F, B] = forms[k];
      const Fk = F * fs * (0.8 + 0.4 * vowel);
      const R = Math.exp((-Math.PI * B) / sr);
      const a1 = 2 * R * Math.cos((2 * Math.PI * Fk) / sr);
      const a2 = -R * R;
      const s = st[k];
      const v = x + a1 * s[0] + a2 * s[1];
      s[1] = s[0];
      s[0] = v;
      y += v * (1 - R);
    }
    const u = (t * rate + phase) % 1;
    const env = Math.pow(Math.max(0, Math.sin(Math.PI * u)), 0.6) * (Math.floor(t * rate + phase) % 5 === 4 ? 0.1 : 1);
    out[i] = y * env;
  }
  let m = 0;
  for (const v of out) m = Math.max(m, Math.abs(v));
  const g = (o.peak ?? 0.5) / (m || 1);
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

