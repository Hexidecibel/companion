/**
 * In-graph echo cancellation core (runs inside the `herald-aec` AudioWorklet,
 * and in Node for tests). Pure framing and bookkeeping around a WebRTC AEC3
 * instance (@ennuicastr/webrtcaec3.js, WASM):
 *
 *   mic (render quantum, context rate) --+
 *                                        +--> AEC3 (10 ms blocks) --> FIFO --> cleaned quantum
 *   playback reference (same quantum) ---+
 *
 * Playback and capture share one AudioContext, so the reference is the exact
 * set of samples rendered in the same quantum as the mic samples; AEC3's own
 * delay estimator absorbs the acoustic path (output latency + room + input
 * latency). Cancellation happens at the context rate (48 kHz, or 44.1 kHz
 * resampled by AEC3 to 48 kHz internally); downsampling to 16 kHz for VAD, wake
 * word and STT happens after, in the capture worklet / VAD.
 *
 * AEC3 emits whole 10 ms blocks, while the graph pulls 128-sample quanta. The
 * output FIFO is primed with one block of silence, which is exactly enough
 * that it never underflows: a fixed 10 ms of added latency.
 */

/** The subset of the AEC3 instance API used here (see webrtcaec3.types.d.ts). */
export interface Aec3Like {
  analyze(data: Float32Array[], opts?: { sampleRateIn?: number }): void;
  processSize(data: Float32Array[], opts?: { sampleRateIn?: number; sampleRateOut?: number }): number;
  process(out: Float32Array[], data: Float32Array[], opts?: { sampleRateIn?: number; sampleRateOut?: number }): void;
  setAudioBufferDelay?(ms: number): void;
  free(): void;
}

/** Rates AEC3 runs at natively; anything else is resampled to 48 kHz inside AEC3. */
export const AEC_NATIVE_RATES: readonly number[] = [16000, 32000, 48000];

export function aecRateFor(contextRate: number): number {
  return AEC_NATIVE_RATES.includes(contextRate) ? contextRate : 48000;
}

/** Playback quieter than this (dBFS, per 10 ms block) is "nothing playing". */
export const REF_ACTIVE_DB = -50;

/**
 * Energy sums over blocks with playback active, for echo measurement. Powers
 * are mean-square per sample. `blocks` counts 10 ms blocks with the reference
 * active; `idleBlocks` those without.
 */
export interface AecStats {
  blocks: number;
  idleBlocks: number;
  refPow: number;
  micPow: number;
  outPow: number;
  /** Mean-square of the mic / output while nothing plays (room noise floor). */
  idleMicPow: number;
  idleOutPow: number;
}

export function emptyStats(): AecStats {
  return { blocks: 0, idleBlocks: 0, refPow: 0, micPow: 0, outPow: 0, idleMicPow: 0, idleOutPow: 0 };
}

function meanSquare(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return to > from ? s / (to - from) : 0;
}

export function powDb(p: number): number {
  return 10 * Math.log10(p + 1e-12);
}

/**
 * Fixed-capacity sample FIFO (single channel). Capacity grows if needed: it
 * only ever holds about one block plus one quantum.
 */
export class SampleFifo {
  private buf: Float32Array;
  private r = 0;
  private n = 0;

  constructor(capacity: number) {
    this.buf = new Float32Array(Math.max(16, capacity));
  }

  get length(): number {
    return this.n;
  }

  push(x: Float32Array, count = x.length): void {
    if (this.n + count > this.buf.length) this.grow(this.n + count);
    const cap = this.buf.length;
    let w = (this.r + this.n) % cap;
    for (let i = 0; i < count; i++) {
      this.buf[w] = x[i];
      w = w + 1 === cap ? 0 : w + 1;
    }
    this.n += count;
  }

  pushZeros(count: number): void {
    this.push(new Float32Array(count));
  }

  /** Pop into `out`; missing samples (underflow) are zero. Returns samples popped. */
  pop(out: Float32Array): number {
    const cap = this.buf.length;
    const take = Math.min(out.length, this.n);
    for (let i = 0; i < take; i++) {
      out[i] = this.buf[this.r];
      this.r = this.r + 1 === cap ? 0 : this.r + 1;
    }
    for (let i = take; i < out.length; i++) out[i] = 0;
    this.n -= take;
    return take;
  }

  clear(): void {
    this.r = 0;
    this.n = 0;
  }

  private grow(min: number): void {
    const next = new Float32Array(Math.max(min, this.buf.length * 2));
    const cap = this.buf.length;
    for (let i = 0; i < this.n; i++) next[i] = this.buf[(this.r + i) % cap];
    this.buf = next;
    this.r = 0;
  }
}

/**
 * One echo-cancelled mono stream. Call `process` once per render quantum.
 * Without an AEC instance (still loading, or failed) it passes the mic through.
 */
export class AecStream {
  readonly block: number;
  private aec: Aec3Like | null = null;
  private readonly opts: { sampleRateIn: number; sampleRateOut: number } | undefined;
  private fifo: SampleFifo;
  private outBuf: Float32Array[] = [new Float32Array(0)];
  private stats: AecStats = emptyStats();
  // Per-block energy accumulation (blocks follow the context rate, 10 ms).
  private accN = 0;
  private accRef = 0;
  private accMic = 0;
  private accOut = 0;
  private readonly refActive: number;
  bypass = false;

