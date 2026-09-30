/**
 * PCM helpers shared by the capture AudioWorklet and the uplink. Pure and
 * allocation-light: this runs on the audio thread every 128 samples.
 */

export const TARGET_RATE = 16000;
/** 100 ms at 16 kHz: one uplink message per frame. */
export const FRAME_SAMPLES = 1600;

/**
 * Streaming downsampler to 16 kHz. Each output sample is the mean of the input
 * samples it covers (a box low-pass), which is adequate anti-aliasing for
 * speech and keeps state across calls so chunk boundaries are seamless.
 */
export class Resampler16k {
  private readonly step: number;
  private pos = 0;
  private carry: Float32Array = new Float32Array(0);

  constructor(readonly inRate: number) {
    if (!(inRate >= TARGET_RATE)) throw new Error(`input rate ${inRate} below ${TARGET_RATE}`);
    this.step = inRate / TARGET_RATE;
  }

  process(input: Float32Array): Float32Array {
    if (this.step === 1) return input.slice();
    let buf: Float32Array;
    if (this.carry.length) {
      buf = new Float32Array(this.carry.length + input.length);
      buf.set(this.carry);
      buf.set(input, this.carry.length);
    } else {
      buf = input;
    }
    const maxOut = Math.floor((buf.length - this.pos) / this.step) + 1;
    const out = new Float32Array(Math.max(0, maxOut));
    let n = 0;
    let pos = this.pos;
    while (pos + this.step <= buf.length) {
      const start = Math.floor(pos);
      const end = Math.floor(pos + this.step);
      let sum = 0;
      for (let i = start; i < end; i++) sum += buf[i];
      out[n++] = sum / (end - start);
      pos += this.step;
    }
    const consumed = Math.floor(pos);
    this.carry = buf.slice(consumed);
    this.pos = pos - consumed;
    return out.subarray(0, n);
  }
}

export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return out;
}

/** RMS of a PCM16 frame, 0..1. */
export function rms16(frame: Int16Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i] / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / frame.length);
}

/** Perceptual 0..1 meter value from RMS (-60 dBFS .. -10 dBFS). */
export function meterLevel(rms: number): number {
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (db + 60) / 50));
}

/** Accumulates samples and emits fixed-size frames (the last partial is kept). */
export class Framer {
  private buf: Int16Array;
  private n = 0;

  constructor(readonly size = FRAME_SAMPLES) {
    this.buf = new Int16Array(size);
  }

  push(samples: Int16Array): Int16Array[] {
    const out: Int16Array[] = [];
    let i = 0;
    while (i < samples.length) {
      const take = Math.min(this.size - this.n, samples.length - i);
      this.buf.set(samples.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === this.size) {
        out.push(this.buf);
        this.buf = new Int16Array(this.size);
        this.n = 0;
      }
    }
    return out;
  }

  /** Remaining partial frame (possibly empty); resets. */
  flush(): Int16Array {
    const rest = this.buf.slice(0, this.n);
    this.n = 0;
    return rest;
  }
}

/** Little-endian PCM16 -> base64 (every platform we run on is little-endian). */
export function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)));
  }
  return btoa(bin);
}

export function float32ToInt16Frames(audio: Float32Array, size = FRAME_SAMPLES): Int16Array[] {
  const f = new Framer(size);
  const frames = f.push(floatToInt16(audio));
  const rest = f.flush();
  if (rest.length) frames.push(rest);
  return frames;
}
