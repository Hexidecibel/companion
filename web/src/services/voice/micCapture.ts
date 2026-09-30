/**
 * Microphone ownership for Herald voice input. One microphone at a time feeds
 * Herald's shared audio graph (audioGraph.ts), and everything that listens
 * (push-to-talk capture, the VAD, wake word, echo measurement) hangs off the
 * graph's cleaned bus, so a device switch never interrupts them.
 *
 * Echo cancellation, best first:
 * - 'in-graph': the mic is opened RAW (browser echo cancellation, noise
 *   suppression and AGC off: they would make the echo path non-linear) and the
 *   WebRTC AEC3 worklet removes Herald's playback, whose exact samples it has.
 * - 'native': the platform cancels (Android native capture with the
 *   VOICE_COMMUNICATION source, see nativeMic.ts).
 * - 'browser': getUserMedia's own echo cancellation (the AEC worklet failed or
 *   is turned off). Chrome's reference does not always include our WebAudio;
 *   WKWebView's never does.
 *
 * Microphone choice (audioDevices.ts `chooseInput`): the OS default, except that
 * a Bluetooth headset mic is replaced by another microphone when there is one
 * (setting "Use built-in mic with Bluetooth headphones", on by default), so
 * Bluetooth headphones stay in A2DP (music quality) instead of dropping to a
 * phone call. Labels exist only after permission: the very first open uses the
 * default and switches right after, once the devices can be seen.
 *
 * The mic is released after a short idle so the "mic in use" indicator does not
 * stay lit when nothing is listening.
 */
import captureWorkletUrl from './captureWorklet?worker&url';
import { voiceCopy } from './platformCopy';
import { getAudioGraph, type GraphAecMode, type HeraldAudioGraph } from './audioGraph';
import { chooseInput, classifyInputLabel, type DeviceLike, type InputChoice } from './audioDevices';
import type { InputKind } from './audioEnvironment';
import { RawRing, type RawAudio } from './rawTap';

/** Raw-tap frames: 32 ms (the VAD's frame), so positions track the VAD closely. */
const RAW_FRAME_SAMPLES = 512;

export type MicPermission = 'unknown' | 'granted' | 'denied' | 'unavailable';

export interface MicFrame {
  pcm: Int16Array;
  level: number;
}

const IDLE_RELEASE_MS = 20_000;
const PREFS_KEY = 'herald.micPrefs';

/** Browser-processed mic (the fallback when the in-graph canceller is unavailable). */
export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
  video: false,
};

/** getUserMedia constraints for a cancellation mode and device. */
export function micConstraints(mode: GraphAecMode, deviceId?: string): MediaStreamConstraints {
  const browser = mode !== 'in-graph';
  const audio: MediaTrackConstraints = {
    echoCancellation: browser,
    noiseSuppression: browser,
    autoGainControl: browser,
    channelCount: 1,
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return { audio, video: false };
}

export interface MicPrefs {
  /** Use the built-in (or any non-Bluetooth) mic when the default is a Bluetooth headset. */
  avoidBluetoothMic: boolean;
  /** A microphone picked by hand (deviceId), if any. */
  deviceId: string | null;
}

export const DEFAULT_MIC_PREFS: MicPrefs = { avoidBluetoothMic: true, deviceId: null };

export function loadMicPrefs(): MicPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_MIC_PREFS;
    const p = JSON.parse(raw) as Partial<MicPrefs>;
    return {
      avoidBluetoothMic: typeof p.avoidBluetoothMic === 'boolean' ? p.avoidBluetoothMic : true,
      deviceId: typeof p.deviceId === 'string' && p.deviceId ? p.deviceId : null,
    };
  } catch {
    return DEFAULT_MIC_PREFS;
  }
}

function saveMicPrefs(p: MicPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // storage unavailable
  }
}

/** Why voice input can't work on this page, or null if it can. */
export function micUnavailableReason(): string | null {
  if (typeof window === 'undefined') return 'No browser';
  if (!window.isSecureContext) return voiceCopy().micInsecure;
  if (!navigator.mediaDevices?.getUserMedia) return voiceCopy().micMissing;
  if (typeof AudioWorkletNode === 'undefined') return 'This browser lacks AudioWorklet.';
  return null;
}

export class MicError extends Error {
  constructor(message: string, readonly permission: MicPermission) {
    super(message);
    this.name = 'MicError';
  }
}

