/**
 * AudioWorklet: microphone -> 16 kHz mono PCM16 frames (100 ms, or
 * processorOptions.frameSamples) + RMS level.
 * Bundled by Vite as a standalone module (`?worker&url`) and loaded with
 * audioWorklet.addModule. Runs on the audio rendering thread.
 */
import { Framer, Resampler16k, floatToInt16, rms16 } from './pcm';

// Minimal AudioWorkletGlobalScope typings (not in lib.dom).
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: new (options?: { processorOptions?: { frameSamples?: number } }) => AudioWorkletProcessor): void;

class HeraldCaptureProcessor extends AudioWorkletProcessor {
  private resampler = new Resampler16k(sampleRate);
  private framer: Framer;
  private running = true;

  constructor(options?: { processorOptions?: { frameSamples?: number } }) {
    super(options);
    this.framer = new Framer(options?.processorOptions?.frameSamples);
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data === 'stop') {
        this.running = false;
        const rest = this.framer.flush();
        if (rest.length) this.port.postMessage({ pcm: rest, level: rms16(rest) }, [rest.buffer]);
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (ch && this.running) {
      for (const frame of this.framer.push(floatToInt16(this.resampler.process(ch)))) {
        this.port.postMessage({ pcm: frame, level: rms16(frame) }, [frame.buffer]);
      }
    }
    return this.running;
  }
}

registerProcessor('herald-capture', HeraldCaptureProcessor);
