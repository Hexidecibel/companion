import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HeraldEventListener } from './useHerald';
import type { TtsEngine, TtsVoice } from '../services/tts/types';
import type { HeraldTtsResult, HeraldVoiceStatus } from '../types/herald';
import type { HeraldTransport } from '../services/heraldTransport';
import { getWebSpeechEngine } from '../services/tts/webSpeechEngine';
import { HybridTtsEngine } from '../services/tts/hybridTtsEngine';
import { TtsRequestError, WebAudioSink, type TtsRequester } from '../services/tts/serverTtsEngine';
import { HeraldSpeechController, InboxChimeTracker } from '../services/tts/heraldSpeech';
import { chimeSupported, playChime, unlockChime } from '../services/tts/chime';
import { pickVoice } from '../services/tts/voices';

const PREFS_KEY = 'herald_voice_prefs';
export const RATE_MIN = 0.9;
export const RATE_MAX = 1.4;
export const RATE_DEFAULT = 1.05;

interface VoicePrefs {
  voiceOn: boolean;
  chimeOn: boolean;
  voiceId: string | null;
  rate: number;
}

const DEFAULT_PREFS: VoicePrefs = { voiceOn: true, chimeOn: true, voiceId: null, rate: RATE_DEFAULT };

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

const TTS_REQUEST_TIMEOUT = 25000;
const STATUS_REFRESH_MS = 60_000;
const STATUS_RETRY_MS = 10_000;

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
  testVoice: () => void;
  /** Daemon voice-service status (null until known / no hub). */
  serverStatus: HeraldVoiceStatus | null;
  /** Neural voices are in use (service up and a neural voice selected). */
  neural: boolean;
  /** Re-probe the voice service now. */
  refreshStatus: () => void;
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
  const engine: TtsEngine = useMemo(() => engineOverride ?? hybrid!, [engineOverride, hybrid]);
  const [serverStatus, setServerStatus] = useState<HeraldVoiceStatus | null>(null);
  const [statusNonce, setStatusNonce] = useState(0);
  const [prefs, setPrefs] = useState<VoicePrefs>(loadPrefs);
  const [voices, setVoices] = useState<TtsVoice[]>(() => engine.getVoices());
  const [speaking, setSpeaking] = useState(engine.speaking);

  const voice = useMemo(() => pickVoice(voices, prefs.voiceId), [voices, prefs.voiceId]);

  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  const controller = useMemo(
    () => new HeraldSpeechController(engine, {
      isEnabled: () => prefsRef.current.voiceOn,
      isVisible: pageVisible,
      speakOptions: () => ({ rate: prefsRef.current.rate, voiceId: voiceRef.current?.id ?? null }),
    }),
    [engine],
  );
  const chimes = useMemo(() => new InboxChimeTracker(), []);

  useEffect(() => { savePrefs(prefs); }, [prefs]);

  // Engine state -> React.
  useEffect(() => engine.on((e) => {
    if (e.type === 'speaking') setSpeaking(e.speaking);
    else if (e.type === 'voices') setVoices(e.voices);
  }), [engine]);

  // Herald events -> speech + chimes.
  useEffect(() => subscribeEvents((event, source) => {
    controller.handleEvent(event, source);
    const kind = chimes.handleEvent(event, source);
    if (kind && prefsRef.current.chimeOn && pageVisible()) playChime(kind);
  }), [subscribeEvents, controller, chimes]);

  // New host: everything we knew is about a different conversation.
  useEffect(() => {
    controller.reset();
    chimes.reset();
  }, [hostId, controller, chimes]);

  // Leaving the tab (or locking the phone) silences immediately.
  useEffect(() => {
    const onVis = () => { if (!pageVisible()) controller.stop(); };
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

  const refreshStatus = useCallback(() => setStatusNonce((n) => n + 1), []);
  useEffect(() => () => hybrid?.dispose(), [hybrid]);

  const stop = useCallback(() => controller.stop(), [controller]);

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
    engine.speak(TEST_LINE, { rate: prefsRef.current.rate, voiceId: voiceRef.current?.id ?? null });
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
    testVoice,
    serverStatus,
    neural: !!hybrid && hybrid.server.available && voice?.engine === 'neural',
    refreshStatus,
  }), [engine, hybrid, prefs, speaking, voices, voice, setVoiceOn, setChimeOn, setVoiceId, setRate, stop, testVoice, serverStatus, refreshStatus]);
}
