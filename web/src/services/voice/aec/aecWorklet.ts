/**
 * AudioWorklet `herald-aec`: in-graph echo cancellation.
 *
 *   input 0: microphone (raw: browser echo cancellation off)
 *   input 1: Herald's playback bus (the exact samples rendered this quantum)
 *   output 0: cleaned microphone, at the context rate
 *
 * The WebRTC AEC3 WASM is compiled from bytes handed over in processorOptions
 * (AudioWorkletGlobalScope has no fetch); until it is ready, and when bypassed,
 * the mic passes through untouched. Posts energy stats every ~250 ms so the
 * page can measure how much of Herald's voice is left in what it listens to.
 *
 * Bundled by Vite as a standalone module (`?worker&url`).
 */
import WebRtcAec3 from '@ennuicastr/webrtcaec3.js';
import { AecStream, aecRateFor, type Aec3Like } from './aecCore';

declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: new (options: { processorOptions?: AecOptions }) => AudioWorkletProcessor): void;

interface AecOptions {
  wasmBinary?: ArrayBuffer | null;
  statsIntervalMs?: number;
}

export type AecWorkletIn =
  | { type: 'bypass'; on: boolean }
  | { type: 'reset' }
  | { type: 'dispose' };

export type AecWorkletOut =
  | { type: 'ready'; rate: number; aecRate: number }
  | { type: 'error'; message: string }
  | { type: 'stats'; at: number; blocks: number; idleBlocks: number; refPow: number; micPow: number; outPow: number; idleMicPow: number; idleOutPow: number };

type Aec3Module = Awaited<ReturnType<typeof WebRtcAec3>>;

class HeraldAecProcessor extends AudioWorkletProcessor {
  private stream = new AecStream(sampleRate, null);
  private mod: Aec3Module | null = null;
  private alive = true;
  private statsEvery: number;
  private sinceStats = 0;

  constructor(options: { processorOptions?: AecOptions }) {
    super(options);
    const opts = options.processorOptions ?? {};
    this.statsEvery = Math.max(1, Math.round(((opts.statsIntervalMs ?? 250) / 1000) * sampleRate));
    this.port.onmessage = (e: MessageEvent<AecWorkletIn>) => this.onMessage(e.data);
    if (opts.wasmBinary) void this.load(opts.wasmBinary);
    else this.post({ type: 'error', message: 'no AEC module' });
  }

  private async load(wasmBinary: ArrayBuffer): Promise<void> {
    try {
      const mod = await (WebRtcAec3 as unknown as (m: Record<string, unknown>) => Promise<Aec3Module>)({
        wasmBinary,
        // Emscripten prints through these; there is no console noise to keep.
        print: () => {},
        printErr: () => {},
      });
      if (!this.alive) return;
      this.mod = mod;
      this.stream.attach(this.create());
      this.post({ type: 'ready', rate: sampleRate, aecRate: aecRateFor(sampleRate) });
    } catch (err) {
      this.post({ type: 'error', message: String((err as Error)?.message ?? err) });
    }
  }

  private create(): Aec3Like {
    return new this.mod!.AEC3(aecRateFor(sampleRate), 1, 1) as Aec3Like;
  }

  private onMessage(msg: AecWorkletIn): void {
    if (msg.type === 'bypass') this.stream.bypass = msg.on;
    else if (msg.type === 'reset') this.stream.reset(this.mod ? this.create() : null);
    else if (msg.type === 'dispose') {
      this.alive = false;
      this.stream.dispose();
    }
  }

  private post(m: AecWorkletOut): void {
    this.port.postMessage(m);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (!this.alive) return false;
    const out = outputs[0]?.[0];
    const mic = inputs[0]?.[0];
    if (!out) return true;
    if (!mic) {
      out.fill(0);
      return true;
    }
    try {
      this.stream.process(mic, inputs[1]?.[0], out);
    } catch (err) {
      // A WASM trap must never take the mic down: fall back to pass-through.
      this.stream.reset(null);
      out.set(mic);
      this.post({ type: 'error', message: String((err as Error)?.message ?? err) });
    }
    // Mirror to every output channel (mono in, possibly stereo-counted out).
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    this.sinceStats += mic.length;
    if (this.sinceStats >= this.statsEvery) {
      this.sinceStats = 0;
      this.post({ type: 'stats', at: currentTime, ...this.stream.takeStats() });
    }
    return true;
  }
}

registerProcessor('herald-aec', HeraldAecProcessor);
