import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { registerDiagnostics } from '../services/diagnostics';
import type { HeraldEventListener } from './useHerald';
import type { TtsEngine, TtsVoice } from '../services/tts/types';
import type { HeraldPresenceResult, HeraldTtsResult, HeraldVoiceEvent, HeraldVoiceStatus } from '../types/herald';
import type { HeraldTransport } from '../services/heraldTransport';
import { getWebSpeechEngine } from '../services/tts/webSpeechEngine';
import { HybridTtsEngine } from '../services/tts/hybridTtsEngine';
import { NEURAL_PREFIX, TtsRequestError, WebAudioSink, decodePcm16, type TtsRequester } from '../services/tts/serverTtsEngine';
import { ECHO_PROBE_LINE, setBrowserVoice, setEchoProbeSource } from '../services/voice/audioEnvironment';
import { BRIEFING_SPOKEN_LIMIT, HeraldSpeechController, InboxChimeTracker, inboxToneAllowed, type SpokenLength } from '../services/tts/heraldSpeech';
import { TICK_VOLUME, chimeSupported, playChime, unlockChime } from '../services/tts/chime';
import { pickVoice } from '../services/tts/voices';
import { deviceKey, deviceLabel, devicePlatform, saveCustomLabel } from '../services/heraldDevice';
import { SpokenLog, recordingEngine } from '../services/voice/echoGuard';
import { FleetSpeakingTracker, SpeakingReporter, planStop, reportingEngine, type RemoteSpeaker } from '../services/voice/fleetSpeaking';
import { heraldVolumeStore, stepVolume as nextVolume, volumePercent, webSpeechVolume, type HeraldVolume, type VolumeCommand } from '../services/tts/volume';
import { isGamingMode } from '../services/heraldSetup/setupStore';
import { getAudioGraph } from '../services/voice/audioGraph';

const PREFS_KEY = 'herald_voice_prefs';
export const RATE_MIN = 0.9;
export const RATE_MAX = 1.4;
export const RATE_DEFAULT = 1.05;
/** "slower" / "faster" move the rate by this much. */
export const RATE_STEP = 0.1;

interface VoicePrefs {
  voiceOn: boolean;
  chimeOn: boolean;
  voiceId: string | null;
  rate: number;
  /** Speak the first sentence or two (short) or the whole reply (full). */
  spokenLength: SpokenLength;
  /** Replay the tone for a blocked item nobody has heard after 5 minutes (twice at most). */
  remind: boolean;
  /** A tiny tick the moment a voice turn ends ("heard you"). */
  ackTick: boolean;
  /** A very soft looping tone while Herald thinks (after 1.5 s with no audio). */
  thinkingTone: boolean;
  /** A distinct tone when a session makes a risky code change (Code Review). Never spoken. */
  riskTones: boolean;
}

const DEFAULT_PREFS: VoicePrefs = {
  voiceOn: true, chimeOn: true, voiceId: null, rate: RATE_DEFAULT, spokenLength: 'short', remind: true, ackTick: true, thinkingTone: false, riskTones: true,
};

/** Next rate for "slower" / "faster", clamped; null when already at the limit. */
export function stepRate(rate: number, dir: 1 | -1): number | null {
  const next = Math.round(Math.min(RATE_MAX, Math.max(RATE_MIN, rate + dir * RATE_STEP)) * 100) / 100;
  return Math.abs(next - rate) < 0.001 ? null : next;
}

function loadPrefs(): VoicePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<VoicePrefs>;
    return {
      voiceOn: typeof p.voiceOn === 'boolean' ? p.voiceOn : DEFAULT_PREFS.voiceOn,
      chimeOn: typeof p.chimeOn === 'boolean' ? p.chimeOn : DEFAULT_PREFS.chimeOn,
      voiceId: typeof p.voiceId === 'string' ? p.voiceId : null,
      rate: typeof p.rate === 'number' && Number.isFinite(p.rate)
        ? Math.min(RATE_MAX, Math.max(RATE_MIN, p.rate))
        : DEFAULT_PREFS.rate,
      spokenLength: p.spokenLength === 'full' ? 'full' : 'short',
      remind: typeof p.remind === 'boolean' ? p.remind : DEFAULT_PREFS.remind,
      ackTick: typeof p.ackTick === 'boolean' ? p.ackTick : DEFAULT_PREFS.ackTick,
      thinkingTone: typeof p.thinkingTone === 'boolean' ? p.thinkingTone : DEFAULT_PREFS.thinkingTone,
      riskTones: typeof p.riskTones === 'boolean' ? p.riskTones : DEFAULT_PREFS.riskTones,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(p: VoicePrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // storage unavailable: preference just won't persist
  }
}

function pageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

/**
 * News tones may play now. Normally only with the page in view, but in the
 * Gaming profile the game is in front by design (Chrome on Windows marks a
 * tab covered by a full-screen game as hidden): tones are the whole point there.
 */
function tonesAudible(): boolean {
  return pageVisible() || isGamingMode();
}

const TTS_REQUEST_TIMEOUT = 25000;
/** Report "the user is here" at most this often. */
const PRESENCE_THROTTLE_MS = 20_000;
const REMINDER_CHECK_MS = 20_000;
const FLASH_MS = 1800;
const STATUS_REFRESH_MS = 60_000;
const STATUS_RETRY_MS = 10_000;
/** How long a remote trigger lets replies play in a hidden tab (think + speak). */
export const BACKGROUND_SPEECH_MS = 90_000;

/** Voice side channel to the current hub. */
export interface HeraldVoiceHost {
  getTransport: () => HeraldTransport | null;
  connected: boolean;
}

function makeRequester(getTransport: () => HeraldTransport | null): TtsRequester {
  return {
    async synth(req) {
      const t = getTransport();
      if (!t || !t.isConnected()) throw new TtsRequestError('Not connected', 'unavailable');
      let res;
      try {
        res = await t.request('herald_tts', req, TTS_REQUEST_TIMEOUT);
      } catch {
        throw new TtsRequestError('Speech synthesis timed out', 'timeout');
      }
      if (res.success && res.payload) return res.payload as HeraldTtsResult;
      const code = (res.payload as { code?: string } | undefined)?.code ?? 'failed';
      throw new TtsRequestError(res.error || 'Speech synthesis failed', code);
    },
    cancel() {
      const t = getTransport();
      if (t && t.isConnected()) t.request('herald_tts_cancel', {}, 5000).catch(() => {});
    },
  };
}