/** A microphone source other than getUserMedia (Android native capture). */
export interface ExternalMicSource {
  /** Open it and return its node in the graph's context, and what cancels echo. */
  open(ctx: AudioContext, opts: { avoidBluetooth: boolean; mode?: GraphAecMode }): Promise<{ node: AudioNode; mode: GraphAecMode; label: string; kind: InputKind }>;
  close(): void;
  /** The source stopped on its own (route change, error). */
  onEnded?: (cb: () => void) => void;
}

export type MicEvent =
  | { type: 'opened'; label: string; kind: InputKind; mode: GraphAecMode; choice: InputChoice | null }
  | { type: 'switched'; label: string; kind: InputKind; reason: 'device-change' | 'avoid-bluetooth' | 'lost' | 'prefs' | 'mode' }
  | { type: 'lost'; label: string }
  | { type: 'only-bluetooth'; label: string }
  | { type: 'released' };

type OpenState = {
  stream: MediaStream | null;
  node: AudioNode;
  mode: GraphAecMode;
  label: string;
  kind: InputKind;
  /** The device actually capturing (track settings), for display. */
  deviceId: string | null;
  /** What we asked for: a deviceId, or null = the OS default. */
  pinnedId: string | null;
  choice: InputChoice | null;
};

export class MicCapture {
  private opened: OpenState | null = null;
  private opening: Promise<OpenState> | null = null;
  private workletCtx: AudioContext | null = null;
  private workletReady: Promise<void> | null = null;
  private node: AudioWorkletNode | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private users = 0;
  private listeners = new Set<(e: MicEvent) => void>();
  private prefs: MicPrefs = loadMicPrefs();
  private external: ExternalMicSource | null = null;
  private forcedMode: GraphAecMode | null = null;
  private warnedOnlyBluetooth = false;
  private rawNode: AudioWorkletNode | null = null;
  private rawRing: RawRing | null = null;
  private rawStarting: Promise<void> | null = null;
  permission: MicPermission = 'unknown';

  constructor(private graph: HeraldAudioGraph = getAudioGraph()) {}

  // ---- configuration --------------------------------------------------------

  get micPrefs(): MicPrefs {
    return this.prefs;
  }

  /** Change mic prefs; an open mic is re-opened when the choice changes. */
  setMicPrefs(p: Partial<MicPrefs>): void {
    const before = this.prefs;
    this.prefs = { ...this.prefs, ...p };
    saveMicPrefs(this.prefs);
    if (!this.opened) return;
    if (this.opened.stream) void this.reevaluate('prefs');
    // Native capture decides the device itself: restart it with the new preference.
    else if (before.avoidBluetoothMic !== this.prefs.avoidBluetoothMic) void this.reopen('prefs');
  }

  /** Use a native microphone source instead of getUserMedia (Android app). */
  setExternalSource(src: ExternalMicSource | null): void {
    this.external = src;
  }

  /**
   * Force a cancellation mode (echo calibration compares modes); null = auto.
   * Re-opens an open mic.
   */
  async setForcedMode(mode: GraphAecMode | null): Promise<void> {
    if (this.forcedMode === mode) return;
    this.forcedMode = mode;
    if (this.opened) await this.reopen('mode');
  }

  get forced(): GraphAecMode | null {
    return this.forcedMode;
  }

