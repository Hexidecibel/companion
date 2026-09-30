// @vitest-environment node
/**
 * The in-graph echo canceller, with the real AEC3 WASM, driven exactly as the
 * AudioWorklet drives it (128-sample render quanta at the context rate).
 * Synthetic echo path: Herald's playback convolved with a room impulse response
 * (60 ms of output + input latency, 300 ms tail), attenuated, plus a near-end
 * talker who starts during playback (double-talk) and keeps going after it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import WebRtcAec3 from '@ennuicastr/webrtcaec3.js';
import { AecStream, SampleFifo, aecRateFor, echoFigures, mergeStats, emptyStats, type Aec3Like } from '../aec/aecCore';
import { convolve, db, meanPow, roomImpulse, rng, synthSpeech } from './fixtures/synthAudio';

type Aec3Module = Awaited<ReturnType<typeof WebRtcAec3>>;
let mod: Aec3Module;

beforeAll(async () => {
  mod = await WebRtcAec3();
});

const QUANTUM = 128;

function run(stream: AecStream, mic: Float32Array, ref: Float32Array | null): Float32Array {
  const out = new Float32Array(mic.length);
  const q = new Float32Array(QUANTUM);
  for (let i = 0; i + QUANTUM <= mic.length; i += QUANTUM) {
    stream.process(mic.subarray(i, i + QUANTUM), ref ? ref.subarray(i, i + QUANTUM) : null, q);
    out.set(q, i);
  }
  return out;
}

/** Best normalised correlation of `a` with `b` shifted by 0..maxLag samples. */
function bestCorr(a: Float32Array, b: Float32Array, from: number, to: number, maxLag: number): number {
  let best = 0;
  for (let lag = 0; lag <= maxLag; lag += 8) {
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let i = from; i < to; i++) {
      const u = a[i];
      const v = b[i + lag] ?? 0;
      xy += u * v;
      xx += u * u;
      yy += v * v;
    }
    best = Math.max(best, xy / Math.sqrt(xx * yy + 1e-20));
  }
  return best;
}

describe('SampleFifo', () => {
  it('keeps order across wrap-around and zero-fills underflow', () => {
    const f = new SampleFifo(16);
    const out = new Float32Array(5);
    let v = 0;
    let expectNext = 0;
    for (let round = 0; round < 20; round++) {
      const chunk = Float32Array.from({ length: 7 }, () => v++);
      f.push(chunk);
      f.pop(out);
      for (const x of out) expect(x).toBe(expectNext++);
    }
    const tiny = new SampleFifo(16);
    tiny.push(Float32Array.of(1, 2));
    const o = new Float32Array(4);
    expect(tiny.pop(o)).toBe(2);
    expect(Array.from(o)).toEqual([1, 2, 0, 0]);
  });
});

describe('aecRateFor', () => {
  it('runs natively at 16/32/48 kHz and resamples 44.1 kHz to 48 kHz', () => {
    expect(aecRateFor(48000)).toBe(48000);
    expect(aecRateFor(16000)).toBe(16000);
    expect(aecRateFor(44100)).toBe(48000);
  });
});

describe('AecStream framing', () => {
  it('passes the mic through untouched without an AEC instance', () => {
    const s = new AecStream(48000, null);
    const mic = synthSpeech(48000, 0.2, 1);
    const out = run(s, mic, null);
    expect(Array.from(out.subarray(0, 9000))).toEqual(Array.from(mic.subarray(0, 9000)));
  });

  it('adds exactly one 10 ms block of latency and never underflows (48 kHz and 44.1 kHz)', () => {
    for (const rate of [48000, 44100]) {
      // Identity "AEC": emits whole 10 ms blocks of the input, like AEC3.
      let pending: number[] = [];
      const block = Math.floor(rate / 100);
      const fake: Aec3Like = {
        analyze: () => {},
        processSize: (d) => Math.floor((pending.length + d[0].length) / block) * block,
        process: (o, d) => {
          pending.push(...d[0]);
          const n = Math.floor(pending.length / block) * block;
          o[0].set(pending.slice(0, n));
          pending = pending.slice(n);
        },
        free: () => {},
      };
      const s = new AecStream(rate, fake);
      const mic = Float32Array.from({ length: QUANTUM * 200 }, (_, i) => Math.sin(i / 7) * 0.5 + 0.01);
      const out = run(s, mic, null);
      // Output = input delayed by exactly one block; no zero gaps after that.
      for (let i = block; i < out.length; i++) expect(out[i]).toBeCloseTo(mic[i - block], 6);
      for (let i = 0; i < block; i++) expect(out[i]).toBe(0);
    }
  });
});