export interface HeraldVoice {
  /** Platform can speak at all (false in e.g. Android WebView). */
  supported: boolean;
  chimeSupported: boolean;
  voiceOn: boolean;
  chimeOn: boolean;
  speaking: boolean;
  voices: TtsVoice[];
  /** Voice actually in use (saved choice or best available). */
  voice: TtsVoice | null;
  /** True when the user explicitly picked a voice (vs automatic). */
  voicePinned: boolean;
  rate: number;
  setVoiceOn: (on: boolean) => void;
  setChimeOn: (on: boolean) => void;
  setVoiceId: (id: string | null) => void;
  setRate: (rate: number) => void;
  /** Barge-in: stop speaking now. */
  stop: () => void;
  /** The STOP voice command: silence, keep the reply being thought about silent, flash "Stopped". */
  stopCommand: () => void;
  /** REPEAT: replay the last reply (cached audio when available). False if nothing to repeat. */
  repeat: () => boolean;
  /** MORE: speak what the spoken cap held back. False when nothing was held back. */
  goOn: () => boolean;
  /** SLOWER / FASTER: one step, persisted, with a spoken "Okay." at the new speed. */
  stepRate: (dir: 1 | -1) => void;
  /** The next reply is a briefing (a longer spoken allowance). */
  expectBriefing: () => void;
  /** Short spoken confirmation ("Cancelled."), replacing anything playing; also flashed. */
  say: (text: string) => void;
  spokenLength: SpokenLength;
  setSpokenLength: (v: SpokenLength) => void;
  remind: boolean;
  setRemind: (on: boolean) => void;
  /** Tick when a voice turn ends (on by default). */
  ackTick: boolean;
  setAckTick: (on: boolean) => void;
  /** Soft thinking loop while waiting for the first audio (off by default). */
  thinkingTone: boolean;
  setThinkingTone: (on: boolean) => void;
  /** Tone for risky code changes (on by default; same gating as the other news tones). */
  riskTones: boolean;
  setRiskTones: (on: boolean) => void;
  /** Replies may play in a hidden tab right now (a remote trigger asked recently). */
  backgroundAllowed: () => boolean;
  /**
   * The browser has not let this page play sound yet (no click or key since it
   * loaded): voice and tones are silent until the user clicks once. Mid-game
   * that means a silent Herald, so the panel says so.
   */
  audioLocked: boolean;
  /** Transient feedback for a voice command ("Stopped", "Slower"), or null. */
  flash: string | null;
  /** This device plays the inbox tones (one device at a time; true on older hubs). */
  announcer: boolean;
  testVoice: () => void;
  /** Daemon voice-service status (null until known / no hub). */
  serverStatus: HeraldVoiceStatus | null;
  /** Neural voices are in use (service up and a neural voice selected). */
  neural: boolean;
  /** Re-probe the voice service now. */
  refreshStatus: () => void;
  /**
   * A remote trigger asked for speech: replies may play while this tab is hidden
   * for a while (normally a background tab stays quiet).
   */
  allowBackground: (ms?: number) => void;
  /** This connection's device id on the hub (null until known / older hub). */
  selfId: string | null;
  /** This device's friendly name (auto-detected or renamed). */
  deviceLabel: string;
  /** Rename this device (empty: back to the detected name). */
  renameDevice: (label: string) => void;
  /** Make this device (or `deviceId`) the active one; `pin` keeps it there. Resolves an error or null. */
  claimDevice: (pin: boolean, deviceId?: string) => Promise<string | null>;
  /** Everything Herald said lately (voice input drops transcripts of it: self-echo). */
  spokenLog: SpokenLog;
  /** Herald is speaking on ANOTHER device right now ("Speaking on <device>"), or null. */
  remoteSpeaking: RemoteSpeaker | null;
  /** Stop Herald on the device that is speaking (via the hub). */
  stopRemote: () => void;
  /** Herald's own volume on this device (voice + tones). */
  volume: HeraldVolume;
  /** Voice volume 0..1.5 (slider, tray). */
  setVolume: (v: number) => void;
  setTonesVolume: (v: number) => void;
  setTonesFollowVoice: (on: boolean) => void;
  /** "louder" / "quieter" / "volume 50": persisted, flashed, and confirmed out loud at the new level. */
  volumeCommand: (cmd: VolumeCommand) => void;
  /**
   * Another device is speaking (or just stopped): this device's mic may be
   * hearing Herald with nothing to cancel it against. Hands-off capture holds back.
   */
  fleetSuppressed: () => boolean;
}

const TEST_LINE = "Hi, I'm Herald. Two sessions finished, and one is waiting on you.";

/**
 * Voice replies + inbox chimes, wired to Herald's raw event stream.
 * `subscribeEvents` must have stable identity; `hostId` changes reset state.
 */
