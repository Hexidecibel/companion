import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HeraldTransport } from '../services/heraldTransport';
import type { HeraldVoiceStatus } from '../types/herald';
import { getMicCapture, micUnavailableReason } from '../services/voice/micCapture';
import { VoiceInputController, type VoiceInputSource, type VoiceInputState } from '../services/voice/voiceInput';
import { VadListener } from '../services/voice/vadListener';
import { FOLLOW_UP_MS, VoiceAutomation, type FollowUpWindow } from '../services/voice/voiceAutomation';
import { useHeraldSetupState } from '../services/heraldSetup/setupStore';
import type { ProfileId } from '../services/heraldSetup/profiles';
import { playChime } from '../services/tts/chime';
import { voiceCopy } from '../services/voice/platformCopy';
import type { SpokenLog } from '../services/voice/echoGuard';
import { VoiceLoopBreaker } from '../services/voice/voiceLoopBreaker';
import { interruptDefault } from '../services/voice/headphones';
import {
  getAudioEnvironment,
  getBargeInDecision,
  onAudioEnvironmentChange,
  onAudioNotice,
  onBargeInModeChange,
  reportEchoHeard,
  reportFalseBargeIn,
  type AudioEnvironment,
  type AudioNotice,
} from '../services/voice/audioEnvironment';
import type { BargeInDecision } from '../services/voice/bargeInMode';
import { initNativeAudio, setPreferBuiltInMic } from '../services/voice/nativeAudio';
import { nativePlatform } from '../utils/platform';
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
  /**
   * Talking over Herald stops it and sends what you said (needs mic permission).
   * In `prefs` returned by the hook this is the EFFECTIVE value (see
   * `interruptOrigin`): off by default unless headphones are detected.
   */
  interrupt: boolean;
  /**
   * Where `interrupt` comes from: the user's own choice, a value saved by an
   * older build (honoured in browsers, ignored in the desktop app), or `auto`
   * (on only with headphones detected).
   */
  interruptOrigin: 'explicit' | 'saved' | 'auto';
  sensitivity: InterruptSensitivity;
  /** "Hey Jarvis" wake word (always listening while on). Per device. */
  handsFree: boolean;
  /** Keep hands-free on while the tab is hidden. */
  handsFreeInBackground: boolean;
  /**
   * With a Bluetooth headset as the default mic, listen with the built-in (or
   * another non-Bluetooth) mic instead, so the headphones stay in music quality
   * (A2DP) rather than dropping to a phone call (HFP).
   */
  builtInMicWithBluetooth: boolean;
  /**
   * Follow-up window: after Herald speaks its answer to something you SAID,
   * keep listening a few seconds for a follow-up (no wake word, no key).
   * null = automatic (on with headphones detected); profiles set it explicitly.
   */
  followUp: boolean | null;
  /** How long the follow-up window stays open (ms). */
  followUpMs: number;
}

export const DEFAULT_INPUT_PREFS: VoiceInputPrefs = {
  reviewBeforeSend: false,
  spaceToTalk: true,
  chord: DEFAULT_CHORD,
  briefChord: DEFAULT_BRIEF_CHORD,
  interrupt: false,
  interruptOrigin: 'auto',
  sensitivity: 'normal',
  handsFree: false,
  handsFreeInBackground: false,
  builtInMicWithBluetooth: true,
  followUp: null,
  followUpMs: FOLLOW_UP_MS,
};

/** The follow-up window when the user never chose: on with headphones, off in Gaming / Desk. */
export function autoFollowUp(headphones: boolean | null, profile: ProfileId | null): boolean {
  if (profile === 'gaming' || profile === 'desk') return false;
  return headphones === true;
}

