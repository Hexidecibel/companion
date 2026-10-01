import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useConnections } from '../hooks/useConnections';
import { useHerald, type UseHeraldReturn } from '../hooks/useHerald';
import { useHeraldVoice, type HeraldVoice } from '../hooks/useHeraldVoice';
import { useHeraldVoiceInput, type HeraldVoiceInput } from '../hooks/useHeraldVoiceInput';
import { HERALD_DEMO_SERVER_ID, isHeraldDemo } from '../services/heraldTransport';
import { DEFAULT_DISPLAY_NAME, derivePresence, type HeraldPresence } from '../services/heraldReducer';
import { isMobileViewport } from '../utils/platform';
import { eventBus } from '../utils/eventBus';
import { routeVoiceTranscript } from '../services/voice/voiceCommandRouter';
import { detectVoiceConfirm, isPendingConfirmPhrase, runVoiceConfirm } from '../services/voice/confirmPhrase';
import { runUndo } from '../services/voice/voiceUndo';
import { matchShowCommand, stripWakeWord, type ShowCommand } from '../services/voice/voiceCommands';
import { localShowTarget, matchClarifyAnswer, runShowCommand, showLines, type ShowClarify } from '../services/voice/showCommand';
import type { HeraldActiveDevice, HeraldDeviceInfo, HeraldIntent } from '../types/herald';
import { TICK_VOLUME, playChime, startShimmer } from '../services/tts/chime';
import { FollowUpTracker } from '../services/voice/followUp';
import { TurnCues } from '../services/voice/turnCues';
import { setUserPronunciations } from '../services/tts/pronounce';
import { DeferredNotice, runHeraldTrigger, type TriggerActions } from '../services/voice/heraldTrigger';
import { useNativeHerald } from '../hooks/useNativeHerald';
import { useHeraldSetup, type HeraldSetupControl } from '../hooks/useHeraldSetup';
import { useHeraldOverlay } from '../hooks/useHeraldOverlay';
import { heraldSetupStore, overlayEnabled } from '../services/heraldSetup/setupStore';
import { shouldBringToFront, type FrontSource } from '../services/heraldSetup/overlay';
import { probeTrigger } from '../services/heraldSetup/triggerProbe';
import { tipsStore } from '../services/heraldSetup/tips';
import { bringToFront } from '../services/overlayBridge';
import { nativePlatform } from '../utils/platform';

const PANEL_OPEN_KEY = 'herald_panel_open';
const EMPTY: never[] = [];
/** A voice command waiting for the current turn to finish gives up after this. */
const INTENT_WAIT_MS = 30_000;
const HOST_KEY = 'herald_host_server_id';
const PIN_KEY = 'herald_device_pin';
/** How long "Now on <other device>" stays up after this device loses control. */
const HANDOFF_NOTE_MS = 8000;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode etc.) — preference just won't persist
  }
}

export interface HeraldHostOption {
  serverId: string;
  name: string;
  connected: boolean;
}

interface HeraldUiValue {
  /** Desktop docked panel (persisted). */
  panelOpen: boolean;
  /** Mobile full-screen view (not persisted). */
  screenOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  /** Increments whenever the composer should grab focus. */
  focusNonce: number;
  hostId: string | null;
  hostName: string;
  hostOptions: HeraldHostOption[];
  setHostId: (id: string) => void;
  demo: boolean;
}

/** Which device is active (tones, triggers, hands-free) and taking control of it. */
export interface HeraldDeviceControl {
  /** The hub reports devices (newer daemons). */
  supported: boolean;
  selfId: string | null;
  /** This device's name. */
  label: string;
  activeDevice: HeraldActiveDevice | null;
  devices: HeraldDeviceInfo[];
  /** This device is the active one (true on hubs without arbitration). */
  isActive: boolean;
  /** Another device holds control by hand: this one stands down (no hands-free). */
  controlledElsewhere: boolean;
  /** Claims from this device pin ("Keep on this device"). */
  keepPinned: boolean;
  setKeepPinned: (on: boolean) => void;
  takeControl: () => void;
  switchTo: (deviceId: string) => void;
  rename: (label: string) => void;
  /** "Now on <other device>" for a few seconds after losing control. */
  handoffNote: string | null;
}