describe('AecStream with WebRTC AEC3 (synthetic room)', () => {
  const sr = 48000;
  const secs = 12;
  // Herald talks for 11 s; the user talks from 8 s to 12 s (3 s of double-talk).
  const far = synthSpeech(sr, secs, 1, { f0: 110 });
  far.fill(0, Math.floor(sr * 11));
  const echo = convolve(far, roomImpulse(sr, 0.3, 60));
  for (let i = 0; i < echo.length; i++) echo[i] *= 0.7;
  const nearStart = Math.floor(sr * 8);
  const nearTalk = synthSpeech(sr, 4, 99, { f0: 210, rate: 3.1, phase: 0.37, formantScale: 1.15, peak: 0.35 });
  const near = new Float32Array(far.length);
  near.set(nearTalk, nearStart);
  const r = rng(3);
  const mic = new Float32Array(far.length);
  for (let i = 0; i < mic.length; i++) mic[i] = echo[i] + near[i] + (r() - 0.5) * 0.001;

  let out: Float32Array;
  let stream: AecStream;
  let startMs = 0;
  let cpuMs = 0;

  beforeAll(() => {
    stream = new AecStream(sr, new mod.AEC3(sr, 1, 1) as Aec3Like);
    startMs = performance.now();
    out = run(stream, mic, far);
    cpuMs = performance.now() - startMs;
  });

  it('removes at least 25 dB of echo once converged (far-end only, 3-8 s)', () => {
    const erle = db(meanPow(mic, 3 * sr, 8 * sr)) - db(meanPow(out, 3 * sr, 8 * sr));
    console.info(`AEC3 synthetic: ERLE ${erle.toFixed(1)} dB, CPU ${((cpuMs / (secs * 1000)) * 100).toFixed(2)}% of one core`);
    expect(erle).toBeGreaterThanOrEqual(25);
  });

  it('keeps near-end speech: double-talk (8-11 s) is not cancelled away', () => {
    const kept = db(meanPow(out, 8 * sr, 11 * sr)) - db(meanPow(near, 8 * sr, 11 * sr));
    // AEC3's suppressor dips the near end during double-talk, but it survives.
    expect(kept).toBeGreaterThan(-15);
    expect(bestCorr(near, out, 8 * sr, 11 * sr, sr / 50)).toBeGreaterThan(0.3);
  });

  it('passes near-end speech intact once Herald stops (11.5-12 s)', () => {
    const a = Math.floor(11.5 * sr);
    const b = 12 * sr - QUANTUM;
    const kept = db(meanPow(out, a, b)) - db(meanPow(near, a, b));
    expect(Math.abs(kept)).toBeLessThan(3);
    expect(bestCorr(near, out, a, b, sr / 50)).toBeGreaterThan(0.9);
  });

  it('reports echo figures from its own stats', () => {
    // A fresh stream over the converged far-end-only part.
    const s = new AecStream(sr, new mod.AEC3(sr, 1, 1) as Aec3Like);
    run(s, mic.subarray(0, 3 * sr), far.subarray(0, 3 * sr));
    s.takeStats(); // discard convergence
    run(s, mic.subarray(3 * sr, 8 * sr), far.subarray(3 * sr, 8 * sr));
    const fig = echoFigures(mergeStats(emptyStats(), s.takeStats()));
    expect(fig).not.toBeNull();
    expect(fig!.erleDb).toBeGreaterThan(20);
    expect(fig!.totalDb).toBeCloseTo(fig!.erlDb + fig!.erleDb, 6);
    s.dispose();
  });

  it('runs well under real time (budget: 10% of a core)', () => {
    expect(cpuMs / (secs * 1000)).toBeLessThan(0.1);
  });
});