export function loadInputPrefs(): VoiceInputPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_INPUT_PREFS;
    const p = JSON.parse(raw) as Partial<VoiceInputPrefs> & { interruptExplicit?: unknown };
    const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
    const hasInterrupt = typeof p.interrupt === 'boolean';
    return {
      reviewBeforeSend: bool(p.reviewBeforeSend, DEFAULT_INPUT_PREFS.reviewBeforeSend),
      spaceToTalk: bool(p.spaceToTalk, DEFAULT_INPUT_PREFS.spaceToTalk),
      chord: typeof p.chord === 'string' && parseChord(p.chord) ? p.chord : DEFAULT_INPUT_PREFS.chord,
      briefChord: typeof p.briefChord === 'string' && parseChord(p.briefChord) ? p.briefChord : DEFAULT_INPUT_PREFS.briefChord,
      interrupt: bool(p.interrupt, DEFAULT_INPUT_PREFS.interrupt),
      interruptOrigin: hasInterrupt ? (p.interruptExplicit === true ? 'explicit' : 'saved') : 'auto',
      sensitivity: p.sensitivity === 'low' || p.sensitivity === 'high' ? p.sensitivity : 'normal',
      handsFree: bool(p.handsFree, false),
      handsFreeInBackground: bool(p.handsFreeInBackground, false),
      builtInMicWithBluetooth: bool(p.builtInMicWithBluetooth, true),
      followUp: typeof p.followUp === 'boolean' ? p.followUp : null,
      followUpMs: typeof p.followUpMs === 'number' && p.followUpMs >= 2000 && p.followUpMs <= 15000 ? p.followUpMs : FOLLOW_UP_MS,
    };
  } catch {
    return DEFAULT_INPUT_PREFS;
  }
}

function saveInputPrefs(p: VoiceInputPrefs): void {
  try {
    const { interruptOrigin, interrupt, ...rest } = p;
    // `auto` is not saved: the default can still follow the headphones later.
    const stored = interruptOrigin === 'auto' ? rest : { ...rest, interrupt, interruptExplicit: interruptOrigin === 'explicit' };
    localStorage.setItem(PREFS_KEY, JSON.stringify(stored));
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
  /**
   * Speech kept sending on its own with nobody touching anything: probably
   * Herald hearing itself. Auto-send is paused (transcripts wait in the composer).
   */
  echoPaused: boolean;
  /** Resume auto-send after an echo pause. */
  resumeAutoSend: () => void;
  /** Headphones detected (true), speakers (false), unknown (null). */
  headphones: boolean | null;
  /** Where Herald plays / listens and how echo is cancelled. */
  audioEnv: AudioEnvironment | null;
  /** How talking over Herald is detected right now, and why. */
  bargeIn: BargeInDecision;
  /** A short-lived note about the microphone (switched, disconnected, Bluetooth-only). */
  audioNotice: string | null;
  /** The follow-up window is on for this device (effective: `prefs.followUp` or automatic). */
  followUpOn: boolean;
  /** Open follow-up window (counting down), or null. */
  followUpWindow: FollowUpWindow | null;
  /**
   * Open the follow-up window now, if allowed: setting on, voice input usable,
   * mic already allowed (never prompts), no echo pause, nothing capturing.
   */
  openFollowUp: () => boolean;
  /** Close the follow-up window without listening further. */
  cancelFollowUp: () => void;
}

/** Voice sources nobody pressed anything for: these can loop on Herald's own voice. */
const HANDS_OFF_SOURCES: ReadonlySet<VoiceInputSource> = new Set(['interrupt', 'wake', 'followup']);
/** Push-to-talk / hotkeys: deliberate, so only a long echo is dropped. */
const DELIBERATE_SOURCES: ReadonlySet<VoiceInputSource> = new Set(['button', 'space', 'chord', 'global']);

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
  /** What Herald said recently: transcripts of its own voice are dropped. */
  spokenLog?: SpokenLog;
  /**
   * The exact confirm phrase of a pending red card ("confirm deploy"): skips
   * the self-echo guard (Herald's prompt says the phrase; the daemon does its
   * own device / timing / echo checks). See confirmPhrase.isPendingConfirmPhrase.
   */
  isPendingConfirm?: (text: string) => boolean;
}

