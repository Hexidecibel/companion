import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HeraldTransport } from '../services/heraldTransport';
import type { HeraldVoiceStatus } from '../types/herald';
import { getMicCapture, micUnavailableReason } from '../services/voice/micCapture';
import { VoiceInputController, type VoiceInputSource, type VoiceInputState } from '../services/voice/voiceInput';
import { VadListener } from '../services/voice/vadListener';
import { VoiceAutomation } from '../services/voice/voiceAutomation';
import { playChime } from '../services/tts/chime';
import { voiceCopy } from '../services/voice/platformCopy';
import { DEFAULT_BRIEF_CHORD, DEFAULT_CHORD, formatChord, isChordRelease, matchesChordDown, parseChord, shouldStartSpacePtt } from '../services/voice/hotkeys';

const PREFS_KEY = 'herald_voice_input_prefs';

export type InterruptSensitivity = 'low' | 'normal' | 'high';

export interface VoiceInputPrefs {
  /** Put the transcript in the composer instead of sending it. */
  reviewBeforeSend: boolean;
  /** Hold Space in an empty, focused composer to talk. */
  spaceToTalk: boolean;
  /** Global hold-to-talk chord, e.g. "Ctrl+Shift+Space". */
  chord: string;
  /** Global one-press "brief me" chord, e.g. "Ctrl+Shift+B". */
  briefChord: string;
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
  briefChord: DEFAULT_BRIEF_CHORD,
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
      briefChord: typeof p.briefChord === 'string' && parseChord(p.briefChord) ? p.briefChord : DEFAULT_INPUT_PREFS.briefChord,
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
  /** Always 'voice': an auto-sent transcript is a spoken message (shorter replies). */
  mode: 'voice';
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
  briefChordLabel: string;
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
  /** Microphone permission already granted (interrupt / hands-free need it). */
  micGranted: boolean;
  /** Wake word can be used (service has it loaded). */
  handsFreeAvailable: boolean;
  /** Hands-free is listening for "Hey Jarvis" on this device right now. */
  handsFreeActive: boolean;
  /** Why hands-free is on but not listening (tab hidden, another device...). */
  handsFreeNote: string | null;
  /** Toggle hands-free (call from a click: it may prompt for the mic). */
  setHandsFree: (on: boolean) => void;
  /**
   * Remote trigger: capture one utterance, ending on the VAD, and send it as a
   * voice turn (never through the composer, so a draft is left alone). Resolves
   * null once listening, else why not (the caller plays the error tone).
   */
  listen: () => Promise<string | null>;
  /** Anything capturing right now (push-to-talk, VAD utterance, trigger listen). */
  isCapturing: () => boolean;
}

export interface VoiceInputHost {
  getTransport: () => HeraldTransport | null;
  connected: boolean;
  serverStatus: HeraldVoiceStatus | null;
  /** Barge-in: stop Herald speaking. */
  stopSpeech: () => void;
  /** Bring the Herald panel up (global chord from anywhere). */
  openPanel: () => void;
  /** Herald is speaking (arms voice interrupt). */
  speaking: boolean;
  /**
   * Every transcript passes through here first (push-to-talk, talking over
   * Herald, hands-free). Returns null when it was a voice command that has been
   * handled, else the text to send on as a message (e.g. with "Hey Jarvis" cut).
   */
  onVoiceTranscript?: (text: string, source: VoiceInputSource) => string | null;
  /** The "brief me" chord was pressed. */
  briefMe?: () => void;
  /**
   * Send a remote-trigger transcript straight to Herald as a voice turn. Without
   * it, trigger transcripts go through the composer like any other.
   */
  sendVoice?: (text: string) => void;
  /**
   * Another device holds control by hand (its label): hands-free pauses here
   * and resumes when control comes back. Null / absent: not paused.
   */
  pausedBy?: string | null;
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
        onTranscript: (text, source) => {
          const hook = hostRef.current.onVoiceTranscript;
          const rest = hook ? hook(text, source) : text;
          if (!rest) return;
          // Remote trigger / desktop global hold-to-talk: the user is somewhere else (mid-game), so it goes
          // straight out as a voice turn. The composer (and any draft in it) is
          // never touched.
          const direct = hostRef.current.sendVoice;
          if ((source === 'trigger' || source === 'global') && direct) {
            direct(rest);
            return;
          }
          seq.current += 1;
          setTranscript({ id: seq.current, text: rest, autoSend: !prefsRef.current.reviewBeforeSend, mode: 'voice' });
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
    unavailableReason = voiceCopy().micDenied;
  }
  const available = unavailableReason === null;
  const availableRef = useRef(available);
  availableRef.current = available;

  // Mic permission, without prompting: Permissions API where available, else
  // learned from the first push-to-talk.
  const [permGranted, setPermGranted] = useState(false);
  useEffect(() => {
    let status: PermissionStatus | null = null;
    let cancelled = false;
    const q = navigator.permissions?.query?.({ name: 'microphone' as PermissionName });
    q?.then((st) => {
      if (cancelled) return;
      status = st;
      setPermGranted(st.state === 'granted');
      st.onchange = () => setPermGranted(st.state === 'granted');
    }).catch(() => {});
    return () => {
      cancelled = true;
      if (status) status.onchange = null;
    };
  }, []);
  const micGranted = permGranted || state.permission === 'granted';

