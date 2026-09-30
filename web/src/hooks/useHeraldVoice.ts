import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HeraldEventListener } from './useHerald';
import type { TtsEngine, TtsVoice } from '../services/tts/types';
import { getWebSpeechEngine } from '../services/tts/webSpeechEngine';
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
}

const TEST_LINE = "Hi, I'm Herald. Two sessions finished, and one is waiting on you.";

/**
 * Voice replies + inbox chimes, wired to Herald's raw event stream.
 * `subscribeEvents` must have stable identity; `hostId` changes reset state.
 */
export function useHeraldVoice(subscribeEvents: (l: HeraldEventListener) => () => void, hostId: string | null, engineOverride?: TtsEngine): HeraldVoice {
  const engine = useMemo(() => engineOverride ?? getWebSpeechEngine(), [engineOverride]);
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
  }), [engine, prefs, speaking, voices, voice, setVoiceOn, setChimeOn, setVoiceId, setRate, stop, testVoice]);
}
