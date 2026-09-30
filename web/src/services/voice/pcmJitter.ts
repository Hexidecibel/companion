/**
 * Jitter buffer + linear resampler for PCM pushed in bursts (pure; used by the
 * `herald-pcm-source` worklet and tested directly).
 */

/** Start playing once this much is queued (ms). */
export const TARGET_MS = 60;
/** Trim back to the target beyond this backlog (ms). */
export const MAX_MS = 300;

export class PcmJitterBuffer {
  private buf: Float32Array;
  private r = 0;
  private n = 0;
  private primed = false;
  /** Fractional read position between the current and next input sample. */
  private frac = 0;
  private readonly step: number;
  private readonly target: number;
  private readonly max: number;
  underflows = 0;
  trims = 0;

  constructor(readonly inRate: number, readonly outRate: number) {
    this.step = inRate / outRate;
    this.target = Math.round((inRate * TARGET_MS) / 1000);
    this.max = Math.round((inRate * MAX_MS) / 1000);
    this.buf = new Float32Array(Math.max(1024, this.max * 2));
  }

  /** Samples queued (input rate). */
  get queued(): number {
    return this.n;
  }

  push(pcm: Int16Array): void {
    const cap = this.buf.length;
    for (let i = 0; i < pcm.length; i++) {
      if (this.n === cap) {
        // Full: drop the oldest.
        this.r = (this.r + 1) % cap;
        this.n--;
      }
      this.buf[(this.r + this.n) % cap] = pcm[i] / 32768;
      this.n++;
    }
    if (this.n > this.max) {
      const drop = this.n - this.target;
      this.r = (this.r + drop) % cap;
      this.n -= drop;
      this.trims++;
    }
  }

  /** Fill `out` (output rate); silence while priming or on underflow. */
  pull(out: Float32Array): void {
    if (!this.primed) {
      if (this.n < this.target) {
        out.fill(0);
        return;
      }
      this.primed = true;
    }
    const cap = this.buf.length;
    for (let i = 0; i < out.length; i++) {
      if (this.n < 2) {
        out.fill(0, i);
        this.primed = false;
        this.underflows++;
        return;
      }
      const a = this.buf[this.r];
      const b = this.buf[(this.r + 1) % cap];
      out[i] = a + (b - a) * this.frac;
      this.frac += this.step;
      while (this.frac >= 1 && this.n >= 2) {
        this.frac -= 1;
        this.r = (this.r + 1) % cap;
        this.n--;
      }
    }
  }
}