export function useHeraldVoiceInput(host: VoiceInputHost): HeraldVoiceInput {
  const hostRef = useRef(host);
  hostRef.current = host;
  const [prefs, setPrefs] = useState<VoiceInputPrefs>(loadInputPrefs);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const [transcript, setTranscript] = useState<InjectedTranscript | null>(null);
  const seq = useRef(0);
  const breaker = useMemo(() => new VoiceLoopBreaker(), []);
  const [echoPaused, setEchoPaused] = useState(false);
  useEffect(() => breaker.subscribe(setEchoPaused), [breaker]);
  // Any keyboard, mouse or touch use means a person is here (resumes auto-send).
  useEffect(() => {
    const onUse = () => breaker.noteInteraction();
    window.addEventListener('keydown', onUse, true);
    window.addEventListener('pointerdown', onUse, true);
    window.addEventListener('touchstart', onUse, true);
    return () => {
      window.removeEventListener('keydown', onUse, true);
      window.removeEventListener('pointerdown', onUse, true);
      window.removeEventListener('touchstart', onUse, true);
    };
  }, [breaker]);

  const controller = useMemo(
    () =>
      new VoiceInputController({
        mic: getMicCapture(),
        getTransport: () => hostRef.current.getTransport(),
        onBargeIn: () => hostRef.current.stopSpeech(),
        onTranscript: (text, source) => {
          // Herald's own voice through the speakers: drop it, keep listening.
          const log = hostRef.current.spokenLog;
          if (!hostRef.current.isPendingConfirm?.(text) && log?.isEcho(text, { minTokens: DELIBERATE_SOURCES.has(source) ? 3 : 1 })) {
            console.debug(`Herald voice: dropped likely self-echo (${source}):`, JSON.stringify(text));
            return;
          }
          // Hotkeys, push-to-talk, remote triggers: someone deliberately asked.
          if (!HANDS_OFF_SOURCES.has(source)) breaker.noteInteraction();
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
          // A follow-up is a voice turn too (the panel may be closed), unless the
          // user reviews before sending or the loop breaker paused auto-send.
          if (source === 'followup' && direct && !prefsRef.current.reviewBeforeSend) {
            if (breaker.allowSend()) {
              direct(rest);
              return;
            }
            console.debug('Herald voice: follow-up held for review (possible echo loop)');
            seq.current += 1;
            setTranscript({ id: seq.current, text: rest, autoSend: false, mode: 'voice' });
            return;
          }
          seq.current += 1;
          let autoSend = !prefsRef.current.reviewBeforeSend;
          // Loop breaker: hands-off sends in a burst wait for the user instead.
          if (autoSend && HANDS_OFF_SOURCES.has(source) && !breaker.allowSend()) {
            autoSend = false;
            console.debug('Herald voice: auto-send paused (possible echo loop)');
          }
          setTranscript({ id: seq.current, text: rest, autoSend, mode: 'voice' });
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

  // Where Herald plays and listens (labels need mic permission; native route
  // info and measured echo beat labels). Re-detected on device changes.
  const [audioEnv, setAudioEnv] = useState<AudioEnvironment | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getAudioEnvironment().then((e) => { if (!cancelled) setAudioEnv(e); }).catch(() => {});
    const off = onAudioEnvironmentChange((e) => setAudioEnv(e));
    return () => {
      cancelled = true;
      off();
    };
  }, [micGranted]);
  const headphones: boolean | null = !audioEnv
    ? null
    : audioEnv.output === 'headphones' || audioEnv.output === 'bluetooth-headphones'
      ? true
      : audioEnv.output === 'speakers'
        ? false
        : audioEnv.input === 'headset' || audioEnv.input === 'bluetooth-headset'
          ? true
          : null;
  const [bargeIn, setBargeIn] = useState<BargeInDecision>(getBargeInDecision);
  useEffect(() => onBargeInModeChange(setBargeIn), []);

  // Native apps: route info, and on Android the native microphone.
  useEffect(() => initNativeAudio(), []);
  // "Use built-in mic with Bluetooth headphones" -> the shared mic (and iOS's session).
  useEffect(() => {
    getMicCapture().setMicPrefs({ avoidBluetoothMic: prefs.builtInMicWithBluetooth });
    void setPreferBuiltInMic(prefs.builtInMicWithBluetooth);
  }, [prefs.builtInMicWithBluetooth]);

  // Microphone notices: tell the user when the mic changed under them,
  // especially mid-utterance (the capture carries on with the new mic).
  const [audioNotice, setAudioNotice] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const show = (text: string) => {
      setAudioNotice(text);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setAudioNotice(null), 8000);
    };
    const off = onAudioNotice((n: AudioNotice) => {
      const busy = controller.state.phase !== 'idle';
      if (n.kind === 'mic-lost') {
        show(`Microphone disconnected: ${n.label || 'the mic'}`);
        // The capture carries on with the next microphone (or ends with what it has).
        if (busy) controller.fail(`Microphone disconnected${n.label ? `: ${n.label}` : ''}`);
      } else if (n.kind === 'mic-switched' && n.reason !== 'mode') {
        show(`Listening with ${n.label || 'another microphone'}`);
        if (busy && n.reason === 'lost') controller.fail(`Mic disconnected: still listening with ${n.label || 'another microphone'}`);
      } else if (n.kind === 'only-bluetooth-mic') {
        show(`Only your Bluetooth headset has a mic (${n.label}): while Herald listens, its audio drops to call quality.`);
      }
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [controller]);

  const nativeDesktop = useMemo(() => nativePlatform() === 'desktop', []);
  // Talk-over is safe by default with headphones, or once the echo check (or
  // Herald's own replies) proved the canceller removes Herald from the mic.
  const interrupt = interruptDefault({
    explicit: prefs.interruptOrigin === 'explicit' ? prefs.interrupt : undefined,
    legacy: prefs.interruptOrigin === 'saved' ? prefs.interrupt : undefined,
    nativeDesktop,
    headphones: headphones === true || bargeIn.mode === 'vad' ? true : headphones,
  });

  // Voice interrupt (barge-in) and hands-free wake word over the VAD.
  const [followUpWindow, setFollowUpWindow] = useState<FollowUpWindow | null>(null);
  const automation = useMemo(
    () =>
      new VoiceAutomation({
        vad: new VadListener(getMicCapture()),
        input: controller,
        stopSpeech: () => hostRef.current.stopSpeech(),
        getTransport: () => hostRef.current.getTransport(),
        isEcho: (text) => hostRef.current.spokenLog?.isEcho(text) ?? false,
        stripEcho: (text) => hostRef.current.spokenLog?.stripEcho(text) ?? text,
        isBargeIn: (text) => hostRef.current.spokenLog?.isBargeIn(text) ?? true,
        onWake: () => playChime('wake', 0.06),
        raw: () => getMicCapture().rawAudio(),
        onEchoHeard: () => reportEchoHeard(),
        onFalseBargeIn: () => reportFalseBargeIn(),
        onBargeInLatency: (ms, mode) => console.info(`Herald voice: talk-over stopped Herald after ${Math.round(ms)} ms (${mode})`),
        onFollowUp: (w) => setFollowUpWindow(w),
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
      interrupt,
      sensitivity: prefs.sensitivity,
      speaking: host.speaking,
      handsFree: handsFreeActive,
      bargeIn: bargeIn.mode,
    });
  }, [automation, available, micGranted, interrupt, prefs.sensitivity, host.speaking, handsFreeActive, bargeIn.mode]);

  // Follow-up window: explicit choice (profiles set it), else on with headphones,
  // never by itself in Gaming (Discord voices) or Desk speakers (a profile chosen
  // before this setting existed has never set it).
  const profile = useHeraldSetupState().profile;
  const followUpOn = prefs.followUp ?? autoFollowUp(headphones, profile);
  const followUpRef = useRef({ on: followUpOn, ms: prefs.followUpMs, micGranted, echoPaused });
  followUpRef.current = { on: followUpOn, ms: prefs.followUpMs, micGranted, echoPaused };
  const openFollowUp = useCallback((): boolean => {
    const f = followUpRef.current;
    if (!f.on || !availableRef.current || !f.micGranted || f.echoPaused) return false;
    return automation.followUp(f.ms);
  }, [automation]);
  const cancelFollowUp = useCallback(() => automation.cancelFollowUp(), [automation]);
  // Anything else starting a capture (push-to-talk, a hotkey) closes the window.
  useEffect(() => controller.subscribe((st) => {
    if (st.phase !== 'idle' && st.source !== 'followup') automation.cancelFollowUp();
  }), [controller, automation]);
  // Turning it off closes an open window.
  useEffect(() => {
    if (!followUpOn) automation.cancelFollowUp();
  }, [followUpOn, automation]);

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
    automation.cancelFollowUp();
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
    setPrefs((p) => (key === 'interrupt' ? { ...p, interrupt: value as boolean, interruptOrigin: 'explicit' } : { ...p, [key]: value }));
  }, []);
  const resumeAutoSend = useCallback(() => breaker.resume(), [breaker]);
  const effectivePrefs = useMemo(() => ({ ...prefs, interrupt }), [prefs, interrupt]);

  const consumeTranscript = useCallback((id: number) => {
    setTranscript((t) => (t && t.id === id ? null : t));
  }, []);

  return useMemo(() => ({
    available,
    unavailableReason,
    state,
    prefs: effectivePrefs,
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
    echoPaused,
    resumeAutoSend,
    headphones,
    audioEnv,
    bargeIn,
    audioNotice,
    followUpOn,
    followUpWindow,
    openFollowUp,
    cancelFollowUp,
  }), [followUpOn, followUpWindow, openFollowUp, cancelFollowUp, echoPaused, resumeAutoSend, headphones, audioEnv, bargeIn, audioNotice, available, unavailableReason, state, effectivePrefs, setPref, chord, briefChord, start, stop, cancel, onComposerKeyDown, onComposerKeyUp, transcript, consumeTranscript, controller, micGranted, handsFreeAvailable, handsFreeActive, handsFreeNote, setHandsFree, listen, isCapturing]);
}
