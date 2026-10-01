/**
 * Herald's one shared AudioContext: everything Herald plays and everything it
 * listens to goes through this graph, so the echo canceller gets the exact
 * playback samples as its reference.
 *
 *   TTS ----> voiceBus (Herald volume) --+
 *   chimes --> toneBus (tones volume) ----+--> playbackBus --> outputClamp --> destination
 *                                                                  |
 *                                                                  +--(reference)--> [herald-aec] input 1
 *   mic source ------------------------->  [herald-aec] input 0 --> cleanedBus --> capture worklet (16 kHz PCM)
 *        |                                                               +--------> cleanedStream (VAD)
 *        +--> rawBus (measurement only)
 *
 * Volume (`services/tts/volume.ts`) is applied by the voice / tone gains, and
 * the output clamp is the same hard limit the destination applies: the echo
 * reference is taken AFTER both, so it is exactly what is played, boost
 * (up to 150 %) and clipping included.
 *
 * The mic source can be swapped (device change, native capture) without the
 * consumers noticing: they hang off `cleanedBus`, which never changes. When the
 * AEC worklet cannot load, the mic goes straight to `cleanedBus` and the browser's
 * own echo cancellation is used instead (aec 'browser').
 */
import aecWorkletUrl from './aec/aecWorklet?worker&url';
import aecWasmUrl from '@ennuicastr/webrtcaec3.js/dist/webrtcaec3-0.3.0.wasm?url';
import type { AecWorkletOut } from './aec/aecWorklet';
import { emptyStats, mergeStats, type AecStats } from './aec/aecCore';
import { busGains, heraldVolumeStore } from '../tts/volume';

export type GraphAecState = 'idle' | 'loading' | 'ready' | 'failed';

/** How the current mic signal is cleaned of Herald's own voice. */
export type GraphAecMode = 'in-graph' | 'browser' | 'native' | 'none';

export interface StatsSample extends AecStats {
  /** Context time (s) the sample was taken. */
  at: number;
}

type Listener<T> = (v: T) => void;

const AEC_READY_TIMEOUT_MS = 4000;
/** localStorage override: 'off' disables in-graph AEC (debugging / comparisons). */
export const AEC_PREF_KEY = 'herald.aec';

