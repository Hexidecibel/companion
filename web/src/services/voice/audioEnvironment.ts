/**
 * Audio environment: what Herald is playing through, what it is listening
 * with, and how (or whether) its own voice is removed from what it hears.
 *
 * Contract (consumed by setup profiles, the device check, the overlay):
 * `getAudioEnvironment`, `onAudioEnvironmentChange`, `measureEchoSuppression`.
 * The rest of the exports are for the voice layer.
 *
 * Sources, strongest first:
 * 1. Measured echo (`measureEchoSuppression`, or passively during Herald's own
 *    replies): ground truth. "No echo reaches the mic" means headphones, whatever
 *    the labels say.
 * 2. Native route info (iOS AVAudioSession, Android AudioManager, macOS / Linux
 *    from the desktop app): the real output port, Bluetooth profile included.
 * 3. Device labels (enumerateDevices; only after mic permission; WebKit lists
 *    no outputs at all).
 *
 * Changes (devicechange, native route change, mic switched, canceller state)
 * re-detect, re-open the mic on the right device, reset the canceller when the
 * echo path changed, and notify `onAudioEnvironmentChange` subscribers.
 */
import { getAudioGraph, inGraphAecAllowed, type GraphAecMode } from './audioGraph';
import { getMicCapture, type MicEvent } from './micCapture';
import { chooseInput, classifyInputLabel, classifyInputPort, classifyOutput, cleanLabel, type DeviceLike, type NativeAudioRoute } from './audioDevices';
import { echoFigures, type AecStats } from './aec/aecCore';
import { noEchoPath, selectBargeInMode, type BargeInDecision, type BargeInEvidence } from './bargeInMode';
import { synthSpeech } from './aec/probeSignal';
import { VadListener, VAD_PRESETS, type VadEvents } from './vadListener';

export type OutputKind = 'headphones' | 'bluetooth-headphones' | 'speakers' | 'unknown';
export type InputKind = 'headset' | 'bluetooth-headset' | 'builtin' | 'external' | 'unknown';
export type AecMode = 'native' | 'in-graph' | 'browser' | 'none';

export interface AudioEnvironment {
  output: OutputKind;
  input: InputKind;
  aec: AecMode;
  inputDeviceId?: string;
  outputLabel?: string;
  inputLabel?: string;
}

/** Full result of an echo check (the contract returns the first two fields). */
export interface EchoMeasurement {
  /**
   * How far below Herald's own playback its echo is in what Herald listens to
   * (dB): acoustic loss plus cancellation. >= 25 with no residual speech: talking
   * over Herald can be detected instantly. Very large: no echo reaches the mic.
   */
  erleDb: number;
  /** The VAD heard speech in the cleaned mic while only Herald was talking. */
  residualSpeechDetected: boolean;
  /** Playback -> raw mic (acoustic loss alone). */
  erlDb: number;
  /** What the canceller itself removed (raw -> cleaned). */
  cancelDb: number;
  aec: AecMode;
  at: number;
  envKey: string;
}

type Listener<T> = (v: T) => void;

// ---- external inputs ------------------------------------------------------------

export interface NativeRouteSource {
  get(): Promise<NativeAudioRoute | null>;
  onChange(cb: () => void): () => void;
}

let routeSource: NativeRouteSource | null = null;
let routeOff: (() => void) | null = null;
let route: NativeAudioRoute | null = null;

/** The native app registers its route info (nativeAudio.ts). */
export function setNativeRouteSource(src: NativeRouteSource | null): void {
  routeOff?.();
  routeOff = null;
  routeSource = src;
  route = null;
  if (src && started) routeOff = src.onChange(() => scheduleRefresh('route'));
  if (started) scheduleRefresh('route');
}

export type ProbeAudio = { pcm: Float32Array; sampleRate: number };
let probeSource: (() => Promise<ProbeAudio | null>) | null = null;

/** The TTS layer registers a source for the echo-check line in Herald's own voice. */
export function setEchoProbeSource(fn: (() => Promise<ProbeAudio | null>) | null): void {
  probeSource = fn;
}

/**
 * Herald's voice is currently Web Speech (a browser voice was picked, or the
 * neural voice service is down): it plays outside the graph, with no reference
 * for the canceller.
 */
let browserVoice = false;
export function setBrowserVoice(on: boolean): void {
  if (browserVoice === on) return;
  browserVoice = on;
  if (started) scheduleRefresh('voice');
}

// ---- state ------------------------------------------------------------------------

