import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HeraldTransport } from '../services/heraldTransport';
import type { HeraldVoiceStatus } from '../types/herald';
import { getMicCapture, micUnavailableReason } from '../services/voice/micCapture';
import { VoiceInputController, type VoiceInputSource, type VoiceInputState } from '../services/voice/voiceInput';
import { DEFAULT_CHORD, formatChord, isChordRelease, matchesChordDown, parseChord, shouldStartSpacePtt } from '../services/voice/hotkeys';

const PREFS_KEY = 'herald_voice_input_prefs';

export type InterruptSensitivity = 'low' | 'normal' | 'high';

export interface VoiceInputPrefs {
  /** Put the transcript in the composer instead of sending it. */
  reviewBeforeSend: boolean;
  /** Hold Space in an empty, focused composer to talk. */
  spaceToTalk: boolean;
  /** Global hold-to-talk chord, e.g. "Ctrl+Shift+Space". */
  chord: string;
  /** Talking over Herald stops it and sends what you said (needs mic permission). */
  interrupt: boolean;
  sensitivity: InterruptSensitivity;
  /** "Hey Jarvis" wake word (always listening while on). Per device. */
  handsFree: boolean;
  /** Keep hands-free on while the tab is hidden. */
  handsFreeInBackground: boolean;
}

export const DEFAULT_INPUT_PREFS: VoiceInputPrefs = {
  reviewBeforeSend: false,
  spaceToTalk: true,
  chord: DEFAULT_CHORD,
  interrupt: true,
  sensitivity: 'normal',
  handsFree: false,
  handsFreeInBackground: false,
};

export function loadInputPrefs(): VoiceInputPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_INPUT_PREFS;
    const p = JSON.parse(raw) as Partial<VoiceInputPrefs>;
    const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
    return {
      reviewBeforeSend: bool(p.reviewBeforeSend, DEFAULT_INPUT_PREFS.reviewBeforeSend),
      spaceToTalk: bool(p.spaceToTalk, DEFAULT_INPUT_PREFS.spaceToTalk),
      chord: typeof p.chord === 'string' && parseChord(p.chord) ? p.chord : DEFAULT_INPUT_PREFS.chord,
      interrupt: bool(p.interrupt, DEFAULT_INPUT_PREFS.interrupt),
      sensitivity: p.sensitivity === 'low' || p.sensitivity === 'high' ? p.sensitivity : 'normal',
      handsFree: bool(p.handsFree, false),
      handsFreeInBackground: bool(p.handsFreeInBackground, false),
    };
  } catch {
    return DEFAULT_INPUT_PREFS;
  }
}

function saveInputPrefs(p: VoiceInputPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // storage unavailable
  }
}

export interface InjectedTranscript {
  id: number;
  text: string;
  autoSend: boolean;
}

export interface HeraldVoiceInput {
  /** Voice input can be used right now. */
  available: boolean;
  /** Why not, when unavailable. */
  unavailableReason: string | null;
  state: VoiceInputState;
  prefs: VoiceInputPrefs;
  setPref: <K extends keyof VoiceInputPrefs>(key: K, value: VoiceInputPrefs[K]) => void;
  chordLabel: string;
  start: (source: VoiceInputSource) => void;
  stop: () => void;
  cancel: () => void;
  /** Composer key hooks: return true when the key was consumed by push-to-talk. */
  onComposerKeyDown: (e: KeyboardEvent, composerValue: string) => boolean;
  onComposerKeyUp: (e: KeyboardEvent) => boolean;
  /** Latest transcript for the composer (consume by id). */
  transcript: InjectedTranscript | null;
  consumeTranscript: (id: number) => void;
  /** Controller, for the VAD / wake layers. */
  controller: VoiceInputController;
}

export interface VoiceInputHost {
  getTransport: () => HeraldTransport | null;
  connected: boolean;
  serverStatus: HeraldVoiceStatus | null;
  /** Barge-in: stop Herald speaking. */
  stopSpeech: () => void;
  /** Bring the Herald panel up (global chord from anywhere). */
  openPanel: () => void;
}

