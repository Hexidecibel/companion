/**
 * Deterministic test audio: a speech-like source (glottal pulses through three
 * formant resonators with a syllabic envelope), a synthetic room impulse
 * response, and convolution. No fixtures on disk; same numbers every run.
 */

export { rng, synthSpeech, type SpeechOpts } from '../../aec/probeSignal';
import { rng } from '../../aec/probeSignal';

/** Exponentially decaying noise tail after a direct path at `delayMs`. */
export function roomImpulse(sr: number, rt60 = 0.3, delayMs = 12, seed = 7): Float32Array {
  const r = rng(seed);
  const d = Math.floor((sr * delayMs) / 1000);
  const n = Math.floor(sr * rt60);
  const ir = new Float32Array(d + n);
  ir[d] = 0.6;
  for (let i = 1; i < n; i++) ir[d + i] += (r() - 0.5) * 0.5 * Math.exp((-6.9 * i) / n);
  return ir;
}

/** Direct-form convolution (skips near-zero taps: IRs here are sparse-ish). */
export function convolve(x: Float32Array, h: Float32Array): Float32Array {
  const y = new Float32Array(x.length);
  for (let k = 0; k < h.length; k++) {
    const hk = h[k];
    if (Math.abs(hk) < 1e-4) continue;
    for (let i = k; i < x.length; i++) y[i] += hk * x[i - k];
  }
  return y;
}

export function meanPow(x: Float32Array, a = 0, b = x.length): number {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return s / Math.max(1, b - a) + 1e-20;
}

export function db(p: number): number {
  return 10 * Math.log10(p);
}