const listeners = new Set<Listener<AudioEnvironment>>();
const modeListeners = new Set<Listener<BargeInDecision>>();
const noticeListeners = new Set<Listener<AudioNotice>>();
let env: AudioEnvironment = { output: 'unknown', input: 'unknown', aec: 'browser' };
let envKey = '';
let lastDecision: BargeInDecision = { mode: 'gated', reason: 'echo not measured yet' };
let started = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshing: Promise<AudioEnvironment> | null = null;
let lastOutputSig = '';

export type AudioNotice =
  | { kind: 'mic-switched'; label: string; reason: string }
  | { kind: 'mic-lost'; label: string }
  | { kind: 'only-bluetooth-mic'; label: string }
  | { kind: 'output-changed'; label: string };

interface Evidence {
  measured: EchoMeasurement | null;
  /** Suppression (dB) per stats window (~250 ms) with Herald playing, newest last. */
  passive: number[];
  echoHeard: number;
  falseBargeIns: number;
}

const MEASURE_KEY = 'herald.echoMeasurements';
const evidence = new Map<string, Evidence>();

function loadMeasurements(): Record<string, EchoMeasurement> {
  try {
    const raw = localStorage.getItem(MEASURE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, EchoMeasurement>) : {};
  } catch {
    return {};
  }
}

function saveMeasurement(m: EchoMeasurement): void {
  try {
    const all = loadMeasurements();
    all[m.envKey] = m;
    // Keep the 12 most recent setups.
    const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at).slice(0, 12);
    const kept: Record<string, EchoMeasurement> = {};
    for (const k of keys) kept[k] = all[k];
    localStorage.setItem(MEASURE_KEY, JSON.stringify(kept));
  } catch {
    // storage unavailable
  }
}

/** Measurements older than this are not trusted (volume, room and devices move). */
const MEASUREMENT_TTL_MS = 30 * 24 * 3600 * 1000;

function evidenceFor(key: string): Evidence {
  let e = evidence.get(key);
  if (!e) {
    const saved = loadMeasurements()[key];
    e = {
      measured: saved && Date.now() - saved.at < MEASUREMENT_TTL_MS ? saved : null,
      passive: [],
      echoHeard: 0,
      falseBargeIns: 0,
    };
    evidence.set(key, e);
  }
  return e;
}

/** One setup = output + input + canceller. Evidence is kept per setup. */
export function environmentKey(e: AudioEnvironment): string {
  return [e.output, e.outputLabel ?? '', e.input, e.inputLabel ?? '', e.aec].join('|').toLowerCase();
}

// ---- detection -----------------------------------------------------------------------