  // Voice interrupt (barge-in) and hands-free wake word over the VAD.
  const automation = useMemo(
    () =>
      new VoiceAutomation({
        vad: new VadListener(getMicCapture()),
        input: controller,
        stopSpeech: () => hostRef.current.stopSpeech(),
        getTransport: () => hostRef.current.getTransport(),
        onWake: () => playChime('wake', 0.06),
        onError: (m) => {
          controller.fail(m);
          // Never show "listening" when we cannot: drop hands-free on this device.
          setPrefs((p) => (p.handsFree ? { ...p, handsFree: false } : p));
        },
      }),
    [controller],
  );
  useEffect(() => () => automation.dispose(), [automation]);

  // Hands-free: per-device pref, paused while the tab is hidden (unless the
  // user opted in), and only one device at a time (the daemon arbitrates).
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  const handsFreeAvailable = available && !!host.serverStatus?.wake.ready;
  const pausedBy = host.pausedBy ?? null;
  const wantHandsFree = prefs.handsFree && handsFreeAvailable && (visible || prefs.handsFreeInBackground) && !pausedBy;
  const [owner, setOwner] = useState(false);
  useEffect(() => {
    const t = hostRef.current.getTransport();
    if (!t || !host.connected) {
      setOwner(false);
      return;
    }
    let cancelled = false;
    if (wantHandsFree) {
      t.request('herald_handsfree', { on: true }, 5000)
        .then((res) => { if (!cancelled) setOwner(!!res.success && !!(res.payload as { owner?: boolean })?.owner); })
        .catch(() => { if (!cancelled) setOwner(false); });
    } else {
      setOwner(false);
      t.request('herald_handsfree', { on: false }, 5000).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [wantHandsFree, host.connected]);
  const handsFreeActive = wantHandsFree && owner;

  // Per-client daemon events -> automation; revocation turns hands-free off here.
  useEffect(() => {
    const t = hostRef.current.getTransport();
    if (!t?.onVoiceEvent || !host.connected) return;
    return t.onVoiceEvent((ev) => {
      if (ev.kind === 'handsfree_revoked') {
        setOwner(false);
        setPrefs((p) => ({ ...p, handsFree: false }));
        controller.fail('Hands-free moved to another device');
        return;
      }
      automation.onVoiceEvent(ev);
    });
  }, [host.connected, automation, controller]);

  useEffect(() => {
    automation.update({
      available,
      micGranted,
      interrupt: prefs.interrupt,
      sensitivity: prefs.sensitivity,
      speaking: host.speaking,
      handsFree: handsFreeActive,
    });
  }, [automation, available, micGranted, prefs.interrupt, prefs.sensitivity, host.speaking, handsFreeActive]);

  let handsFreeNote: string | null = null;
  if (prefs.handsFree && !handsFreeActive) {
    if (pausedBy) handsFreeNote = `Paused: ${pausedBy} has control`;
    else if (!handsFreeAvailable) handsFreeNote = unavailableReason ?? 'Wake word not loaded on the hub';
    else if (!visible && !prefs.handsFreeInBackground) handsFreeNote = voiceCopy().pausedHidden;
    else handsFreeNote = 'Starting…';
  }

  const setHandsFree = useCallback((on: boolean) => {
    if (!on) {
      setPrefs((p) => ({ ...p, handsFree: false }));
      return;
    }
    // Inside the click: may show the browser's mic prompt.
    getMicCapture()
      .acquire()
      .then(() => setPrefs((p) => ({ ...p, handsFree: true })))
      .catch((err: unknown) => controller.fail((err as Error)?.message || 'Could not open the microphone'));
  }, [controller]);

  const chord = useMemo(() => parseChord(prefs.chord) ?? parseChord(DEFAULT_CHORD)!, [prefs.chord]);
  const briefChord = useMemo(() => parseChord(prefs.briefChord) ?? parseChord(DEFAULT_BRIEF_CHORD)!, [prefs.briefChord]);

  // Global one-press "brief me". Exact match only, so typing is never affected.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!matchesChordDown(e, briefChord)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      hostRef.current.briefMe?.();
    };
    window.addEventListener('keydown', down, true);
    return () => window.removeEventListener('keydown', down, true);
  }, [briefChord]);

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
  const cancel = useCallback(() => {
    automation.cancelListen();
    controller.cancel();
  }, [automation, controller]);

  const micGrantedRef = useRef(micGranted);
  micGrantedRef.current = micGranted;
  const listen = useCallback(async (): Promise<string | null> => {
    if (!availableRef.current) return unavailableRef.current ?? 'Voice input unavailable';
    // A hidden tab must never be the place a permission prompt appears (nobody
    // would see it). Permission granted earlier works in the background.
    const hidden = typeof document !== 'undefined' && document.visibilityState !== 'visible';
    if (hidden && !micGrantedRef.current) {
      return voiceCopy().micNotYetAllowed;
    }
    try {
      return (await automation.listen()) ? null : 'Already listening';
    } catch (err) {
      return (err as Error)?.message || 'Could not open the microphone';
    }
  }, [automation]);
  const isCapturing = useCallback(
    () => controller.state.phase !== 'idle' || automation.listenActive,
    [automation, controller],
  );

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
    briefChordLabel: formatChord(briefChord),
    start,
    stop,
    cancel,
    onComposerKeyDown,
    onComposerKeyUp,
    transcript,
    consumeTranscript,
    controller,
    micGranted,
    handsFreeAvailable,
    handsFreeActive,
    handsFreeNote,
    setHandsFree,
    listen,
    isCapturing,
  }), [available, unavailableReason, state, prefs, setPref, chord, briefChord, start, stop, cancel, onComposerKeyDown, onComposerKeyUp, transcript, consumeTranscript, controller, micGranted, handsFreeAvailable, handsFreeActive, handsFreeNote, setHandsFree, listen, isCapturing]);
}
