/**
 * Native audio glue for the Tauri apps (tauri-plugin-herald-native):
 *
 * - Route info for every native app: iOS AVAudioSession / Android AudioManager
 *   (route changes arrive as `audioRoute` plugin events), macOS / Linux from the
 *   system (the desktop app re-reads it on devicechange). Feeds
 *   audioEnvironment's output / input detection (WKWebView lists no outputs).
 * - Android: the microphone is captured natively (built-in mic, VOICE_RECOGNITION
 *   source) and fed into Herald's graph through the `herald-pcm-source` worklet.
 *   The WebView's own getUserMedia would switch the phone to communication mode,
 *   which with Bluetooth earbuds means SCO: the earbuds drop to call quality for
 *   as long as Herald listens. Echo is cancelled in the graph (in-graph AEC).
 * - iOS: "Use built-in mic with Bluetooth headphones" -> the audio session keeps
 *   A2DP output and prefers the built-in mic (no HFP).
 *
 * Browsers: nothing here runs.
 */
import pcmSourceUrl from './pcmSourceWorklet?worker&url';
import { nativePlatform, type NativePlatform } from '../../utils/platform';
import { setNativeRouteSource, type NativeRouteSource } from './audioEnvironment';
import { classifyInputPort, type NativeAudioRoute, type PortType } from './audioDevices';
import { getMicCapture, type ExternalMicSource } from './micCapture';
import type { GraphAecMode } from './audioGraph';

const PLUGIN = 'herald-native';

type CoreApi = typeof import('@tauri-apps/api/core');
let core: Promise<CoreApi> | null = null;
function api(): Promise<CoreApi> {
  if (!core) core = import('@tauri-apps/api/core');
  return core;
}

export function base64ToInt16(b64: string): Int16Array {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    out[i] = v >= 0x8000 ? v - 0x10000 : v;
  }
  return out;
}

function routeSource(platform: NativePlatform): NativeRouteSource {
  return {
    async get() {
      try {
        const { invoke } = await api();
        const r = await invoke<NativeAudioRoute | null>(`plugin:${PLUGIN}|get_audio_route`);
        return r && Array.isArray(r.outputs) ? r : null;
      } catch {
        return null;
      }
    },
    onChange(cb) {
      // Desktop: audioEnvironment already re-reads on the WebView's devicechange.
      if (platform !== 'android' && platform !== 'ios') return () => {};
      let unlisten: (() => void) | null = null;
      let dead = false;
      void api()
        .then(({ addPluginListener }) => addPluginListener(PLUGIN, 'audioRoute', () => cb()))
        .then((l) => {
          if (dead) void l.unregister();
          else unlisten = () => void l.unregister();
        })
        .catch(() => {});
      return () => {
        dead = true;
        unlisten?.();
      };
    },
  };
}

interface CaptureStart {
  sampleRate: number;
  aec: boolean;
  device: string;
  deviceType: PortType;
}

/** Android: the native microphone as a graph source (see file comment). */
export class AndroidNativeMic implements ExternalMicSource {
  private node: AudioWorkletNode | null = null;
  private moduleCtx: AudioContext | null = null;
  private moduleReady: Promise<void> | null = null;
  private endedCbs = new Set<() => void>();
  private gen = 0;

  constructor(private opts: { nativeAec: () => boolean } = { nativeAec: () => false }) {}

  async open(ctx: AudioContext, o: { avoidBluetooth: boolean; mode?: GraphAecMode }): Promise<{ node: AudioNode; mode: GraphAecMode; label: string; kind: ReturnType<typeof classifyInputPort> }> {
    const { invoke, Channel } = await api();
    if (this.moduleCtx !== ctx) {
      this.moduleCtx = ctx;
      this.moduleReady = ctx.audioWorklet.addModule(pcmSourceUrl);
    }
    await this.moduleReady;
    const gen = ++this.gen;
    if (!this.node || this.node.context !== ctx) {
      this.node = new AudioWorkletNode(ctx, 'herald-pcm-source', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { inRate: 16000 },
      });
    }
    const node = this.node;
    const channel = new Channel<{ pcm?: string; ended?: boolean; error?: string }>();
    channel.onmessage = (m) => {
      if (gen !== this.gen) return;
      if (m.ended) {
        for (const cb of [...this.endedCbs]) cb();
        return;
      }
      if (m.pcm) {
        const pcm = base64ToInt16(m.pcm);
        node.port.postMessage(pcm, [pcm.buffer]);
      }
    };
    const nativeAec = o.mode === 'native' || (o.mode == null && this.opts.nativeAec());
    let res: CaptureStart;
    try {
      res = await invoke<CaptureStart>(`plugin:${PLUGIN}|start_capture`, { aec: nativeAec, avoidBluetooth: o.avoidBluetooth, onAudio: channel });
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (/permission/i.test(msg)) throw Object.assign(new Error(msg), { name: 'NotAllowedError' });
      throw err;
    }
    const mode: GraphAecMode = res.aec ? 'native' : 'in-graph';
    return { node, mode, label: res.device || 'Phone microphone', kind: classifyInputPort({ type: res.deviceType ?? 'builtin-mic', name: res.device }) };
  }

  close(): void {
    this.gen++;
    void api().then(({ invoke }) => invoke(`plugin:${PLUGIN}|stop_capture`)).catch(() => {});
  }

  onEnded(cb: () => void): void {
    this.endedCbs.clear();
    this.endedCbs.add(cb);
  }
}

let started = false;

/** Wire native route info (and Android native capture) once, in the native apps only. */
export function initNativeAudio(): void {
  if (started) return;
  started = true;
  const platform = nativePlatform();
  if (platform === 'browser') return;
  setNativeRouteSource(routeSource(platform));
  if (platform === 'android') {
    let nativeAec = false;
    try {
      // Experiment switch: the platform echo canceller instead of the in-graph one.
      nativeAec = localStorage.getItem('herald.androidNativeAec') === '1';
    } catch {
      // storage unavailable
    }
    getMicCapture().setExternalSource(new AndroidNativeMic({ nativeAec: () => nativeAec }));
  }
}

/** iOS: prefer the built-in mic (keeps Bluetooth headphones in A2DP). No-op elsewhere. */
export async function setPreferBuiltInMic(on: boolean): Promise<void> {
  if (nativePlatform() !== 'ios') return;
  try {
    const { invoke } = await api();
    await invoke(`plugin:${PLUGIN}|set_prefer_builtin_mic`, { on });
  } catch (err) {
    console.warn('[herald-native] set_prefer_builtin_mic failed', err);
  }
}