  constructor(readonly rate: number, aec: Aec3Like | null = null) {
    this.block = Math.floor(rate / 100);
    const aecRate = aecRateFor(rate);
    this.opts = aecRate === rate ? undefined : { sampleRateIn: rate, sampleRateOut: rate };
    this.fifo = new SampleFifo(this.block * 4);
    this.refActive = Math.pow(10, REF_ACTIVE_DB / 10);
    if (aec) this.attach(aec);
  }

  get active(): boolean {
    return this.aec !== null && !this.bypass;
  }

  /** Start cancelling with this AEC instance (primes the FIFO: 10 ms latency). */
  attach(aec: Aec3Like): void {
    this.aec?.free();
    this.aec = aec;
    this.fifo.clear();
    this.fifo.pushZeros(this.block);
  }

  /** Swap in a fresh instance (device change: the old echo path is meaningless). */
  reset(aec: Aec3Like | null): void {
    if (aec) this.attach(aec);
    else {
      this.aec?.free();
      this.aec = null;
      this.fifo.clear();
    }
  }

  dispose(): void {
    this.aec?.free();
    this.aec = null;
  }

  /**
   * One quantum. `ref` null / empty = nothing connected as playback (treated as
   * silence, which AEC3 still needs for its timeline). Writes `out`.
   */
  process(mic: Float32Array, ref: Float32Array | null | undefined, out: Float32Array): void {
    const n = mic.length;
    const r = ref && ref.length === n ? ref : null;
    if (!this.aec || this.bypass) {
      out.set(mic);
      this.accumulate(mic, r, mic);
      return;
    }
    const refData = r ?? new Float32Array(n);
    this.aec.analyze([refData], this.opts);
    const size = this.aec.processSize([mic], this.opts);
    if (this.outBuf[0].length < size) this.outBuf = [new Float32Array(size)];
    this.aec.process(this.outBuf, [mic], this.opts);
    if (size > 0) this.fifo.push(this.outBuf[0], size);
    this.fifo.pop(out);
    this.accumulate(mic, r, out);
  }

  /** Energy sums since the last call (and reset). */
  takeStats(): AecStats {
    const s = this.stats;
    this.stats = emptyStats();
    return s;
  }

  private accumulate(mic: Float32Array, ref: Float32Array | null, out: Float32Array): void {
    // Block-wise energies (block = 10 ms). Quanta rarely align with blocks, so
    // accumulate sample sums and close a block whenever `block` samples are in.
    const n = mic.length;
    let i = 0;
    while (i < n) {
      const take = Math.min(n - i, this.block - this.accN);
      this.accMic += meanSquare(mic, i, i + take) * take;
      this.accOut += meanSquare(out, i, i + take) * take;
      if (ref) this.accRef += meanSquare(ref, i, i + take) * take;
      this.accN += take;
      i += take;
      if (this.accN === this.block) {
        const refP = this.accRef / this.block;
        const micP = this.accMic / this.block;
        const outP = this.accOut / this.block;
        if (refP > this.refActive) {
          this.stats.blocks++;
          this.stats.refPow += refP;
          this.stats.micPow += micP;
          this.stats.outPow += outP;
        } else {
          this.stats.idleBlocks++;
          this.stats.idleMicPow += micP;
          this.stats.idleOutPow += outP;
        }
        this.accN = 0;
        this.accRef = 0;
        this.accMic = 0;
        this.accOut = 0;
      }
    }
  }
}

/**
 * Echo figures from accumulated stats (playback-active blocks only).
 * - `erlDb`: acoustic loss, playback -> raw mic (large: little echo reaches the mic)
 * - `erleDb`: what cancellation removed, raw mic -> cleaned
 * - `totalDb`: playback -> cleaned (what is left of Herald in what we listen to)
 * Null when there was too little playback to say.
 */
export function echoFigures(s: AecStats, minBlocks = 50): { erlDb: number; erleDb: number; totalDb: number } | null {
  if (s.blocks < minBlocks) return null;
  const ref = s.refPow / s.blocks;
  // Subtract the room noise floor so a noisy room does not read as echo, but
  // never below a quarter of it: echo under the noise floor cannot be measured,
  // so the figure is capped there (~6 dB below the floor) instead of running
  // off to 90 dB.
  const floorMic = s.idleBlocks ? s.idleMicPow / s.idleBlocks : 0;
  const floorOut = s.idleBlocks ? s.idleOutPow / s.idleBlocks : 0;
  const mic = Math.max(s.micPow / s.blocks - floorMic, floorMic * 0.25, 1e-12);
  const out = Math.max(s.outPow / s.blocks - floorOut, floorOut * 0.25, 1e-12);
  return {
    erlDb: powDb(ref) - powDb(mic),
    erleDb: powDb(mic) - powDb(out),
    totalDb: powDb(ref) - powDb(out),
  };
}

export function mergeStats(a: AecStats, b: AecStats): AecStats {
  return {
    blocks: a.blocks + b.blocks,
    idleBlocks: a.idleBlocks + b.idleBlocks,
    refPow: a.refPow + b.refPow,
    micPow: a.micPow + b.micPow,
    outPow: a.outPow + b.outPow,
    idleMicPow: a.idleMicPow + b.idleMicPow,
    idleOutPow: a.idleOutPow + b.idleOutPow,
  };
}