export interface HeraldDataValue extends UseHeraldReturn {
  device: HeraldDeviceControl;
  /** One-press briefing on what is new (button, hotkey, "what's up"). */
  briefMe: () => void;
  displayName: string;
  presence: HeraldPresence;
  unheardCount: number;
  unheardBlocked: number;
  available: boolean;
}

const HeraldUiContext = createContext<HeraldUiValue | null>(null);
const HeraldDataContext = createContext<HeraldDataValue | null>(null);
const HeraldVoiceContext = createContext<HeraldVoice | null>(null);
const HeraldVoiceInputContext = createContext<HeraldVoiceInput | null>(null);
const HeraldSetupContext = createContext<HeraldSetupControl | null>(null);

/** "Hey Jarvis" / a trigger may bring the Companion window forward (setting; never in Gaming). */
function maybeBringToFront(source: FrontSource): void {
  const s = heraldSetupStore.get();
  if (shouldBringToFront({ enabled: s.bringToFront, profile: s.profile, platform: nativePlatform(), source })) void bringToFront();
}

/**
 * Two contexts on purpose: the UI context changes rarely (open/close, host),
 * the data context changes on every streamed token. Dashboard only consumes the
 * UI one so a streaming reply never re-renders the session view.
 */
export function HeraldProvider({ children }: { children: ReactNode }) {
  const demo = useMemo(() => isHeraldDemo(), []);
  const { snapshots } = useConnections();
  const [panelOpen, setPanelOpen] = useState(() => demo || readStorage(PANEL_OPEN_KEY) === '1');
  const [screenOpen, setScreenOpen] = useState(() => demo && isMobileViewport());
  const [focusNonce, setFocusNonce] = useState(0);
  const [preferredHost, setPreferredHost] = useState<string | null>(() => readStorage(HOST_KEY));

  const hostOptions: HeraldHostOption[] = useMemo(() => {
    if (demo) return [{ serverId: HERALD_DEMO_SERVER_ID, name: 'Demo hub', connected: true }];
    return snapshots.map((s) => ({
      serverId: s.serverId,
      name: s.serverName,
      connected: s.state.status === 'connected',
    }));
  }, [snapshots, demo]);

  const hostId = useMemo(() => {
    if (demo) return HERALD_DEMO_SERVER_ID;
    const connected = hostOptions.filter((o) => o.connected);
    const preferred = hostOptions.find((o) => o.serverId === preferredHost);
    if (preferred && (preferred.connected || connected.length === 0)) return preferred.serverId;
    if (connected.length > 0) return connected[0].serverId;
    return hostOptions[0]?.serverId ?? null;
  }, [hostOptions, preferredHost, demo]);

  const hostName = hostOptions.find((o) => o.serverId === hostId)?.name ?? '';

  const setHostId = useCallback((id: string) => {
    setPreferredHost(id);
    writeStorage(HOST_KEY, id);
  }, []);

  useEffect(() => {
    if (!demo) writeStorage(PANEL_OPEN_KEY, panelOpen ? '1' : '0');
  }, [panelOpen, demo]);

  const open = useCallback(() => {
    if (isMobileViewport()) setScreenOpen(true);
    else setPanelOpen(true);
    setFocusNonce((n) => n + 1);
  }, []);

  const close = useCallback(() => {
    setPanelOpen(false);
    setScreenOpen(false);
  }, []);

  const toggle = useCallback(() => {
    const mobile = isMobileViewport();
    const isOpen = mobile ? screenOpen : panelOpen;
    const focusInside = !!(document.activeElement as HTMLElement | null)?.closest?.('.herald');
    // Open but focus elsewhere: first press pulls focus back to Herald.
    if (isOpen && !focusInside && !mobile) {
      setFocusNonce((n) => n + 1);
      return;
    }
    if (isOpen) close();
    else open();
  }, [screenOpen, panelOpen, open, close]);

  // Global hotkey: Ctrl+J (Cmd+J on macOS). Fires even inside inputs because
  // it is an explicit modifier chord, but nothing else is intercepted.
  useEffect(() => {
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    const handler = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 'j' && e.code !== 'KeyJ') return;
      e.preventDefault();
      e.stopPropagation();
      // Holding the chord must not flap the panel open/closed.
      if (e.repeat) return;
      toggle();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [toggle]);

  useEffect(() => eventBus.on('toggle-herald', toggle), [toggle]);

  const herald = useHerald(hostId);
  const voiceHost = useMemo(
    () => ({ getTransport: herald.getTransport, connected: herald.connected }),
    [herald.getTransport, herald.connected],
  );
  const voice = useHeraldVoice(herald.subscribeEvents, hostId, undefined, voiceHost);
  const openRef = useRef(open);
  openRef.current = open;

  // Structured brain requests from voice commands. A turn may still be running
  // (the user talked over the reply): the request waits for it, briefly.
  const heraldRef = useRef(herald);
  heraldRef.current = herald;
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  // Sound cues around a voice turn: a tick at end-of-speech, an optional
  // thinking shimmer until Herald's first audio (turnCues.ts).
  const cues = useMemo(() => new TurnCues({
    tick: () => playChime('tick', TICK_VOLUME),
    startShimmer: () => startShimmer(),
    tickOn: () => voiceRef.current.ackTick,
    shimmerOn: () => voiceRef.current.thinkingTone && voiceRef.current.voiceOn,
  }), []);
  // Follow-up window: opens after Herald SPEAKS its answer to a turn that came by
  // voice from this device (followUp.ts); the voice-input hook checks the rest.
  const isActiveRef = useRef(true);
  const followUp = useMemo(() => new FollowUpTracker({
    arm: () => {
      const vi = voiceInputRef.current;
      const v = voiceRef.current;
      if (!vi || !isActiveRef.current || !v.voiceOn) return;
      // A hidden tab only when a remote trigger allowed background speech.
      const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
      if (!visible && !v.backgroundAllowed()) return;
      vi.openFollowUp();
    },
  }), []);
  useEffect(() => () => {
    cues.dispose();
    followUp.dispose();
  }, [cues, followUp]);
  /** A turn that came by voice went out (composer auto-send, trigger, follow-up, a spoken command). */
  const noteVoiceTurn = useCallback(() => {
    followUp.voiceTurn();
    cues.turnSent();
  }, [followUp, cues]);
  const pendingIntent = useRef<{ text: string; intent?: HeraldIntent; at: number } | null>(null);
  /** A voice turn outside the composer (commands, remote-trigger speech). Waits for a running turn. */
  const sendVoiceTurn = useCallback((text: string, intent?: HeraldIntent) => {
    const h = heraldRef.current;
    if ((h.state?.busy ?? false) || h.sending) {
      pendingIntent.current = { text, intent, at: Date.now() };
      return;
    }
    void h.send(text, intent ? { mode: 'voice', intent } : { mode: 'voice' });
  }, []);
  const sendIntent = useCallback((text: string, intent: HeraldIntent) => sendVoiceTurn(text, intent), [sendVoiceTurn]);
  /**
   * Speech sent straight out (remote trigger, desktop global hold-to-talk,
   * follow-up): the window is often hidden (mid-game), so the reply may play
   * in the background for a while, and it counts as a voice turn.
   */
  const sendVoiceDirect = useCallback((text: string) => {
    voiceRef.current.allowBackground();
    noteVoiceTurn();
    sendVoiceTurn(text);
  }, [noteVoiceTurn, sendVoiceTurn]);
  const busyNow = (herald.state?.busy ?? false) || herald.sending;
  useEffect(() => {
    const p = pendingIntent.current;
    if (busyNow || !p) return;
    pendingIntent.current = null;
    if (Date.now() - p.at < INTENT_WAIT_MS) {
      void heraldRef.current.send(p.text, p.intent ? { mode: 'voice', intent: p.intent } : { mode: 'voice' });
    }
  }, [busyNow]);

  // Esc stops Herald talking from anywhere on the page (hands-free: focus is
  // rarely in the panel). Bubble phase, so dialogs that handle Esc first win.
  const speakingNow = voice.supported && voice.speaking;
  useEffect(() => {
    if (!speakingNow) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      voiceRef.current.stopCommand();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [speakingNow]);

  const briefMe = useCallback(() => {
    voiceRef.current.stop();
    voiceRef.current.expectBriefing();
    sendIntent('Brief me', 'brief');
  }, [sendIntent]);

  // "Show me": the hub picks the session and opens it on the right device
  // (a `navigate` event, handled below); this device speaks the short answer.
  const showClarify = useRef<ShowClarify | null>(null);
  const showAck = useCallback((line: string) => {
    // Gaming: a tick, never a voice over the game.
    if (heraldSetupStore.get().profile === 'gaming') playChime('tick', TICK_VOLUME);
    else voiceRef.current.say(line);
  }, []);
  const runShow = useCallback((cmd: ShowCommand, said: string, presetDeviceId?: string) => {
    void runShowCommand(cmd, said, {
      devices: () => heraldRef.current.state?.devices ?? [],
      selfId: () => voiceRef.current.selfId,
      activeId: () => heraldRef.current.state?.activeDevice?.id ?? null,
      request: (req) => heraldRef.current.show(req),
      localTarget: () => localShowTarget({
        actions: heraldRef.current.state?.actions,
        messages: heraldRef.current.messages,
        inbox: heraldRef.current.state?.inbox,
      }),
      navigateHere: (ref) => {
        maybeBringToFront('show');
        eventBus.emit('herald-show-session', { serverId: ref.serverId, sessionId: ref.sessionId, pending: false });
      },
      say: (line) => voiceRef.current.say(line),
      ack: showAck,
      sendToBrain: (t) => {
        const rest = stripWakeWord(t);
        if (rest) sendVoiceTurn(rest);
      },
      setClarify: (c) => {
        showClarify.current = c;
        // "Which one, A or B?" is a question: let the follow-up window catch the answer.
        if (c) followUp.voiceTurn();
      },
      now: () => Date.now(),
    }, presetDeviceId);
  }, [showAck, sendVoiceTurn, followUp]);

  const onVoiceTranscript = useCallback((text: string): string | null => {
    const v = voiceRef.current;
    // Red card by voice ("confirm deploy"; the hub verifies) or a bare "yes" at
    // one (answered with the phrase, never a confirm). See confirmPhrase.ts.
    const vc = detectVoiceConfirm(text, heraldRef.current.state?.actions);
    if (vc) {
      void runVoiceConfirm(vc, {
        confirmByVoice: heraldRef.current.confirmByVoice,
        say: (line) => voiceRef.current.say(line),
        tone: (kind) => playChime(kind),
      });
      cues.turnDone();
      return null;
    }
    // The answer to "Which one, Out4 or Docs?" (only right after asking).
    const clarify = showClarify.current;
    showClarify.current = null;
    if (clarify && Date.now() < clarify.until) {
      const picked = matchClarifyAnswer(text, clarify.candidates);
      if (picked) {
        followUp.cancel();
        cues.turnDone();
        runShow({ target: picked, device: null }, text, clarify.deviceId);
        return null;
      }
    }
    const show = matchShowCommand(text, (heraldRef.current.state?.devices ?? []).map((d) => d.label));
    if (show) {
      followUp.cancel();
      cues.turnDone();
      runShow(show, text);
      return null;
    }
    const r = routeVoiceTranscript(text, {
      stop: v.stopCommand,
      repeat: v.repeat,
      goOn: v.goOn,
      stepRate: v.stepRate,
      volume: v.volumeCommand,
      expectBriefing: v.expectBriefing,
      sendIntent,
      notice: (m) => voiceInputRef.current?.controller.fail(m),
      undo: () => void runUndo({
        actions: () => heraldRef.current.state?.actions ?? [],
        cancel: (id) => heraldRef.current.confirm(id, 'cancel'),
        speaking: () => voiceRef.current.supported && voiceRef.current.speaking,
        stopSpeech: () => voiceRef.current.stop(),
        say: (line) => voiceRef.current.say(line),
      }),
    });
    // Taken: a soft acknowledgement for commands that are otherwise silent.
    if (r.command === 'stop' && v.chimeOn) playChime('ok', 0.035);
    // STOP: no follow-up, no thinking tone. Commands that answer out loud
    // (repeat, go on, shorter, undo...) are a voice turn: a follow-up may come.
    if (r.command === 'stop' || r.command === 'volume') {
      followUp.cancel();
      cues.turnDone();
    } else if (r.command) {
      noteVoiceTurn();
    } else if (!r.send) {
      cues.turnDone();
    }
    return r.send;
  }, [sendIntent, followUp, cues, noteVoiceTurn, runShow]);
  const voiceInputRef = useRef<ReturnType<typeof useHeraldVoiceInput> | null>(null);
  const isPendingConfirmText = useCallback(
    (text: string) => isPendingConfirmPhrase(text, heraldRef.current.state?.actions),
    [],
  );

  // ---- active device ------------------------------------------------------
  const activeDevice = herald.state?.activeDevice ?? null;
  const devices = useMemo(() => herald.state?.devices ?? [], [herald.state?.devices]);
  const selfId = voice.selfId;
  const isActive = !activeDevice || !selfId || activeDevice.id === selfId;
  isActiveRef.current = isActive;
  const controlledElsewhere = !isActive && activeDevice?.reason === 'claimed';
  const [keepPinned, setKeepPinnedState] = useState(() => readStorage(PIN_KEY) === '1');
  const claimFail = useCallback((err: string | null) => {
    if (err) voiceInputRef.current?.controller.fail(err);
  }, []);
  const takeControl = useCallback(() => {
    void voiceRef.current.claimDevice(keepPinned).then(claimFail);
  }, [keepPinned, claimFail]);
  const switchTo = useCallback((deviceId: string) => {
    void voiceRef.current.claimDevice(keepPinned, deviceId === selfId ? undefined : deviceId).then(claimFail);
  }, [keepPinned, selfId, claimFail]);
  const setKeepPinned = useCallback((on: boolean) => {
    setKeepPinnedState(on);
    writeStorage(PIN_KEY, on ? '1' : '0');
    // Already in control: apply it now (pin, or let other devices take over again).
    if (isActive && selfId) void voiceRef.current.claimDevice(on).then(claimFail);
  }, [isActive, selfId, claimFail]);
  const [handoffNote, setHandoffNote] = useState<string | null>(null);
  const prevActive = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevActive.current;
    const next = activeDevice?.id ?? null;
    prevActive.current = next;
    if (!selfId || !prev || prev === next) return;
    if (prev === selfId && next && next !== selfId) {
      // Stand down: a trigger capture here no longer belongs to us. (Tones stop
      // via the announcer flag; hands-free pauses via controlledElsewhere.)
      if (voiceInputRef.current?.state.source === 'trigger') voiceInputRef.current.cancel();
      setHandoffNote(`Now on ${activeDevice?.label ?? 'another device'}`);
      const t = setTimeout(() => setHandoffNote(null), HANDOFF_NOTE_MS);
      return () => clearTimeout(t);
    }
    if (next === selfId) setHandoffNote(null);
  }, [activeDevice?.id, activeDevice?.label, selfId]);

  const voiceInput = useHeraldVoiceInput({
    pausedBy: controlledElsewhere ? activeDevice?.label ?? 'another device' : null,
    getTransport: herald.getTransport,
    connected: herald.connected,
    serverStatus: voice.serverStatus,
    stopSpeech: voice.stop,
    speaking: voice.supported && voice.speaking,
    openPanel: () => {
      const mobile = isMobileViewport();
      if (!(mobile ? screenOpenRef.current : panelOpenRef.current)) openRef.current();
    },
    onVoiceTranscript,
    briefMe,
    sendVoice: sendVoiceDirect,
    spokenLog: voice.spokenLog,
    isPendingConfirm: isPendingConfirmText,
    fleetSuppressed: voice.fleetSuppressed,
    onFleetStop: () => {
      // "Hey Jarvis, stop" heard here while another device speaks.
      voiceRef.current.stopCommand();
      if (voiceRef.current.chimeOn) playChime('ok', 0.035);
    },
  });
  voiceInputRef.current = voiceInput;

  // The tick: the moment a capture ends and is being transcribed.
  useEffect(() => {
    let prev = voiceInput.controller.state.phase;
    return voiceInput.controller.subscribe((st) => {
      if (st.phase === 'transcribing' && prev !== 'transcribing') cues.endOfSpeech();
      // Someone started talking again: whatever was pending is superseded.
      if (st.phase === 'listening' && prev !== 'listening') followUp.cancel();
      prev = st.phase;
    });
  }, [voiceInput.controller, cues, followUp]);
  // Herald speaking / thinking -> follow-up timing and the shimmer.
  const speakingForCues = voice.supported && voice.speaking;
  const busyForCues = (herald.state?.busy ?? false) || herald.sending;
  useEffect(() => {
    followUp.update({ speaking: speakingForCues, busy: busyForCues });
    if (speakingForCues) cues.audioStarted();
  }, [followUp, cues, speakingForCues, busyForCues]);
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busyForCues && !speakingForCues) cues.turnDone();
    wasBusy.current = busyForCues;
  }, [cues, busyForCues, speakingForCues]);
  // The user's pronunciation list (on the hub, follows them) -> the speech normaliser.
  const pronunciations = herald.state?.pronunciations;
  useEffect(() => {
    setUserPronunciations(pronunciations ?? []);
  }, [pronunciations]);
  // New host or this device stood down: no follow-up from the old context.
  useEffect(() => {
    followUp.cancel();
    voiceInputRef.current?.cancelFollowUp();
  }, [hostId, isActive, followUp]);

  // Remote triggers (hotkeys on other machines): the daemon sends them only to
  // the active device, i.e. this one. Works with the tab hidden; a failure is a
  // tone now and a notice (panel opened) the next time the user looks.
  const triggerNotice = useMemo(() => new DeferredNotice((m) => {
    openRef.current();
    voiceInputRef.current?.controller.fail(m);
  }), []);
  useEffect(() => {
    const flush = () => triggerNotice.flush();
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('focus', flush);
    return () => {
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('focus', flush);
    };
  }, [triggerNotice]);
  const triggerActions = useMemo<TriggerActions>(() => ({
    // Speaking here, or on another device (a stop / toggle then stops that one).
    speaking: () => (voiceRef.current.supported && voiceRef.current.speaking) || !!voiceRef.current.remoteSpeaking,
    capturing: () => voiceInputRef.current?.isCapturing() ?? false,
    stopSpeech: () => voiceRef.current.stopCommand(),
    cancelCapture: () => voiceInputRef.current?.cancel(),
    listen: () => voiceInputRef.current?.listen() ?? Promise.resolve('Voice input is not ready'),
    brief: () => briefMe(),
    repeat: () => voiceRef.current.repeat(),
    allowBackground: () => voiceRef.current.allowBackground(),
    tone: (kind) => {
      // Listening / failed are functional feedback (you may be mid-game): always.
      if (kind !== 'ok' || voiceRef.current.chimeOn) playChime(kind, kind === 'ok' ? 0.035 : 0.06);
    },
    notice: (m) => triggerNotice.post(m),
  }), [briefMe, triggerNotice]);
  const seenTriggers = useRef<string[]>([]);
  const subscribeEvents = herald.subscribeEvents;
  useEffect(() => subscribeEvents((event, source) => {
    if (event.kind !== 'trigger' || source !== 'push') return;
    if (seenTriggers.current.includes(event.id)) return;
    seenTriggers.current = [...seenTriggers.current.slice(-19), event.id];
    // The device check is waiting for a test press: it takes this one.
    if (probeTrigger(event.action)) return;
    tipsStore.trigger('remote_trigger');
    if (event.action !== 'stop' && event.action !== 'claim') maybeBringToFront('trigger');
    // A remote trigger that opens the mic plays its own tone ("remote"), and a
    // trigger from outside the home network / tailnet may never open it.
    const remote: TriggerActions = {
      ...triggerActions,
      tone: (kind) => (kind === 'wake' ? playChime('remote', 0.06) : triggerActions.tone(kind)),
      ...(event.allowListen === false
        ? { listen: async () => 'Remote listening is only allowed from your home network or tailnet' }
        : {}),
    };
    void runHeraldTrigger(event.action, remote);
  }), [subscribeEvents, triggerActions]);
  // "Show me" landed on THIS device (from this device's voice, another
  // device's, the brain or a `show` trigger): bring the window forward
  // (desktop app; an explicit request, so even in Gaming) and open it.
  const seenNav = useRef<string[]>([]);
  useEffect(() => subscribeEvents((event, source) => {
    if (event.kind !== 'navigate' || source !== 'push') return;
    if (seenNav.current.includes(event.id)) return;
    seenNav.current = [...seenNav.current.slice(-19), event.id];
    maybeBringToFront('show');
    eventBus.emit('herald-show-session', {
      serverId: event.session.serverId,
      sessionId: event.session.sessionId,
      pending: event.pending === true,
    });
    if (event.ack) {
      // A trigger: the window may be hidden; the answer may still be heard.
      voiceRef.current.allowBackground();
      showAck(showLines.here(event.session.sessionName));
    }
  }), [subscribeEvents, showAck]);
  // Budget notices (80% / used up): a tone on the active device; the message itself is spoken as a reply.
  useEffect(() => subscribeEvents((event, source) => {
    if (event.kind !== 'usage' || !event.notice || source !== 'push') return;
    if (isActiveRef.current) playChime(event.notice === 'budget_exceeded' ? 'error' : 'blocked', 0.06);
  }), [subscribeEvents]);
  const panelOpenRef = useRef(panelOpen);
  panelOpenRef.current = panelOpen;
  const screenOpenRef = useRef(screenOpen);
  screenOpenRef.current = screenOpen;
  const available = !!hostId && herald.connected && herald.supported !== false;

  // Native apps: desktop global shortcuts + tray, mobile earbud button + ducking.
  // They run the same handlers as the browser (push-to-talk, trigger actions).
  useNativeHerald({
    runTrigger: (action) => void runHeraldTrigger(action, triggerActions),
    input: voiceInput,
    tonesOn: voice.chimeOn,
    setTonesOn: voice.setChimeOn,
    speaking: voice.supported && voice.speaking,
    speakingAnywhere: (voice.supported && voice.speaking) || !!voice.remoteSpeaking,
    // Hold-to-talk pressed while Herald talks (here or on another device): quiet now.
    bargeIn: () => {
      voiceRef.current.stop();
      if (voiceRef.current.remoteSpeaking) voiceRef.current.stopRemote();
    },
    volume: voice.volume.voice,
    volumeCommand: voice.volumeCommand,
    enabled: available,
    tone: (kind) => playChime(kind, 0.06),
    notice: (m) => triggerNotice.post(m),
  });
  // Esc anywhere in the app stops Herald talking (the panel and its menu
  // handle their own Esc; this covers focus elsewhere in the app, where other
  // Esc handlers may run too). Never swallows the key.
  const speakingHere = voice.supported && voice.speaking;
  useEffect(() => {
    if (!speakingHere) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.repeat) return;
      const t = e.target as Element | null;
      if (t && typeof t.closest === 'function' && t.closest('.herald, .herald-menu, .hh')) return;
      voiceRef.current.stopCommand();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [speakingHere]);

  // "Hey Jarvis" heard: the capture that follows is a wake one.
  const wakeListening = voiceInput.state.source === 'wake' && voiceInput.state.phase !== 'idle';
  useEffect(() => {
    if (wakeListening) maybeBringToFront('wake');
  }, [wakeListening]);

  const setup = useHeraldSetup({
    voice,
    input: voiceInput,
    available,
    actions: herald.state?.actions ?? EMPTY,
    inbox: herald.state?.inbox ?? EMPTY,
  });

  // Desktop app: the floating orb.
  useHeraldOverlay({
    enabled: overlayEnabled(setup.state, setup.platform),
    listening: voiceInput.state.phase === 'starting' || voiceInput.state.phase === 'listening',
    transcribing: voiceInput.state.phase === 'transcribing',
    thinking: (herald.state?.busy ?? false) || herald.sending,
    speaking: voice.supported && voice.speaking,
    followUp: voiceInput.followUpWindow,
    messages: herald.messages,
    inbox: herald.state?.inbox ?? EMPTY,
    tonesHere: voice.chimeOn && voice.announcer,
  });

  const inbox = herald.state?.inbox;
  const { unheardCount, unheardBlocked } = useMemo(() => {
    let count = 0;
    let blocked = 0;
    for (const i of inbox ?? []) {
      if (!i.heard) {
        count++;
        if (i.priority === 'blocked') blocked++;
      }
    }
    return { unheardCount: count, unheardBlocked: blocked };
  }, [inbox]);

  const device: HeraldDeviceControl = useMemo(() => ({
    supported: herald.state?.devices !== undefined,
    selfId,
    label: voice.deviceLabel,
    activeDevice,
    devices,
    isActive,
    controlledElsewhere,
    keepPinned,
    setKeepPinned,
    takeControl,
    switchTo,
    rename: voice.renameDevice,
    handoffNote,
  }), [herald.state?.devices, selfId, voice.deviceLabel, activeDevice, devices, isActive, controlledElsewhere, keepPinned, setKeepPinned, takeControl, switchTo, voice.renameDevice, handoffNote]);

  // Composer sends: an auto-sent transcript ('voice') is a voice turn; typing is not.
  const heraldSend = herald.send;
  const send = useCallback<UseHeraldReturn['send']>((text, opts) => {
    if (opts?.mode === 'voice') noteVoiceTurn();
    else followUp.cancel();
    return heraldSend(text, opts);
  }, [heraldSend, noteVoiceTurn, followUp]);
  const data: HeraldDataValue = useMemo(() => ({
    ...herald,
    send,
    device,
    briefMe,
    displayName: herald.state?.displayName || DEFAULT_DISPLAY_NAME,
    presence: derivePresence({
      available,
      enabled: herald.state?.enabled ?? true,
      busy: (herald.state?.busy ?? false) || herald.sending,
      inbox: inbox ?? [],
    }),
    unheardCount,
    unheardBlocked,
    available,
  }), [herald, send, device, briefMe, available, inbox, unheardCount, unheardBlocked]);

  const ui: HeraldUiValue = useMemo(() => ({
    panelOpen, screenOpen, open, close, toggle, focusNonce,
    hostId, hostName, hostOptions, setHostId, demo,
  }), [panelOpen, screenOpen, open, close, toggle, focusNonce, hostId, hostName, hostOptions, setHostId, demo]);

  return (
    <HeraldUiContext.Provider value={ui}>
      <HeraldDataContext.Provider value={data}>
        <HeraldVoiceContext.Provider value={voice}>
          <HeraldVoiceInputContext.Provider value={voiceInput}>
            <HeraldSetupContext.Provider value={setup}>
              {children}
            </HeraldSetupContext.Provider>
          </HeraldVoiceInputContext.Provider>
        </HeraldVoiceContext.Provider>
      </HeraldDataContext.Provider>
    </HeraldUiContext.Provider>
  );
}

export function useHeraldUi(): HeraldUiValue {
  const ctx = useContext(HeraldUiContext);
  if (!ctx) throw new Error('useHeraldUi must be used within HeraldProvider');
  return ctx;
}

export function useHeraldData(): HeraldDataValue {
  const ctx = useContext(HeraldDataContext);
  if (!ctx) throw new Error('useHeraldData must be used within HeraldProvider');
  return ctx;
}

export function useHeraldVoiceCtx(): HeraldVoice {
  const ctx = useContext(HeraldVoiceContext);
  if (!ctx) throw new Error('useHeraldVoiceCtx must be used within HeraldProvider');
  return ctx;
}

export function useHeraldVoiceInputCtx(): HeraldVoiceInput {
  const ctx = useContext(HeraldVoiceInputContext);
  if (!ctx) throw new Error('useHeraldVoiceInputCtx must be used within HeraldProvider');
  return ctx;
}

export function useHeraldSetupCtx(): HeraldSetupControl {
  const ctx = useContext(HeraldSetupContext);
  if (!ctx) throw new Error('useHeraldSetupCtx must be used within HeraldProvider');
  return ctx;
}