  on(cb: (e: MicEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ---- state ----------------------------------------------------------------

  get isOpen(): boolean {
    return this.opened !== null;
  }

  get mode(): GraphAecMode {
    return this.opened?.mode ?? 'none';
  }

  get label(): string | null {
    return this.opened?.label ?? null;
  }

  get kind(): InputKind {
    return this.opened?.kind ?? 'unknown';
  }

  get deviceId(): string | null {
    return this.opened?.deviceId ?? null;
  }

  get choice(): InputChoice | null {
    return this.opened?.choice ?? null;
  }

  /** The raw getUserMedia stream (null for native capture). */
  get stream_(): MediaStream | null {
    return this.opened?.stream ?? null;
  }

  // ---- open / close -----------------------------------------------------------

  /** Open (or reuse) the microphone. Throws MicError. Returns the raw stream when there is one. */
  async acquire(): Promise<MediaStream> {
    await this.ensureOpen();
    return this.opened?.stream ?? this.graph.cleanedStream() ?? new MediaStream();
  }

  /** The cleaned (echo-cancelled) mic as a stream, opening the mic if needed. */
  async acquireCleaned(): Promise<MediaStream> {
    await this.ensureOpen();
    const s = this.graph.cleanedStream();
    if (!s) throw new MicError('Could not open the microphone.', 'unavailable');
    return s;
  }

  /** The graph context the cleaned signal lives in (VAD shares it). */
  context(): AudioContext | null {
    return this.graph.context();
  }

  private async ensureOpen(): Promise<OpenState> {
    this.cancelIdle();
    if (this.opened && this.isLive(this.opened)) return this.opened;
    if (this.opening) return this.opening;
    const reason = this.external ? null : micUnavailableReason();
    if (reason) {
      this.permission = 'unavailable';
      throw new MicError(reason, 'unavailable');
    }
    this.opening = this.open(null)
      .then((st) => {
        this.install(st);
        this.emit({ type: 'opened', label: st.label, kind: st.kind, mode: st.mode, choice: st.choice });
        // First open without labels: now that they are visible, check the choice
        // (after `opening` clears, or the check would see an open in progress).
        if (!st.choice || st.choice.reason === 'no-labels') setTimeout(() => void this.reevaluate('avoid-bluetooth'), 0);
        return st;
      })
      .finally(() => {
        this.opening = null;
      });
    return this.opening;
  }

  private isLive(st: OpenState): boolean {
    if (!st.stream) return true;
    return st.stream.getAudioTracks().some((t) => t.readyState === 'live');
  }

  private async wantedMode(): Promise<GraphAecMode> {
    if (this.forcedMode === 'browser' || this.forcedMode === 'none') return this.forcedMode;
    // Load the canceller before opening the mic: the constraints depend on it.
    const ok = await this.graph.ensureAec();
    return ok ? 'in-graph' : 'browser';
  }

  private async enumerate(): Promise<DeviceLike[]> {
    try {
      return (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
    } catch {
      return [];
    }
  }

  /** Open a microphone (not yet installed). `prevChoice` is kept when labels are missing. */
  private async open(prevChoice: InputChoice | null): Promise<OpenState> {
    const ctx = this.graph.context();
    if (!ctx) throw new MicError('This browser cannot process audio.', 'unavailable');
    if (this.external) {
      try {
        // The in-graph canceller has to be there before the native mic joins the graph.
        const aecOk = this.forcedMode === 'native' ? false : await this.graph.ensureAec();
        const r = await this.external.open(ctx, { avoidBluetooth: this.prefs.avoidBluetoothMic, mode: this.forcedMode ?? undefined });
        this.permission = 'granted';
        this.external.onEnded?.(() => void this.onLost());
        const mode: GraphAecMode = r.mode === 'in-graph' && !aecOk ? 'none' : r.mode;
        return { stream: null, node: r.node, mode, label: r.label, kind: r.kind, deviceId: null, pinnedId: null, choice: null };
      } catch (err) {
        const name = (err as { name?: string; message?: string })?.name;
        if (name === 'NotAllowedError') {
          this.permission = 'denied';
          throw new MicError(voiceCopy().micDenied, 'denied');
        }
        // Native capture failed: fall through to the WebView's getUserMedia.
        console.warn('Herald audio: native capture unavailable, using the WebView mic:', err);
        this.external = null;
      }
    }
    const mode = await this.wantedMode();
    const devices = await this.enumerate();
    const choice = devices.length ? chooseInput(devices, { avoidBluetooth: this.prefs.avoidBluetoothMic, userDeviceId: this.prefs.deviceId }) : prevChoice;
    let stream: MediaStream;
    let pinnedId = choice?.deviceId ?? null;
    try {
      stream = await this.getUserMedia(mode, pinnedId ?? undefined);
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (pinnedId && (name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'NotReadableError')) {
        // The picked device vanished between enumerate and open: use the default.
        pinnedId = null;
        stream = await this.getUserMedia(mode, undefined);
      } else {
        throw err;
      }
    }
    const track = stream.getAudioTracks()[0];
    const label = track?.label ?? '';
    const settingsId = (track?.getSettings?.().deviceId as string | undefined) ?? choice?.deviceId ?? null;
    const node = ctx.createMediaStreamSource(stream);
    return { stream, node, mode, label, kind: classifyInputLabel(label), deviceId: settingsId, pinnedId, choice };
  }

  private async getUserMedia(mode: GraphAecMode, deviceId?: string): Promise<MediaStream> {
    try {
      const s = await navigator.mediaDevices.getUserMedia(micConstraints(mode, deviceId));
      this.permission = 'granted';
      return s;
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        this.permission = 'denied';
        throw new MicError(voiceCopy().micDenied, 'denied');
      }
      if ((name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'NotReadableError') && deviceId) throw err;
      if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        this.permission = 'unavailable';
        throw new MicError('No microphone found.', 'unavailable');
      }
      throw new MicError('Could not open the microphone.', 'unavailable');
    }
  }

  private install(st: OpenState): void {
    const prev = this.opened;
    this.graph.attachMic(st.node, st.mode);
    this.opened = st;
    const track = st.stream?.getAudioTracks()[0];
    if (track) track.addEventListener('ended', () => {
      if (this.opened === st) void this.onLost();
    });
    if (prev && prev !== st) this.closeState(prev);
  }

  /** `final`: the mic is going away (a native source is closed; on a swap it restarts itself). */
  private closeState(st: OpenState, final = false): void {
    st.stream?.getTracks().forEach((t) => t.stop());
    if (!st.stream && final) this.external?.close();
    // A native source may hand back the same node when it restarts.
    if (!final && this.opened?.node === st.node) return;
    try {
      st.node.disconnect();
    } catch {
      // already
    }
  }

  /**
   * Devices changed (or prefs): open the right mic if it is not the one in use.
   * A capture in progress keeps going: consumers hang off the graph, so the
   * utterance simply continues on the new microphone.
   */
  async reevaluate(reason: 'device-change' | 'avoid-bluetooth' | 'prefs'): Promise<void> {
    const cur = this.opened;
    if (!cur || !cur.stream || this.opening) return;
    const devices = await this.enumerate();
    if (!devices.length) return;
    const choice = chooseInput(devices, { avoidBluetooth: this.prefs.avoidBluetoothMic, userDeviceId: this.prefs.deviceId });
    if (choice.onlyBluetooth && !this.warnedOnlyBluetooth) {
      this.warnedOnlyBluetooth = true;
      this.emit({ type: 'only-bluetooth', label: choice.label ?? cur.label });
    }
    const wantId = choice.deviceId ?? null;
    // Following the default: re-open only when the default moved to another device.
    const defaultMoved = !wantId && !cur.pinnedId && !!choice.label && !!cur.label && !sameDevice(choice.label, cur.label);
    // A default-following stream may silently move with the OS default (Chrome):
    // compare with what we asked for, never with where it happens to be.
    const pinnedChanged = !!wantId && wantId !== cur.pinnedId;
    const unpinned = !wantId && !!cur.pinnedId;
    if (!pinnedChanged && !defaultMoved && !unpinned) {
      cur.choice = choice;
      return;
    }
    await this.reopen(reason === 'device-change' ? 'device-change' : reason === 'prefs' ? 'prefs' : 'avoid-bluetooth', choice);
  }

  /** Re-open the mic now (same prefs; a new choice / mode). */
  async reopen(reason: 'device-change' | 'avoid-bluetooth' | 'lost' | 'prefs' | 'mode', choice?: InputChoice): Promise<void> {
    if (this.opening) {
      await this.opening.catch(() => {});
    }
    const cur = this.opened;
    try {
      this.opening = this.open(choice ?? cur?.choice ?? null);
      const st = await this.opening;
      this.install(st);
      if (cur?.mode !== st.mode) this.graph.resetAec();
      this.emit({ type: 'switched', label: st.label, kind: st.kind, reason });
    } catch (err) {
      console.warn('Herald audio: could not switch microphone:', err);
      if (reason === 'lost') {
        this.release();
      }
    } finally {
      this.opening = null;
    }
  }

  private async onLost(): Promise<void> {
    const cur = this.opened;
    if (!cur) return;
    this.emit({ type: 'lost', label: cur.label });
    if (this.users > 0 || this.node) await this.reopen('lost', undefined);
    else this.release();
  }

  // ---- users / capture -----------------------------------------------------

  /** Register a long-lived user (VAD) so the mic is not idle-released. */
  retain(): void {
    this.users++;
    this.cancelIdle();
  }

  releaseUser(): void {
    this.users = Math.max(0, this.users - 1);
    if (this.users === 0) this.stopRawTap();
    this.scheduleIdle();
  }

  /**
   * The mic before echo cancellation (16 kHz ring), while the in-graph
   * canceller is on and someone listens (the VAD). Null otherwise: then the
   * cleaned signal is the only one (and is the same as the raw one).
   */
  rawAudio(): RawAudio | null {
    if (this.mode !== 'in-graph') return null;
    if (!this.rawRing && !this.rawStarting) this.rawStarting = this.startRawTap().finally(() => { this.rawStarting = null; });
    return this.rawRing;
  }

  private async startRawTap(): Promise<void> {
    const ctx = this.graph.context();
    const raw = this.graph.rawBus();
    if (!ctx || !raw) return;
    if (this.workletCtx !== ctx) {
      this.workletCtx = ctx;
      this.workletReady = ctx.audioWorklet.addModule(captureWorkletUrl);
    }
    await this.workletReady;
    if (this.users === 0 || this.rawNode) return;
    const ring = new RawRing();
    const node = new AudioWorkletNode(ctx, 'herald-capture', { numberOfInputs: 1, numberOfOutputs: 0, processorOptions: { frameSamples: RAW_FRAME_SAMPLES } });
    node.port.onmessage = (e: MessageEvent<MicFrame>) => {
      if (this.rawNode === node) ring.pushInt16(e.data.pcm);
    };
    raw.connect(node);
    this.rawNode = node;
    this.rawRing = ring;
  }

  private stopRawTap(): void {
    const node = this.rawNode;
    this.rawNode = null;
    this.rawRing = null;
    if (!node) return;
    try {
      this.graph.rawBus()?.disconnect(node);
    } catch {
      // already
    }
    node.port.onmessage = null;
  }

  /** Start streaming 16 kHz PCM16 frames (echo-cancelled) to `onFrame` until stop(). */
  async start(onFrame: (f: MicFrame) => void): Promise<void> {
    await this.ensureOpen();
    const ctx = this.graph.context()!;
    if (this.workletCtx !== ctx) {
      this.workletCtx = ctx;
      this.workletReady = ctx.audioWorklet.addModule(captureWorkletUrl);
    }
    await this.workletReady;
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    this.stopNode();
    const node = new AudioWorkletNode(ctx, 'herald-capture', { numberOfInputs: 1, numberOfOutputs: 0 });
    node.port.onmessage = (e: MessageEvent<MicFrame>) => {
      if (this.node === node) onFrame(e.data);
    };
    this.graph.cleanedBus()!.connect(node);
    this.node = node;
  }

  /** Stop frames (the worklet flushes its last partial frame first). */
  stop(): void {
    const node = this.node;
    if (node) {
      node.port.postMessage('stop');
      // Let the flushed partial frame arrive, then detach.
      setTimeout(() => {
        if (this.node === node) this.stopNode();
      }, 30);
    }
    this.scheduleIdle();
  }

  /** Close the microphone now (the shared graph stays: Herald still talks through it). */
  release(): void {
    this.cancelIdle();
    this.stopNode();
    this.stopRawTap();
    const st = this.opened;
    this.opened = null;
    if (st) {
      this.graph.detachMic();
      this.closeState(st, true);
      this.emit({ type: 'released' });
    }
  }

  private stopNode(): void {
    const node = this.node;
    if (!node) return;
    try {
      this.graph.cleanedBus()?.disconnect(node);
    } catch {
      // already disconnected
    }
    try {
      node.disconnect();
    } catch {
      // already
    }
    node.port.onmessage = null;
    this.node = null;
  }

  private cancelIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdle(): void {
    this.cancelIdle();
    if (this.users > 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.users === 0 && !this.node) this.release();
    }, IDLE_RELEASE_MS);
  }

  private emit(e: MicEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        // ignore
      }
    }
  }
}

/** Two labels name the same device (Chrome prefixes the default with "Default - "). */
export function sameDevice(a: string, b: string): boolean {
  const n = (s: string) => s.replace(/^(default|communications)\s*-\s*/i, '').trim().toLowerCase();
  return n(a) === n(b);
}

let shared: MicCapture | null = null;
export function getMicCapture(): MicCapture {
  if (!shared) shared = new MicCapture();
  return shared;
}
