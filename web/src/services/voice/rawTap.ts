/**
 * The microphone BEFORE echo cancellation, at 16 kHz, in a ring buffer.
 *
 * Why: the canceller's non-linear suppressor clamps the user's voice while
 * Herald is still talking (double-talk), which is exactly when someone says
 * "stop". Detection (VAD) runs on the cleaned signal, so Herald's voice never
 * triggers it; the words of a talk-over, and the wake stream, come from here
 * instead, intact. Herald's own words mixed in are removed at the text level
 * (echoGuard.ts), as before.
 *
 * Positions are absolute sample counts since the tap started, so a caller can
 * mark "speech started here" and slice it later.
 */

export interface RawAudio {
  /** Samples written so far (16 kHz). */
  position(): number;
  /** Samples [from, to) that are still in the ring (clamped). */
  slice(from: number, to: number): Float32Array;
}

export class RawRing implements RawAudio {
  private buf: Float32Array;
  private written = 0;

  constructor(readonly capacity = 16000 * 20) {
    this.buf = new Float32Array(capacity);
  }

  position(): number {
    return this.written;
  }

  pushInt16(pcm: Int16Array): void {
    const cap = this.capacity;
    for (let i = 0; i < pcm.length; i++) this.buf[(this.written + i) % cap] = pcm[i] / 32768;
    this.written += pcm.length;
  }

  push(x: Float32Array): void {
    const cap = this.capacity;
    for (let i = 0; i < x.length; i++) this.buf[(this.written + i) % cap] = x[i];
    this.written += x.length;
  }

  slice(from: number, to: number): Float32Array {
    const lo = Math.max(from, this.written - this.capacity, 0);
    const hi = Math.min(to, this.written);
    if (hi <= lo) return new Float32Array(0);
    const out = new Float32Array(hi - lo);
    const cap = this.capacity;
    for (let i = 0; i < out.length; i++) out[i] = this.buf[(lo + i) % cap];
    return out;
  }

  reset(): void {
    this.written = 0;
  }
}