export function inGraphAecAllowed(): boolean {
  try {
    return localStorage.getItem(AEC_PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

function audioCtor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

/**
 * The AEC3 WASM, fetched here and handed to the worklet: AudioWorkletGlobalScope
 * has no fetch, and the copy embedded in the glue cannot be decoded there
 * (its data URI prefix is not the one emscripten recognises).
 */
let wasmBytes: Promise<ArrayBuffer> | null = null;
function loadWasm(): Promise<ArrayBuffer> {
  if (!wasmBytes) {
    wasmBytes = fetch(aecWasmUrl).then((r) => {
      if (!r.ok) throw new Error(`AEC module HTTP ${r.status}`);
      return r.arrayBuffer();
    });
    wasmBytes.catch(() => {
      wasmBytes = null;
    });
  }
  return wasmBytes;
}

/** Identity in [-1, 1], clamped outside: the WaveShaper curve of the output clamp. */
export function clampCurve(): Float32Array<ArrayBuffer> {
  return new Float32Array([-1, 1]);
}

/** What a WaveShaper with `clampCurve()` does to one sample (the reference math). */
export function clampSample(x: number): number {
  return Math.max(-1, Math.min(1, x));
}

export class HeraldAudioGraph {
  private ctx: AudioContext | null = null;
  private _playbackBus: GainNode | null = null;
  private _voiceBus: GainNode | null = null;
  private _toneBus: GainNode | null = null;
  private _output: AudioNode | null = null;
  private gains = { voice: 1, tones: 1 };
  private _cleanedBus: GainNode | null = null;
  private _rawBus: GainNode | null = null;
  private keepAlive: GainNode | null = null;
  private cleanedDest: MediaStreamAudioDestinationNode | null = null;
  private aecNode: AudioWorkletNode | null = null;
  private aecLoading: Promise<boolean> | null = null;
  private _aecState: GraphAecState = 'idle';
  private micNode: AudioNode | null = null;
  private micThroughAec = false;
  private _micMode: GraphAecMode = 'none';
  private statsListeners = new Set<Listener<StatsSample>>();
  private stateListeners = new Set<() => void>();
  /** Web Speech (or anything outside this graph) is audible right now. */
  private unreferenced = 0;
  lastAecError: string | null = null;

  /** The shared context (created on first use; resumed by `resume()` in a gesture). */
  context(): AudioContext | null {
    if (this.ctx && this.ctx.state !== 'closed') return this.ctx;
    const Ctor = audioCtor();
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      return null;
    }
    this.buildBuses(this.ctx);
    return this.ctx;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 0;
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  async resume(timeoutMs = 400): Promise<boolean> {
    const ctx = this.context();
    if (!ctx) return false;
    if (ctx.state === 'running') return true;
    try {
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, timeoutMs))]);
    } catch {
      // fall through
    }
    return (ctx.state as string) === 'running';
  }

  /** Everything Herald plays ends up here (the echo reference is taken after it). */
  playbackBus(): GainNode | null {
    if (!this.context()) return null;
    return this._playbackBus;
  }

  /** Herald's voice connects here (Herald volume applied). */
  voiceBus(): GainNode | null {
    if (!this.context()) return null;
    return this._voiceBus;
  }

  /** Tones connect here (tones volume applied). */
  toneBus(): GainNode | null {
    if (!this.context()) return null;
    return this._toneBus;
  }

  /** The node the echo canceller's reference comes from: post-volume, post-clamp, exactly what plays. */
  referenceNode(): AudioNode | null {
    if (!this.context()) return null;
    return this._output;
  }

  /** Herald / tones volume as gains (see `busGains` in services/tts/volume.ts). */
  setVolume(voice: number, tones: number): void {
    this.gains = { voice, tones };
    if (this._voiceBus) this._voiceBus.gain.value = voice;
    if (this._toneBus) this._toneBus.gain.value = tones;
  }

  /** The mic, echo-cancelled when possible. Consumers connect from here. */
  cleanedBus(): GainNode | null {
    if (!this.context()) return null;
    return this._cleanedBus;
  }

  /** The mic before cancellation (echo measurement only). */
  rawBus(): GainNode | null {
    if (!this.context()) return null;
    return this._rawBus;
  }

  /** `cleanedBus` as a MediaStream (the VAD library takes a stream). */
  cleanedStream(): MediaStream | null {
    const ctx = this.context();
    if (!ctx || !this._cleanedBus) return null;
    if (!this.cleanedDest) {
      this.cleanedDest = ctx.createMediaStreamDestination();
      this.cleanedDest.channelCount = 1;
      this._cleanedBus.connect(this.cleanedDest);
    }
    return this.cleanedDest.stream;
  }

  get aecState(): GraphAecState {
    return this._aecState;
  }

  /** Echo stats flow for the current mic (it passes through the AEC worklet). */
  get measuring(): boolean {
    return this.micThroughAec && this._aecState === 'ready';
  }

  /** What cleans the mic signal right now. */
  get micMode(): GraphAecMode {
    return this._micMode;
  }

  get hasMic(): boolean {
    return this.micNode !== null;
  }

  /**
   * Load the echo canceller (worklet + WASM, from our own origin). Resolves
   * true once it is running. Safe to call repeatedly.
   */
  ensureAec(): Promise<boolean> {
    if (this._aecState === 'ready') return Promise.resolve(true);
    if (this.aecLoading) return this.aecLoading;
    if (!inGraphAecAllowed()) return Promise.resolve(false);
    const ctx = this.context();
    if (!ctx || typeof AudioWorkletNode === 'undefined' || !ctx.audioWorklet) {
      this.setAecState('failed', 'AudioWorklet unavailable');
      return Promise.resolve(false);
    }
    this.setAecState('loading');
    this.aecLoading = (async () => {
      try {
        // Worklet and WASM both come from our own origin (never a CDN).
        const [bytes] = await Promise.all([loadWasm(), ctx.audioWorklet.addModule(aecWorkletUrl)]);
        const node = new AudioWorkletNode(ctx, 'herald-aec', {
          numberOfInputs: 2,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
          processorOptions: { wasmBinary: bytes.slice(0), statsIntervalMs: 250 },
        });
        const ok = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), AEC_READY_TIMEOUT_MS);
          node.port.onmessage = (e: MessageEvent<AecWorkletOut>) => {
            const m = e.data;
            if (m.type === 'ready') {
              clearTimeout(timer);
              resolve(true);
            } else if (m.type === 'error') {
              this.lastAecError = m.message;
              clearTimeout(timer);
              resolve(false);
            }
          };
        });
        if (!ok) {
          node.port.postMessage({ type: 'dispose' });
          this.setAecState('failed', this.lastAecError ?? 'AEC did not start');
          return false;
        }
        node.port.onmessage = (e: MessageEvent<AecWorkletOut>) => this.onAecMessage(e.data);
        this._output!.connect(node, 0, 1);
        node.connect(this.keepAlive!);
        this.aecNode = node;
        this.setAecState('ready');
        return true;
      } catch (err) {
        this.setAecState('failed', String((err as Error)?.message ?? err));
        return false;
      } finally {
        this.aecLoading = null;
      }
    })();
    return this.aecLoading;
  }

  /**
   * Put a mic signal into the graph (replacing any previous one). `mode`:
   * 'in-graph' routes it through the AEC (the caller opened it WITHOUT browser
   * echo cancellation); anything else goes straight to `cleanedBus`.
   */
  attachMic(node: AudioNode, mode: GraphAecMode): void {
    this.detachMic();
    const cleaned = this._cleanedBus!;
    node.connect(this._rawBus!);
    if (this.aecNode) {
      // Always through the worklet: in-graph it cancels; otherwise it passes the
      // mic through (bypass) but still measures how much of Herald is left.
      this.aecNode.port.postMessage({ type: 'bypass', on: mode !== 'in-graph' });
      node.connect(this.aecNode, 0, 0);
      this.aecNode.connect(cleaned);
      this.micThroughAec = true;
    } else {
      node.connect(cleaned);
      this.micThroughAec = false;
    }
    this.micNode = node;
    this._micMode = mode === 'in-graph' && !this.aecNode ? 'none' : mode;
    this.emitState();
  }

  /** A MediaStream mic (getUserMedia). Returns the source node. */
  attachMicStream(stream: MediaStream, mode: GraphAecMode): MediaStreamAudioSourceNode | null {
    const ctx = this.context();
    if (!ctx) return null;
    const src = ctx.createMediaStreamSource(stream);
    this.attachMic(src, mode);
    return src;
  }

  detachMic(): void {
    if (!this.micNode) return;
    try {
      this.micNode.disconnect();
    } catch {
      // already
    }
    if (this.micThroughAec && this.aecNode && this._cleanedBus) {
      try {
        this.aecNode.disconnect(this._cleanedBus);
      } catch {
        // already
      }
    }
    this.micNode = null;
    this.micThroughAec = false;
    this._micMode = 'none';
    this.emitState();
  }

  /** The echo path changed (other speakers / mic): start the canceller afresh. */
  resetAec(): void {
    this.aecNode?.port.postMessage({ type: 'reset' });
  }

  /**
   * Something outside this graph is playing Herald's voice (Web Speech): there
   * is no reference for it, so nothing cancels it. Counted (nested begin/end).
   */
  setUnreferencedPlayback(on: boolean): void {
    this.unreferenced = Math.max(0, this.unreferenced + (on ? 1 : -1));
    this.emitState();
  }

  get unreferencedPlayback(): boolean {
    return this.unreferenced > 0;
  }

  onStats(cb: Listener<StatsSample>): () => void {
    this.statsListeners.add(cb);
    return () => this.statsListeners.delete(cb);
  }

  onStateChange(cb: () => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  /** Collect stats until the returned function is called; it returns the sum. */
  collectStats(filter?: (s: StatsSample) => boolean): () => AecStats {
    let acc = emptyStats();
    const off = this.onStats((s) => {
      if (!filter || filter(s)) acc = mergeStats(acc, s);
    });
    return () => {
      off();
      return acc;
    };
  }

  private buildBuses(ctx: AudioContext): void {
    this._playbackBus = ctx.createGain();
    // The same hard limit the destination applies, made explicit so the echo
    // reference (taken from here) clips exactly like the speakers do.
    let output: AudioNode = this._playbackBus;
    try {
      const clamp = ctx.createWaveShaper();
      clamp.curve = clampCurve();
      clamp.oversample = 'none';
      this._playbackBus.connect(clamp);
      output = clamp;
    } catch {
      // no WaveShaper: the destination clamps; the reference is unclamped (gain <= 1 is identical)
    }
    output.connect(ctx.destination);
    this._output = output;
    this._voiceBus = ctx.createGain();
    this._voiceBus.gain.value = this.gains.voice;
    this._voiceBus.connect(this._playbackBus);
    this._toneBus = ctx.createGain();
    this._toneBus.gain.value = this.gains.tones;
    this._toneBus.connect(this._playbackBus);
    this._cleanedBus = ctx.createGain();
    this._cleanedBus.channelCount = 1;
    this._cleanedBus.channelCountMode = 'explicit';
    this._rawBus = ctx.createGain();
    this._rawBus.channelCount = 1;
    this._rawBus.channelCountMode = 'explicit';
    // Keep the AEC node pulled every quantum even when nothing else consumes it.
    this.keepAlive = ctx.createGain();
    this.keepAlive.gain.value = 0;
    this.keepAlive.connect(ctx.destination);
    this.aecNode = null;
    this.cleanedDest = null;
    this._aecState = 'idle';
    this.micNode = null;
  }

  private onAecMessage(m: AecWorkletOut): void {
    if (m.type === 'stats') {
      const { type: _t, ...rest } = m;
      for (const l of [...this.statsListeners]) {
        try {
          l(rest);
        } catch {
          // listener errors are not ours
        }
      }
    } else if (m.type === 'error') {
      // A runtime trap: the worklet already fell back to pass-through.
      this.lastAecError = m.message;
      this._aecState = 'failed';
      if (this.micThroughAec && this._micMode === 'in-graph') this._micMode = 'none';
      this.emitState();
    }
  }

  private setAecState(s: GraphAecState, error?: string): void {
    this._aecState = s;
    if (error) {
      this.lastAecError = error;
      console.warn('Herald audio: in-app echo cancellation unavailable:', error);
    }
    this.emitState();
  }

  private emitState(): void {
    for (const l of [...this.stateListeners]) {
      try {
        l();
      } catch {
        // ignore
      }
    }
  }
}

let shared: HeraldAudioGraph | null = null;
export function getAudioGraph(): HeraldAudioGraph {
  if (!shared) {
    const graph = new HeraldAudioGraph();
    // Herald's volume (per device) follows the store.
    const apply = () => {
      const g = busGains(heraldVolumeStore.get());
      graph.setVolume(g.voice, g.tones);
    };
    apply();
    heraldVolumeStore.subscribe(apply);
    shared = graph;
  }
  return shared;
}