async function enumerate(): Promise<DeviceLike[]> {
  try {
    return (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
  } catch {
    return [];
  }
}

function aecFromGraph(mode: GraphAecMode): AecMode {
  return mode;
}

/** Pure: the environment from what can be seen. Exported for tests. */
export function computeEnvironment(i: {
  devices: DeviceLike[];
  route: NativeAudioRoute | null;
  mic: { open: boolean; label: string | null; deviceId: string | null; mode: GraphAecMode; kind: InputKind };
  predictedAec: AecMode;
  avoidBluetooth: boolean;
  measured: EchoMeasurement | null;
}): AudioEnvironment {
  const out = classifyOutput(i.devices, i.route);
  let output = out.kind;
  let input: InputKind;
  let inputLabel: string | undefined;
  let inputDeviceId: string | undefined;
  if (i.mic.open && i.mic.label) {
    input = i.mic.kind !== 'unknown' ? i.mic.kind : classifyInputLabel(i.mic.label);
    // Same setup, same key: Chrome's track label may carry "Default - ".
    inputLabel = cleanLabel(i.mic.label);
    inputDeviceId = i.mic.deviceId ?? undefined;
  } else if (i.route?.inputs[0]) {
    input = classifyInputPort(i.route.inputs[0]);
    inputLabel = i.route.inputs[0].name;
  } else {
    const c = chooseInput(i.devices, { avoidBluetooth: i.avoidBluetooth });
    input = c.kind;
    inputLabel = c.label ? cleanLabel(c.label) : undefined;
    inputDeviceId = c.deviceId ?? (i.mic.open ? i.mic.deviceId ?? undefined : undefined);
  }
  // Ground truth: nothing of Herald reaches the mic -> it is on headphones.
  if (output === 'unknown' && noEchoPath(i.measured)) output = 'headphones';
  const aec = i.mic.open ? aecFromGraph(i.mic.mode) : i.predictedAec;
  const envOut: AudioEnvironment = { output, input, aec };
  if (inputDeviceId) envOut.inputDeviceId = inputDeviceId;
  if (out.label) envOut.outputLabel = out.label;
  if (inputLabel) envOut.inputLabel = inputLabel;
  return envOut;
}

function predictedAec(): AecMode {
  const mic = getMicCapture();
  const forced = mic.forced;
  if (forced) return forced;
  const graph = getAudioGraph();
  if (!inGraphAecAllowed() || graph.aecState === 'failed') return 'browser';
  if (typeof AudioWorkletNode === 'undefined') return 'browser';
  return 'in-graph';
}

function sameEnv(a: AudioEnvironment, b: AudioEnvironment): boolean {
  return a.output === b.output && a.input === b.input && a.aec === b.aec && a.inputDeviceId === b.inputDeviceId && a.outputLabel === b.outputLabel && a.inputLabel === b.inputLabel;
}

async function refresh(reason: string): Promise<AudioEnvironment> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const mic = getMicCapture();
    if (reason === 'devicechange' && mic.isOpen) await mic.reevaluate('device-change').catch(() => {});
    const [devices, r] = await Promise.all([enumerate(), routeSource ? routeSource.get().catch(() => null) : Promise.resolve(null)]);
    route = r;
    const draft = computeEnvironment({
      devices,
      route,
      mic: { open: mic.isOpen, label: mic.label, deviceId: mic.deviceId, mode: mic.mode, kind: mic.kind },
      predictedAec: predictedAec(),
      avoidBluetooth: mic.micPrefs.avoidBluetoothMic,
      measured: null,
    });
    const key = environmentKey(draft);
    const next = computeEnvironment({
      devices,
      route,
      mic: { open: mic.isOpen, label: mic.label, deviceId: mic.deviceId, mode: mic.mode, kind: mic.kind },
      predictedAec: predictedAec(),
      avoidBluetooth: mic.micPrefs.avoidBluetoothMic,
      measured: evidenceFor(key).measured,
    });
    // The output moved (speakers <-> headphones): the old echo path is gone.
    const outSig = `${draft.output}|${draft.outputLabel ?? ''}`;
    if (lastOutputSig && outSig !== lastOutputSig) {
      getAudioGraph().resetAec();
      notice({ kind: 'output-changed', label: draft.outputLabel ?? draft.output });
    }
    lastOutputSig = outSig;
    envKey = key;
    const changed = !sameEnv(env, next);
    env = next;
    if (changed) {
      for (const l of [...listeners]) {
        try {
          l(env);
        } catch {
          // ignore
        }
      }
    }
    recomputeMode();
    return env;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

function scheduleRefresh(reason: string): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  // devicechange fires in bursts (a headset is two or three devices).
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refresh(reason);
  }, reason === 'devicechange' ? 400 : 50);
}

function onMicEvent(e: MicEvent): void {
  if (e.type === 'switched') notice({ kind: 'mic-switched', label: e.label, reason: e.reason });
  else if (e.type === 'lost') notice({ kind: 'mic-lost', label: e.label });
  else if (e.type === 'only-bluetooth') notice({ kind: 'only-bluetooth-mic', label: e.label });
  scheduleRefresh('mic');
}

function onStats(s: AecStats): void {
  const mic = getMicCapture();
  const graph = getAudioGraph();
  // Only a cancelled mic and referenced playback say anything about the canceller.
  if (!mic.isOpen || !graph.measuring || graph.unreferencedPlayback || !envKey) return;
  // Windows mostly filled with Herald's playback only (half of the ~25 blocks).
  if (s.blocks < 12) return;
  const fig = echoFigures(s, 12);
  if (!fig) return;
  const ev = evidenceFor(envKey);
  ev.passive.push(fig.totalDb);
  if (ev.passive.length > PASSIVE_WINDOWS) ev.passive.shift();
  if (ev.passive.length % 20 === 0) {
    const p = passiveSuppression(ev.passive);
    if (p) console.debug(`Herald audio: echo suppression during replies p20 ${p.totalDb.toFixed(1)} dB over ${p.seconds} s`);
  }
  recomputeMode();
}

function start(): void {
  if (started) return;
  started = true;
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  md?.addEventListener?.('devicechange', () => scheduleRefresh('devicechange'));
  getMicCapture().on(onMicEvent);
  const graph = getAudioGraph();
  graph.onStats(onStats);
  graph.onStateChange(() => scheduleRefresh('graph'));
  if (routeSource) routeOff = routeSource.onChange(() => scheduleRefresh('route'));
}

