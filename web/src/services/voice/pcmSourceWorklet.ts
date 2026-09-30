/**
 * AudioWorklet `herald-pcm-source`: PCM16 chunks posted from the page (the
 * Android app's native microphone, 16 kHz) become an audio signal in Herald's
 * graph, so everything downstream (echo cancellation, VAD, capture) treats it
 * like any other microphone.
 *
 * A small jitter buffer absorbs the bridge's bursts: output starts once
 * TARGET_MS is queued; an underflow outputs silence and re-primes; a backlog
 * beyond MAX_MS (the native clock running ahead of the graph's) is trimmed back
 * to the target so latency never creeps up. Upsampling is linear: the source is
 * band-limited to 8 kHz already.
 *
 * Bundled by Vite as a standalone module (`?worker&url`).
 */
import { PcmJitterBuffer } from './pcmJitter';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: new (options: { processorOptions?: { inRate?: number } }) => AudioWorkletProcessor): void;

class HeraldPcmSource extends AudioWorkletProcessor {
  private jitter: PcmJitterBuffer;
  private alive = true;

  constructor(options: { processorOptions?: { inRate?: number } }) {
    super(options);
    this.jitter = new PcmJitterBuffer(options.processorOptions?.inRate ?? 16000, sampleRate);
    this.port.onmessage = (e: MessageEvent<Int16Array | 'stop'>) => {
      if (e.data === 'stop') this.alive = false;
      else this.jitter.push(e.data);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0];
    if (out) this.jitter.pull(out);
    for (let c = 1; c < (outputs[0]?.length ?? 0); c++) outputs[0][c].set(out!);
    return this.alive;
  }
}

registerProcessor('herald-pcm-source', HeraldPcmSource);