export function useHeraldVoice(
  subscribeEvents: (l: HeraldEventListener) => () => void,
  hostId: string | null,
  engineOverride?: TtsEngine,
  host?: HeraldVoiceHost,
): HeraldVoice {
  const hostRef = useRef(host);
  hostRef.current = host;
  const hybrid = useMemo(
    () => (engineOverride ? null : new HybridTtsEngine(getWebSpeechEngine(), makeRequester(() => hostRef.current?.getTransport() ?? null), new WebAudioSink())),
    [engineOverride],
  );
  const spokenLog = useMemo(() => new SpokenLog(), []);
  // This connection's id on the hub: lines name the ONE device that speaks them.
  const selfIdRef = useRef<string | null>(null);
  // Fleet signal: this device tells the others while it plays Herald.
  // An older hub answers "unknown message type": stop reporting to it.
  const speakingUnsupported = useRef(false);
  const reporter = useMemo(() => new SpeakingReporter({
    enabled: () => !speakingUnsupported.current && !!selfIdRef.current && !!hostRef.current?.getTransport()?.isConnected(),
    send: (r) => {
      const t = hostRef.current?.getTransport();
      if (!t || !t.isConnected()) return;
      t.request('herald_speaking', r, 5000)
        .then((res) => {
          if (!res.success && /unknown message type/i.test(res.error ?? '')) speakingUnsupported.current = true;
        })
        .catch(() => {});
    },
  }), []);
  useEffect(() => () => reporter.dispose(), [reporter]);
  // Every sentence handed to the engine is remembered for the self-echo filter.
  const engine: TtsEngine = useMemo(
    () => recordingEngine(reportingEngine(engineOverride ?? hybrid!, reporter), spokenLog),
    [engineOverride, hybrid, spokenLog, reporter],
  );
  // ...and hears when another device plays it.
  const fleet = useMemo(() => new FleetSpeakingTracker(), []);
  const [remoteSpeaking, setRemoteSpeaking] = useState<RemoteSpeaker | null>(null);
  useEffect(() => fleet.subscribe(setRemoteSpeaking), [fleet]);
  // Help > Diagnostics: is hands-off capture held back because Herald speaks elsewhere?
  useEffect(() => registerDiagnostics('speakingElsewhere', () => {
    const remote = fleet.remote;
    return { suppressed: fleet.suppressed(), speaker: remote?.label ?? null, speakerId: remote?.deviceId ?? null, remainingMs: fleet.remainingMs() };
  }), [fleet]);
  const [serverStatus, setServerStatus] = useState<HeraldVoiceStatus | null>(null);
  const [statusNonce, setStatusNonce] = useState(0);
  const [prefs, setPrefs] = useState<VoicePrefs>(loadPrefs);
  const [voices, setVoices] = useState<TtsVoice[]>(() => engine.getVoices());
  const [speaking, setSpeaking] = useState(engine.speaking);

  const voice = useMemo(() => pickVoice(voices, prefs.voiceId), [voices, prefs.voiceId]);

  // Echo cancellation needs Herald's playback as its reference: the neural voice
  // plays through the shared audio graph, a browser voice (Web Speech) does not.
  const neuralVoice = !!hybrid && !!serverStatus?.available && !!serverStatus?.tts.ready && voice?.engine === 'neural';
  useEffect(() => {
    if (!hybrid) return;
    setBrowserVoice(!neuralVoice);
  }, [hybrid, neuralVoice]);
  // The echo check plays a line in Herald's own voice (synthesised on the hub).
  const voiceIdRef = useRef<string | null>(null);
  voiceIdRef.current = voice?.id ?? null;
  useEffect(() => {
    if (!hybrid) return;
    const requester = makeRequester(() => hostRef.current?.getTransport() ?? null);
    setEchoProbeSource(async () => {
      const id = voiceIdRef.current;
      const r = await requester.synth({ text: ECHO_PROBE_LINE, voice: id?.startsWith(NEURAL_PREFIX) ? id.slice(NEURAL_PREFIX.length) : null, speed: 1 });
      const pcm16 = decodePcm16(r.audio);
      const pcm = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) pcm[i] = pcm16[i] / 32768;
      return { pcm, sampleRate: r.sampleRate };
    });
    return () => setEchoProbeSource(null);
  }, [hybrid]);

  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const backgroundUntil = useRef(0);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  const controller = useMemo(
    () => new HeraldSpeechController(engine, {
      isEnabled: () => prefsRef.current.voiceOn,
      isVisible: () => pageVisible() || Date.now() < backgroundUntil.current,
      speakOptions: () => ({ rate: prefsRef.current.rate, voiceId: voiceRef.current?.id ?? null, volume: webSpeechVolume(heraldVolumeStore.get()) }),
      spokenLength: () => prefsRef.current.spokenLength,
      selfId: () => selfIdRef.current,
    }),
    [engine],
  );
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showFlash = useCallback((text: string) => {
    setFlash(text);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
  }, []);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);
  const showFlashRef = useRef(showFlash);
  showFlashRef.current = showFlash;
  // One device plays inbox tones; older hubs (no arbitration) leave every device on.
  const [announcer, setAnnouncer] = useState(true);
  const [selfId, setSelfId] = useState<string | null>(null);
  selfIdRef.current = selfId;
  const [label, setLabel] = useState(deviceLabel);
  const labelRef = useRef(label);
  labelRef.current = label;
  const reportRef = useRef<((interacted: boolean) => void) | null>(null);
  const announcerRef = useRef(announcer);
  announcerRef.current = announcer;
  const chimes = useMemo(() => new InboxChimeTracker(), []);

  useEffect(() => { savePrefs(prefs); }, [prefs]);

  // Engine state -> React.
  useEffect(() => engine.on((e) => {
    if (e.type === 'speaking') setSpeaking(e.speaking);
    else if (e.type === 'voices') setVoices(e.voices);
  }), [engine]);

  // Herald events -> speech (replies the user asked for) + tones (everything
  // else: Herald never speaks up on its own).
  useEffect(() => subscribeEvents((event, source) => {
    controller.handleEvent(event, source);
    chimes.riskTones = prefsRef.current.riskTones;
    const kind = chimes.handleEvent(event, source);
    if (kind && inboxToneAllowed({ chimeOn: prefsRef.current.chimeOn, announcer: announcerRef.current, visible: pageVisible(), gaming: isGamingMode() }))
      playChime(kind);
    if (source !== 'push') return;
    if (event.kind === 'speaking') {
      fleet.handle(event.speaking, selfIdRef.current);
    } else if (event.kind === 'stop_speaking') {
      // Another device said "stop" or pressed its stop button.
      controller.stop({ muteTurn: true });
      showFlashRef.current(event.by ? `Stopped from ${event.by}` : 'Stopped');
    }
  }), [subscribeEvents, controller, chimes, fleet]);

  // Gentle reminder: a blocked item nobody has heard gets its tone again.
  useEffect(() => {
    const t = setInterval(() => {
      const p = prefsRef.current;
      if (!p.remind || !p.chimeOn || !announcerRef.current || !tonesAudible()) return;
      const kind = chimes.dueReminder();
      if (kind) playChime(kind);
    }, REMINDER_CHECK_MS);
    return () => clearInterval(t);
  }, [chimes]);

  // New host: everything we knew is about a different conversation.
  useEffect(() => {
    controller.reset();
    chimes.reset();
    fleet.reset();
  }, [hostId, controller, chimes, fleet]);

  // Leaving the tab (or locking the phone) silences immediately.
  useEffect(() => {
    // Not while a remote trigger allowed background speech (mid-game: the user
    // asked from another window; alt-tabbing back into the game must not cut it).
    const onVis = () => { if (!pageVisible() && Date.now() >= backgroundUntil.current) controller.stop(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [controller]);

  // Autoplay rules: the first gesture anywhere on the page primes audio silently.
  useEffect(() => {
    const prime = () => {
      engine.unlock();
      unlockChime();
      window.removeEventListener('pointerdown', prime, true);
      window.removeEventListener('keydown', prime, true);
    };
    window.addEventListener('pointerdown', prime, true);
    window.addEventListener('keydown', prime, true);
    return () => {
      window.removeEventListener('pointerdown', prime, true);
      window.removeEventListener('keydown', prime, true);
    };
  }, [engine]);

  useEffect(() => () => controller.reset(), [controller]);

  // Is sound allowed yet? A fresh page needs one gesture (autoplay rules).
  const [audioLocked, setAudioLocked] = useState(false);
  useEffect(() => {
    if (engineOverride) return;
    const ctx = getAudioGraph().context();
    if (!ctx) return;
    const update = () => setAudioLocked(ctx.state === 'suspended');
    update();
    // Allowed without a gesture when the page already had one (or the app allows autoplay).
    void ctx.resume().catch(() => {}).finally(update);
    ctx.addEventListener('statechange', update);
    return () => ctx.removeEventListener('statechange', update);
  }, [engineOverride]);

  // Voice-service status from the hub: drives neural voices (and voice input).
  const connected = host?.connected ?? false;
  useEffect(() => {
    setServerStatus(null);
    hybrid?.setServerStatus(false, [], null);
    if (!connected || !hostRef.current) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inflight = false;
    const probe = async () => {
      if (inflight || cancelled) return;
      inflight = true;
      let next = STATUS_REFRESH_MS;
      try {
        const t = hostRef.current?.getTransport();
        const res = t && t.isConnected() ? await t.request('herald_voice_status', {}, 5000) : null;
        if (cancelled) return;
        const st = res?.success ? (res.payload as HeraldVoiceStatus) : null;
        setServerStatus(st);
        hybrid?.setServerStatus(!!st?.available && !!st.tts.ready, st?.tts.voices ?? [], st?.tts.defaultVoice ?? null);
        if (!st?.available) next = STATUS_RETRY_MS;
      } catch {
        if (!cancelled) next = STATUS_RETRY_MS;
      } finally {
        inflight = false;
        if (!cancelled) timer = setTimeout(() => void probe(), next);
      }
    };
    void probe();
    // A synthesis failure means the service may have gone: re-probe soon.
    const off = hybrid?.server.on((e) => {
      if (e.type === 'error' && timer) {
        clearTimeout(timer);
        timer = setTimeout(() => void probe(), 2000);
      }
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      off?.();
    };
  }, [connected, hostId, hybrid, statusNonce]);

  // Presence: tell the hub this device is here (on connect / when shown) and
  // in use (key or tap, throttled), so exactly one device plays the tones.
  useEffect(() => {
    setAnnouncer(true);
    setSelfId(null);
    selfIdRef.current = null;
    speakingUnsupported.current = false;
    // A new connection: the old speaking signal is stale (a new one arrives within a second).
    fleet.reset();
    if (!connected || !hostRef.current) return;
    let cancelled = false;
    let lastInteract = 0;
    const key = deviceKey();
    const platform = devicePlatform();
    const report = (interacted: boolean) => {
      const t = hostRef.current?.getTransport();
      if (!t || !t.isConnected() || cancelled) return;
      t.request('herald_presence', { interacted, label: labelRef.current, deviceKey: key, platform }, 5000)
        .then((res) => {
          if (cancelled) return;
          // Older hub / voice off: no arbitration, keep toning here.
          const p = res.payload as HeraldPresenceResult | undefined;
          setAnnouncer(res.success ? !!p?.announcer : true);
          if (res.success && typeof p?.clientId === 'string') {
            selfIdRef.current = p.clientId;
            setSelfId(p.clientId);
          }
        })
        .catch(() => {});
    };
    reportRef.current = report;
    report(false);
    const onUse = () => {
      const now = Date.now();
      if (now - lastInteract < PRESENCE_THROTTLE_MS) return;
      lastInteract = now;
      report(true);
    };
    const onVis = () => { if (pageVisible()) report(false); };
    window.addEventListener('pointerdown', onUse, true);
    window.addEventListener('keydown', onUse, true);
    document.addEventListener('visibilitychange', onVis);
    const t = hostRef.current.getTransport();
    const off = t?.onVoiceEvent?.((ev: HeraldVoiceEvent) => {
      if (ev.kind === 'announcer') setAnnouncer(ev.owner);
    });
    return () => {
      cancelled = true;
      reportRef.current = null;
      window.removeEventListener('pointerdown', onUse, true);
      window.removeEventListener('keydown', onUse, true);
      document.removeEventListener('visibilitychange', onVis);
      off?.();
    };
  }, [connected, hostId, fleet]);

  const refreshStatus = useCallback(() => setStatusNonce((n) => n + 1), []);
  const renameDevice = useCallback((raw: string) => {
    const next = saveCustomLabel(raw);
    labelRef.current = next;
    setLabel(next);
    reportRef.current?.(false);
  }, []);
  const claimDevice = useCallback(async (pin: boolean, deviceId?: string): Promise<string | null> => {
    const t = hostRef.current?.getTransport();
    if (!t || !t.isConnected()) return 'Not connected to the Herald host';
    try {
      const res = await t.request('herald_claim_device', deviceId ? { pin, deviceId } : { pin }, 5000);
      if (res.success) return null;
      return /unknown message type/i.test(res.error ?? '') ? 'This hub is too old to switch devices' : res.error || 'Could not switch devices';
    } catch {
      return 'Could not switch devices';
    }
  }, []);
  const allowBackground = useCallback((ms: number = BACKGROUND_SPEECH_MS) => {
    backgroundUntil.current = Date.now() + ms;
  }, []);
  useEffect(() => () => hybrid?.dispose(), [hybrid]);

  const stop = useCallback(() => controller.stop(), [controller]);
  /** Stop Herald on the device that is speaking it (the hub forwards the stop). */
  const stopRemote = useCallback(() => {
    const t = hostRef.current?.getTransport();
    const r = fleet.remote;
    if (!t || !t.isConnected()) return;
    t.request('herald_stop_speaking', r ? { deviceId: r.deviceId } : {}, 5000).catch(() => {});
  }, [fleet]);
  const engineSpeakingRef = useRef(false);
  engineSpeakingRef.current = speaking;
  const stopCommand = useCallback(() => {
    // "stop", the stop shortcut, the tray / orb: quiet here, and on whichever
    // device is speaking (the hub knows it even when this device missed it).
    const plan = planStop({ localSpeaking: engineSpeakingRef.current || engine.speaking, remote: fleet.remote });
    controller.stop({ muteTurn: true });
    const t = hostRef.current?.getTransport();
    if (plan.hub && t && t.isConnected()) t.request('herald_stop_speaking', plan.hub, 5000).catch(() => {});
    showFlash('Stopped');
  }, [controller, showFlash, fleet, engine]);
  const fleetSuppressed = useCallback(() => fleet.suppressed(), [fleet]);
  const repeat = useCallback(() => {
    const ok = controller.repeat();
    if (ok) showFlash('Repeating');
    return ok;
  }, [controller, showFlash]);
  const goOn = useCallback(() => controller.continueRemainder(), [controller]);
  const expectBriefing = useCallback(() => controller.setNextLimit(BRIEFING_SPOKEN_LIMIT), [controller]);
  const say = useCallback((text: string) => {
    controller.say(text);
    showFlash(text.replace(/[.!]+$/, ''));
  }, [controller, showFlash]);
  const stepRateCb = useCallback((dir: 1 | -1) => {
    const cur = prefsRef.current.rate;
    const next = stepRate(cur, dir);
    if (next === null) {
      showFlash(dir > 0 ? 'Fastest speed' : 'Slowest speed');
      controller.say(dir > 0 ? "That's as fast as I go." : "That's as slow as I go.");
      return;
    }
    prefsRef.current = { ...prefsRef.current, rate: next };
    setPrefs((p) => ({ ...p, rate: next }));
    showFlash(`${dir > 0 ? 'Faster' : 'Slower'} \u00b7 ${next.toFixed(2)}\u00d7`);
    // Said at the new speed, so the user hears the change.
    controller.say('Okay.');
  }, [controller, showFlash]);
  const [volume, setVolumeState] = useState<HeraldVolume>(() => heraldVolumeStore.get());
  useEffect(() => heraldVolumeStore.subscribe(setVolumeState), []);
  const setVolume = useCallback((v: number) => heraldVolumeStore.setVoice(v), []);
  const setTonesVolume = useCallback((v: number) => heraldVolumeStore.setTones(v), []);
  const setTonesFollowVoice = useCallback((on: boolean) => heraldVolumeStore.setTonesFollowVoice(on), []);
  const volumeCommand = useCallback((cmd: VolumeCommand) => {
    const cur = heraldVolumeStore.get().voice;
    const next = cmd.kind === 'set' ? cmd.value : nextVolume(cur, cmd.dir);
    if (next === null) {
      const up = cmd.kind === 'step' && cmd.dir > 0;
      showFlash(up ? 'Loudest' : 'Quietest');
      controller.say(up ? "That's as loud as I go." : "That's as quiet as I go.");
      return;
    }
    heraldVolumeStore.setVoice(next);
    const pct = volumePercent(next);
    showFlash(pct === 0 ? 'Muted' : `Volume ${pct}%`);
    // Said at the new level (the gain applies at once), so the user hears the change.
    if (pct > 0) controller.say(`Volume ${pct}.`);
  }, [controller, showFlash]);
  const setSpokenLength = useCallback((v: SpokenLength) => setPrefs((p) => ({ ...p, spokenLength: v })), []);
  const setRemind = useCallback((on: boolean) => setPrefs((p) => ({ ...p, remind: on })), []);
  const setAckTick = useCallback((on: boolean) => {
    setPrefs((p) => ({ ...p, ackTick: on }));
    if (on) playChime('tick', TICK_VOLUME);
  }, []);
  const setThinkingTone = useCallback((on: boolean) => setPrefs((p) => ({ ...p, thinkingTone: on })), []);
  const setRiskTones = useCallback((on: boolean) => {
    setPrefs((p) => ({ ...p, riskTones: on }));
    if (on && tonesAudible()) playChime('risk');
  }, []);
  const backgroundAllowed = useCallback(() => Date.now() < backgroundUntil.current, []);

  const setVoiceOn = useCallback((on: boolean) => {
    setPrefs((p) => ({ ...p, voiceOn: on }));
    if (!on) controller.stop();
  }, [controller]);

  const setChimeOn = useCallback((on: boolean) => {
    setPrefs((p) => ({ ...p, chimeOn: on }));
    if (on) playChime('finished');
  }, []);

  const setVoiceId = useCallback((id: string | null) => setPrefs((p) => ({ ...p, voiceId: id })), []);
  const setRate = useCallback((rate: number) => {
    setPrefs((p) => ({ ...p, rate: Math.min(RATE_MAX, Math.max(RATE_MIN, rate)) }));
  }, []);

  const testVoice = useCallback(() => {
    controller.stop();
    engine.unlock();
    engine.speak(TEST_LINE, { rate: prefsRef.current.rate, voiceId: voiceRef.current?.id ?? null, volume: webSpeechVolume(heraldVolumeStore.get()) });
  }, [controller, engine]);

  return useMemo(() => ({
    supported: engine.available,
    chimeSupported: chimeSupported(),
    voiceOn: prefs.voiceOn,
    chimeOn: prefs.chimeOn,
    speaking,
    voices,
    voice,
    voicePinned: !!prefs.voiceId && voice?.id === prefs.voiceId,
    rate: prefs.rate,
    setVoiceOn,
    setChimeOn,
    setVoiceId,
    setRate,
    stop,
    stopCommand,
    repeat,
    goOn,
    stepRate: stepRateCb,
    expectBriefing,
    say,
    spokenLength: prefs.spokenLength,
    setSpokenLength,
    remind: prefs.remind,
    setRemind,
    ackTick: prefs.ackTick,
    setAckTick,
    thinkingTone: prefs.thinkingTone,
    riskTones: prefs.riskTones,
    setRiskTones,
    setThinkingTone,
    backgroundAllowed,
    audioLocked,
    flash,
    announcer,
    testVoice,
    serverStatus,
    neural: !!hybrid && hybrid.server.available && voice?.engine === 'neural',
    refreshStatus,
    allowBackground,
    selfId,
    deviceLabel: label,
    renameDevice,
    claimDevice,
    spokenLog,
    remoteSpeaking,
    stopRemote,
    fleetSuppressed,
    volume,
    setVolume,
    setTonesVolume,
    setTonesFollowVoice,
    volumeCommand,
  }), [volume, setVolume, setTonesVolume, setTonesFollowVoice, volumeCommand, remoteSpeaking, stopRemote, fleetSuppressed, spokenLog, engine, hybrid, prefs, speaking, voices, voice, setVoiceOn, setChimeOn, setVoiceId, setRate, stop, stopCommand, repeat, goOn, stepRateCb, expectBriefing, say, setSpokenLength, setRemind, setAckTick, setThinkingTone, setRiskTones, backgroundAllowed, audioLocked, flash, announcer, testVoice, serverStatus, refreshStatus, allowBackground, selfId, label, renameDevice, claimDevice]);
}