function notice(n: AudioNotice): void {
  for (const l of [...noticeListeners]) {
    try {
      l(n);
    } catch {
      // ignore
    }
  }
}

// ---- barge-in mode -----------------------------------------------------------------

/** Passive windows kept per setup (~250 ms each: the last 30 s of Herald talking). */
const PASSIVE_WINDOWS = 120;

/**
 * A low percentile of per-window suppression: it has to hold in (almost) every
 * window, not on average. The canceller's first second (converging) and any
 * window where the user talked read low, which only ever errs towards 'gated'.
 */
export function passiveSuppression(windows: number[]): { totalDb: number; seconds: number } | null {
  if (!windows.length) return null;
  const sorted = [...windows].sort((a, b) => a - b);
  const p = sorted[Math.floor(sorted.length * 0.2)];
  return { totalDb: p, seconds: windows.length * 0.25 };
}

function currentEvidence(): BargeInEvidence {
  const ev = envKey ? evidenceFor(envKey) : null;
  return {
    measured: ev?.measured ?? null,
    passive: ev ? passiveSuppression(ev.passive) : null,
    // Echo heard resets the passive windows (reportEchoHeard): nothing left to veto.
    echoHeard: 0,
    falseBargeIns: ev?.falseBargeIns ?? 0,
  };
}

function recomputeMode(): void {
  const graph = getAudioGraph();
  const d = selectBargeInMode({
    aec: env.aec,
    playbackReferenced: !browserVoice && !graph.unreferencedPlayback,
    output: env.output,
    evidence: currentEvidence(),
  });
  if (d.mode === lastDecision.mode && d.reason === lastDecision.reason) return;
  const modeChanged = d.mode !== lastDecision.mode;
  lastDecision = d;
  if (modeChanged) console.debug(`Herald voice: talk-over detection ${d.mode} (${d.reason})`);
  for (const l of [...modeListeners]) {
    try {
      l(d);
    } catch {
      // ignore
    }
  }
}

export function getBargeInDecision(): BargeInDecision {
  return lastDecision;
}

export function onBargeInModeChange(cb: Listener<BargeInDecision>): () => void {
  start();
  modeListeners.add(cb);
  return () => modeListeners.delete(cb);
}

/**
 * A gated talk-over check found Herald's own voice: the VAD heard it through
 * the canceller. Passive evidence starts over (a canceller still converging
 * after a device change, or a loud passage): promotion needs a clean run of
 * PASSIVE_MIN_SECONDS after the last such event.
 */
export function reportEchoHeard(): void {
  if (!envKey) return;
  const ev = evidenceFor(envKey);
  ev.echoHeard++;
  ev.passive = [];
  recomputeMode();
}

/** An instant ('vad') talk-over turned out to be Herald's own voice. */
export function reportFalseBargeIn(): void {
  if (!envKey) return;
  const ev = evidenceFor(envKey);
  ev.falseBargeIns++;
  console.warn('Herald voice: a talk-over was Herald itself; using transcript checks for this setup');
  recomputeMode();
}

export function onAudioNotice(cb: Listener<AudioNotice>): () => void {
  start();
  noticeListeners.add(cb);
  return () => noticeListeners.delete(cb);
}

// ---- contract ------------------------------------------------------------------------

export async function getAudioEnvironment(): Promise<AudioEnvironment> {
  start();
  return refresh('get');
}

