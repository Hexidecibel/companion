/**
 * Voice activity detection (Silero v5 via @ricky0123/vad-web, onnxruntime-web
 * WASM, single-threaded). Loaded lazily: the library and its ~14 MB of WASM are
 * only fetched once interrupt or hands-free mode actually needs them. Assets
 * come from our own origin (<base>vad/, see vite.config.ts), never a CDN.
 *
 * It listens to the CLEANED mic (MicCapture / audioGraph: echo-cancelled in the
 * graph when possible) in Herald's shared AudioContext, so Herald's own voice is
 * removed before the VAD hears it, and a microphone switch mid-session is
 * invisible to it (the cleaned stream never changes).
 */
import type { MicCapture } from './micCapture';

export type VadSensitivity = 'low' | 'normal' | 'high';

export interface VadEvents {
  /** First speech-like frame (may still be a misfire). */
  onSpeechStart: () => void;
  /** Speech held long enough to be real (minSpeechMs). */
  onSpeechRealStart: () => void;
  onMisfire: () => void;
  /** 16 kHz float audio of the whole utterance, pre-roll included. */
  onSpeechEnd: (audio: Float32Array) => void;
  /** Every processed frame (16 kHz float, 512 samples) and its speech probability. */
  onFrame: (frame: Float32Array, probability: number) => void;
}

export interface VadLike {
  readonly running: boolean;
  start(events: VadEvents, sensitivity: VadSensitivity): Promise<void>;
  pause(): void;
  setSensitivity(s: VadSensitivity): void;
  destroy(): void;
}

/**
 * Thresholds tuned for talking over a speaking Herald: strict enough that
 * keyboard clicks, a cough or residual echo do not interrupt, loose enough that
 * a normal "wait, stop" does.
 */
export const VAD_PRESETS: Record<VadSensitivity, { positiveSpeechThreshold: number; negativeSpeechThreshold: number; minSpeechMs: number; redemptionMs: number }> = {
  low: { positiveSpeechThreshold: 0.75, negativeSpeechThreshold: 0.6, minSpeechMs: 450, redemptionMs: 700 },
  normal: { positiveSpeechThreshold: 0.6, negativeSpeechThreshold: 0.45, minSpeechMs: 300, redemptionMs: 650 },
  high: { positiveSpeechThreshold: 0.45, negativeSpeechThreshold: 0.3, minSpeechMs: 200, redemptionMs: 550 },
};

function assetBase(): string {
  const base = import.meta.env.BASE_URL || '/';
  return `${base.endsWith('/') ? base : base + '/'}vad/`;
}

type MicVADInstance = {
  start: () => Promise<void>;
  pause: () => Promise<void>;
  destroy: () => Promise<void>;
  setOptions: (o: Record<string, unknown>) => void;
};

export class VadListener implements VadLike {
  private vad: MicVADInstance | null = null;
  private loading: Promise<MicVADInstance> | null = null;
  private events: VadEvents | null = null;
  private retained = false;
  private _running = false;

  constructor(private mic: MicCapture) {}

  get running(): boolean {
    return this._running;
  }

  async start(events: VadEvents, sensitivity: VadSensitivity): Promise<void> {
    this.events = events;
    if (!this.retained) {
      this.mic.retain();
      this.retained = true;
    }
    const vad = await this.load(sensitivity);
    vad.setOptions({ ...VAD_PRESETS[sensitivity] });
    await vad.start();
    this._running = true;
  }

  pause(): void {
    this._running = false;
    void this.vad?.pause();
    if (this.retained) {
      this.retained = false;
      this.mic.releaseUser();
    }
  }

  setSensitivity(s: VadSensitivity): void {
    this.vad?.setOptions({ ...VAD_PRESETS[s] });
  }

  destroy(): void {
    this.pause();
    void this.vad?.destroy();
    this.vad = null;
    this.loading = null;
  }

  private load(sensitivity: VadSensitivity): Promise<MicVADInstance> {
    if (this.vad) return Promise.resolve(this.vad);
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const [mod, ort] = await Promise.all([import('@ricky0123/vad-web'), import('onnxruntime-web/wasm')]);
      // Same module instance vad-web uses. No cross-origin isolation: one thread.
      ort.env.wasm.numThreads = 1;
      ort.env.logLevel = 'error';
      const base = assetBase();
      const vad = (await mod.MicVAD.new({
        model: 'v5',
        baseAssetPath: base,
        onnxWASMBasePath: base,
        startOnLoad: false,
        preSpeechPadMs: 400,
        submitUserSpeechOnPause: false,
        ...VAD_PRESETS[sensitivity],
        // The graph's cleaned mic, in the graph's own context; never stopped from here.
        ...(this.mic.context() ? { audioContext: this.mic.context()! } : {}),
        getStream: () => this.mic.acquireCleaned(),
        pauseStream: async () => {},
        resumeStream: () => this.mic.acquireCleaned(),
        onSpeechStart: () => this.events?.onSpeechStart(),
        onSpeechRealStart: () => this.events?.onSpeechRealStart(),
        onVADMisfire: () => this.events?.onMisfire(),
        onSpeechEnd: (audio: Float32Array) => this.events?.onSpeechEnd(audio),
        onFrameProcessed: (p: { isSpeech: number }, frame: Float32Array) => this.events?.onFrame(frame, p.isSpeech),
      })) as unknown as MicVADInstance;
      this.vad = vad;
      return vad;
    })();
    this.loading.catch(() => {
      this.loading = null;
    });
    return this.loading;
  }
}