export function useHeraldVoiceInput(host: VoiceInputHost): HeraldVoiceInput {
  const hostRef = useRef(host);
  hostRef.current = host;
  const [prefs, setPrefs] = useState<VoiceInputPrefs>(loadInputPrefs);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const [transcript, setTranscript] = useState<InjectedTranscript | null>(null);
  const seq = useRef(0);

  const controller = useMemo(
    () =>
      new VoiceInputController({
        mic: getMicCapture(),
        getTransport: () => hostRef.current.getTransport(),
        onBargeIn: () => hostRef.current.stopSpeech(),
        onTranscript: (text) => {
          seq.current += 1;
          setTranscript({ id: seq.current, text, autoSend: !prefsRef.current.reviewBeforeSend });
        },
      }),
    [],
  );
  const [state, setState] = useState<VoiceInputState>(controller.state);
  useEffect(() => controller.subscribe(setState), [controller]);
  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => saveInputPrefs(prefs), [prefs]);

  const micReason = useMemo(() => micUnavailableReason(), []);
  let unavailableReason: string | null = null;
  if (micReason) unavailableReason = micReason;
  else if (!host.connected) unavailableReason = 'Not connected to the Herald host';
  else if (!host.serverStatus) unavailableReason = 'Checking voice service';
  else if (!host.serverStatus.available || !host.serverStatus.stt.ready) {
    unavailableReason = 'Voice service offline on the hub (bin/herald-voice start)';
  } else if (state.permission === 'denied') {
    unavailableReason = "Microphone blocked. Allow it in the browser's site settings.";
  }
  const available = unavailableReason === null;
  const availableRef = useRef(available);
  availableRef.current = available;

  const chord = useMemo(() => parseChord(prefs.chord) ?? parseChord(DEFAULT_CHORD)!, [prefs.chord]);

  const unavailableRef = useRef(unavailableReason);
  unavailableRef.current = unavailableReason;
  const start = useCallback((source: VoiceInputSource) => {
    if (!availableRef.current) {
      controller.fail(unavailableRef.current ?? 'Voice input unavailable');
      return;
    }
    void controller.start(source);
  }, [controller]);
  const stop = useCallback(() => void controller.stop(), [controller]);
  const cancel = useCallback(() => controller.cancel(), [controller]);

  // Global hold-to-talk chord. Exact match only; everything else passes through.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!matchesChordDown(e, chord)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      hostRef.current.openPanel();
      start('chord');
    };
    const up = (e: KeyboardEvent) => {
      if (controller.state.source === 'chord' && isChordRelease(e, chord)) {
        e.preventDefault();
        void controller.stop();
      }
    };
    // Lost focus mid-hold (alt-tab): the key-up will never arrive. Send what we have.
    const blur = () => {
      const src = controller.state.source;
      if (src === 'chord' || src === 'space') void controller.stop();
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', blur);
    };
  }, [chord, controller, start]);

  const onComposerKeyDown = useCallback((e: KeyboardEvent, value: string) => {
    if (controller.state.source === 'space' && e.code === 'Space') {
      e.preventDefault(); // swallow auto-repeat while held
      return true;
    }
    if (!availableRef.current) return false;
    if (!shouldStartSpacePtt(e, { enabled: prefsRef.current.spaceToTalk, composerEmpty: value.trim() === '', isComposing: e.isComposing })) {
      return false;
    }
    if (controller.state.phase !== 'idle') return false;
    e.preventDefault();
    start('space');
    return true;
  }, [controller, start]);

  const onComposerKeyUp = useCallback((e: KeyboardEvent) => {
    if (controller.state.source === 'space' && e.code === 'Space') {
      e.preventDefault();
      void controller.stop();
      return true;
    }
    return false;
  }, [controller]);

  const setPref = useCallback(<K extends keyof VoiceInputPrefs>(key: K, value: VoiceInputPrefs[K]) => {
    setPrefs((p) => ({ ...p, [key]: value }));
  }, []);

  const consumeTranscript = useCallback((id: number) => {
    setTranscript((t) => (t && t.id === id ? null : t));
  }, []);

  return useMemo(() => ({
    available,
    unavailableReason,
    state,
    prefs,
    setPref,
    chordLabel: formatChord(chord),
    start,
    stop,
    cancel,
    onComposerKeyDown,
    onComposerKeyUp,
    transcript,
    consumeTranscript,
    controller,
  }), [available, unavailableReason, state, prefs, setPref, chord, start, stop, cancel, onComposerKeyDown, onComposerKeyUp, transcript, consumeTranscript, controller]);
}