export function onAudioEnvironmentChange(cb: (env: AudioEnvironment) => void): () => void {
  start();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** The last echo check for the current setup (or null). */
export function lastEchoMeasurement(): EchoMeasurement | null {
  return envKey ? evidenceFor(envKey).measured : null;
}

/** Warm-up before measuring: a cold canceller needs ~1.5 s of Herald to converge. */
const MEASURE_WARMUP_S = 1.6;
const PROBE_LINE = "Hi, it's Herald. I'm checking how well I can hear myself, so you don't need to say anything.";
export { PROBE_LINE as ECHO_PROBE_LINE };

async function probeAudio(sampleRate: number): Promise<ProbeAudio> {
  if (probeSource) {
    try {
      const p = await probeSource();
      if (p && p.pcm.length > p.sampleRate * 2) return p;
    } catch {
      // fall back
    }
  }
  return { pcm: synthSpeech(sampleRate, 4.5, 11, { f0: 180, peak: 0.35 }), sampleRate };
}

let measuring: Promise<EchoMeasurement> | null = null;

/**
 * Play a short known Herald line and measure how much of it is left in what
 * Herald listens to (the cleaned mic), and whether the VAD hears speech in it.
 * Opens the mic (call from a click the first time: it may prompt). Throws when
 * the mic or audio cannot be used. About 5 s.
 */
export async function measureEchoSuppression(): Promise<{ erleDb: number; residualSpeechDetected: boolean }> {
  const m = await measureEchoDetailed();
  return { erleDb: m.erleDb, residualSpeechDetected: m.residualSpeechDetected };
}

export function measureEchoDetailed(): Promise<EchoMeasurement> {
  if (measuring) return measuring;
  measuring = runMeasurement().finally(() => {
    measuring = null;
  });
  return measuring;
}

async function runMeasurement(): Promise<EchoMeasurement> {
  start();
  const graph = getAudioGraph();
  const mic = getMicCapture();
  mic.retain();
  const vad = new VadListener(mic);
  try {
    await mic.acquire();
    if (!(await graph.resume(1500))) throw new Error('Audio is blocked: tap the page and try again');
    await refresh('measure');
    const ctx = graph.context()!;
    // Played at Herald's own volume, so the check measures what the user hears.
    const bus = graph.voiceBus()!;
    const probe = await probeAudio(ctx.sampleRate);
    const key = envKey;

    // The VAD on the cleaned mic, exactly as talk-over detection would hear it.
    let speechFrames = 0;
    let maxRun = 0;
    let run = 0;
    let measureFromCtx = Infinity;
    const threshold = VAD_PRESETS.normal.positiveSpeechThreshold;
    const events: VadEvents = {
      onSpeechStart: () => {},
      onSpeechRealStart: () => {},
      onMisfire: () => {},
      onSpeechEnd: () => {},
      onFrame: (_f, p) => {
        if (ctx.currentTime < measureFromCtx) return;
        if (p >= threshold) {
          speechFrames++;
          run++;
          maxRun = Math.max(maxRun, run);
        } else run = 0;
      },
    };
    await vad.start(events, 'normal');

    const buf = ctx.createBuffer(1, probe.pcm.length, probe.sampleRate);
    buf.getChannelData(0).set(probe.pcm);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(bus);
    const t0 = ctx.currentTime + 0.05;
    const t1 = t0 + buf.duration;
    measureFromCtx = t0 + MEASURE_WARMUP_S;
    const stop = graph.collectStats((s) => s.at >= measureFromCtx && s.at <= t1 + 0.3);
    src.start(t0);
    await new Promise<void>((resolve) => {
      src.onended = () => resolve();
      setTimeout(resolve, (buf.duration + 1.5) * 1000);
    });
    // Let the room (and the last stats window) settle.
    await new Promise((r) => setTimeout(r, 450));
    const stats = stop();
    src.disconnect();
    const fig = echoFigures(stats, 60);
    if (!fig) throw new Error(graph.measuring ? 'Could not measure: no playback reached the canceller' : 'Could not measure: the in-app audio processor is not running');
    // Residual: speech-like frames the VAD would treat as a person (its minimum
    // speech time in 32 ms frames), or a lot of scattered ones.
    const minFrames = Math.ceil(VAD_PRESETS.normal.minSpeechMs / 32);
    const residualSpeechDetected = maxRun >= minFrames || speechFrames >= minFrames * 3;
    const m: EchoMeasurement = {
      erleDb: round1(fig.totalDb),
      residualSpeechDetected,
      erlDb: round1(fig.erlDb),
      cancelDb: round1(fig.erleDb),
      aec: env.aec,
      at: Date.now(),
      envKey: key,
    };
    const ev = evidenceFor(key);
    ev.measured = m;
    // A fresh measurement supersedes old passive doubts for this setup.
    ev.echoHeard = 0;
    ev.falseBargeIns = 0;
    saveMeasurement(m);
    console.info(`Herald voice: echo check ${m.erleDb} dB (acoustic ${m.erlDb} dB, cancelled ${m.cancelDb} dB, ${m.aec})${residualSpeechDetected ? ', speech left in the mic' : ''}`);
    await refresh('measured');
    return m;
  } finally {
    vad.destroy();
    mic.releaseUser();
  }
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** Tests: forget everything. */
export function __resetAudioEnvironmentForTests(): void {
  evidence.clear();
  env = { output: 'unknown', input: 'unknown', aec: 'browser' };
  envKey = '';
  lastOutputSig = '';
  lastDecision = { mode: 'gated', reason: 'echo not measured yet' };
  browserVoice = false;
}
