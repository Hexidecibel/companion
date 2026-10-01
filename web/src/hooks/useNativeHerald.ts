import { useEffect, useRef, useSyncExternalStore } from 'react';
import {
  getNativeInfo,
  getPassthroughStatus,
  listenNativeHerald,
  listenPassthroughStatus,
  setAudioFocus,
  setGlobalShortcuts,
  setMediaSession,
  setTrayState,
  type NativeHeraldHandlers,
  type NativeInfo,
  type PassthroughStatus,
  type ShortcutName,
  type ShortcutResult,
} from '../services/nativeBridge';
import type { VolumeCommand } from '../services/tts/volume';
import { parseChord } from '../services/voice/hotkeys';
import type { VoiceInputSource, VoiceInputState } from '../services/voice/voiceInput';
import { nativePlatform, type NativePlatform } from '../utils/platform';

/**
 * Native-app Herald preferences (per device). Defaults avoid Discord's
 * defaults (Ctrl+Shift+M mute, Ctrl+Shift+D deafen, the unbound push-to-talk
 * key; Discord binds nothing with Ctrl+Alt+Shift) and the browser-tab chords
 * (Ctrl+Shift+Space talk, Ctrl+Shift+B brief), which keep working inside the
 * app window.
 *
 * Passthrough (per shortcut): observe the keys without taking them, so an app
 * bound to the same chord (Discord push-to-mute on Ctrl+Alt+Space) still gets
 * them. Default on for hold-to-talk on Windows / macOS, off otherwise.
 */
export interface NativeHeraldPrefs {
  /** Desktop: register the system-wide shortcuts. */
  globalShortcuts: boolean;
  /** Desktop: hold to talk (press and release). */
  talkChord: string;
  /** Desktop: tap to toggle (stop speaking / cancel / listen). */
  toggleChord: string;
  /** Desktop: tap for "brief me". */
  briefChord: string;
  /** Desktop: tap to stop Herald speaking, on any device. */
  stopChord: string;
  /** Desktop: per shortcut, let other apps see the keys too (null / absent: the OS default). */
  passthrough: Partial<Record<ShortcutName, boolean>>;
  /** Mobile: the earbud / headset play-pause toggles Herald. */
  earbudButton: boolean;
  /** Mobile: other audio ducks while Herald speaks. */
  duckOthers: boolean;
}

export const DEFAULT_NATIVE_PREFS: NativeHeraldPrefs = {
  globalShortcuts: true,
  talkChord: 'Ctrl+Alt+Space',
  toggleChord: 'Ctrl+Alt+Shift+H',
  briefChord: 'Ctrl+Alt+Shift+B',
  stopChord: 'Ctrl+Alt+Shift+S',
  passthrough: {},
  earbudButton: true,
  duckOthers: true,
};

/** Passthrough on by default: hold-to-talk on Windows and macOS (push-to-talk next to Discord). */
export function defaultPassthrough(name: ShortcutName, os: string | null | undefined): boolean {
  return name === 'talk' && (os === 'windows' || os === 'macos');
}

/** The effective passthrough choice for one shortcut. */
export function passthroughFor(prefs: Pick<NativeHeraldPrefs, 'passthrough'>, name: ShortcutName, info: NativeInfo | null): boolean {
  if (!info?.passthrough) return false;
  const v = prefs.passthrough[name];
  return typeof v === 'boolean' ? v : defaultPassthrough(name, info.os);
}

const PREFS_KEY = 'herald_native_prefs';

function parsePassthrough(v: unknown): Partial<Record<ShortcutName, boolean>> {
  const out: Partial<Record<ShortcutName, boolean>> = {};
  if (!v || typeof v !== 'object') return out;
  for (const k of ['talk', 'toggle', 'brief', 'stop'] as const) {
    const b = (v as Record<string, unknown>)[k];
    if (typeof b === 'boolean') out[k] = b;
  }
  return out;
}

export function loadNativePrefs(): NativeHeraldPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_NATIVE_PREFS;
    const p = JSON.parse(raw) as Partial<NativeHeraldPrefs>;
    const chord = (v: unknown, d: string) => (typeof v === 'string' && (v === '' || parseChord(v)) ? v : d);
    return {
      globalShortcuts: typeof p.globalShortcuts === 'boolean' ? p.globalShortcuts : DEFAULT_NATIVE_PREFS.globalShortcuts,
      talkChord: chord(p.talkChord, DEFAULT_NATIVE_PREFS.talkChord),
      toggleChord: chord(p.toggleChord, DEFAULT_NATIVE_PREFS.toggleChord),
      briefChord: chord(p.briefChord, DEFAULT_NATIVE_PREFS.briefChord),
      stopChord: chord(p.stopChord, DEFAULT_NATIVE_PREFS.stopChord),
      passthrough: parsePassthrough(p.passthrough),
      earbudButton: typeof p.earbudButton === 'boolean' ? p.earbudButton : DEFAULT_NATIVE_PREFS.earbudButton,
      duckOthers: typeof p.duckOthers === 'boolean' ? p.duckOthers : DEFAULT_NATIVE_PREFS.duckOthers,
    };
  } catch {
    return DEFAULT_NATIVE_PREFS;
  }
}

interface NativeState {
  prefs: NativeHeraldPrefs;
  /** Last registration result per shortcut (desktop). */
  shortcuts: ShortcutResult[];
  info: NativeInfo | null;
  /** The native info call finished (info may still be null: an older app / a browser). */
  infoLoaded: boolean;
  /** Passthrough hook status (desktop), or null. */
  passthrough: PassthroughStatus | null;
}

/** A native input the device check is waiting for (it takes the press instead of Herald). */
export type NativeProbe = (action: 'talk_down' | 'talk_up' | 'toggle' | 'brief' | 'stop') => void;
let probe: NativeProbe | null = null;

// A tiny store shared by the provider hook (which applies the prefs) and the
// settings UI (which edits them), so neither needs a new React context.
let state: NativeState = { prefs: loadNativePrefs(), shortcuts: [], info: null, infoLoaded: false, passthrough: null };
const listeners = new Set<() => void>();

function setState(patch: Partial<NativeState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export const nativeHeraldStore = {
  get: (): NativeState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
  setPref<K extends keyof NativeHeraldPrefs>(key: K, value: NativeHeraldPrefs[K]): void {
    const prefs = { ...state.prefs, [key]: value };
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // storage unavailable: applies for this session only
    }
    setState({ prefs });
  },
  setShortcuts: (shortcuts: ShortcutResult[]) => setState({ shortcuts }),
  setInfo: (info: NativeInfo | null) => setState({ info, infoLoaded: true }),
  setPassthroughStatus: (passthrough: PassthroughStatus | null) => setState({ passthrough }),
  /** One shortcut's passthrough choice. */
  setPassthrough(name: ShortcutName, on: boolean): void {
    nativeHeraldStore.setPref('passthrough', { ...state.prefs.passthrough, [name]: on });
  },
  /** Device check: route the next native presses here instead of to Herald (null restores). */
  setProbe(p: NativeProbe | null): void {
    probe = p;
  },
  /** Tests only. */
  reset(): void {
    probe = null;
    state = { prefs: loadNativePrefs(), shortcuts: [], info: null, infoLoaded: false, passthrough: null };
    listeners.forEach((l) => l());
  },
};

export function useNativeHeraldState(): NativeState {
  return useSyncExternalStore(nativeHeraldStore.subscribe, nativeHeraldStore.get, nativeHeraldStore.get);
}

/** What the provider hands the native layer. Read through a ref: always current. */
export interface NativeHeraldHost {
  /** Run a remote-trigger action locally (same logic as a daemon trigger). */
  runTrigger: (action: 'toggle' | 'brief' | 'stop') => void;
  input: {
    state: VoiceInputState;
    available: boolean;
    unavailableReason: string | null;
    start: (source: VoiceInputSource) => void;
    stop: () => void;
  };
  tonesOn: boolean;
  setTonesOn: (on: boolean) => void;
  /** Herald is speaking right now on this device (mobile audio focus). */
  speaking: boolean;
  /** Herald is speaking here or on another device. */
  speakingAnywhere?: boolean;
  /** Barge-in for a hold-to-talk key-down: stop Herald now (here and on the speaking device). */
  bargeIn?: () => void;
  /** Herald's voice volume on this device (tray checks). */
  volume?: number;
  /** Tray volume items. */
  volumeCommand?: (cmd: VolumeCommand) => void;
  /** Herald is usable on this device (connected to its host). */
  enabled: boolean;
  tone: (kind: 'wake' | 'error') => void;
  notice: (message: string) => void;
}

/** The handlers native input runs. Pure over the host, so it is unit tested. */
export function nativeHandlers(host: () => NativeHeraldHost): NativeHeraldHandlers {
  const probed = (action: Parameters<NativeProbe>[0]): boolean => {
    if (!probe) return false;
    probe(action);
    return true;
  };
  return {
    talkDown: () => {
      if (probed('talk_down')) return;
      const h = host();
      // Holding the talk key while Herald speaks: quiet at once, on key-down,
      // then listen if the key stays held (the capture below starts as usual).
      if (h.speakingAnywhere || h.speaking) h.bargeIn?.();
      if (h.input.state.phase !== 'idle') return; // key auto-repeat, or already capturing
      if (!h.input.available) {
        h.tone('error');
        h.notice(h.input.unavailableReason ?? 'Voice input unavailable');
        return;
      }
      h.input.start('global');
    },
    talkUp: () => {
      if (probed('talk_up')) return;
      const h = host();
      if (h.input.state.source === 'global') h.input.stop();
    },
    toggle: () => { if (!probed('toggle')) host().runTrigger('toggle'); },
    brief: () => { if (!probed('brief')) host().runTrigger('brief'); },
    stop: () => { if (!probed('stop')) host().runTrigger('stop'); },
    muteTones: () => {
      const h = host();
      h.setTonesOn(!h.tonesOn);
    },
    volume: (cmd) => host().volumeCommand?.(cmd),
  };
}

/**
 * Wires the native apps into Herald: global shortcuts and the tray (desktop),
 * the earbud button and audio ducking (mobile). A no-op in a browser.
 */
export function useNativeHerald(host: NativeHeraldHost, platform: NativePlatform = nativePlatform()): void {
  const hostRef = useRef(host);
  hostRef.current = host;
  const { prefs } = useNativeHeraldState();

  // Native input -> the web handlers.
  useEffect(() => {
    if (platform === 'browser') return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listenNativeHerald(nativeHandlers(() => hostRef.current), platform).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [platform]);

  // A global hold-to-talk plays the listening earcon once the mic is open: the
  // window is usually hidden, so this is the only sign it worked.
  const phase = host.input.state.phase;
  const source = host.input.state.source;
  const wasListening = useRef(false);
  useEffect(() => {
    const listening = phase === 'listening' && source === 'global';
    if (listening && !wasListening.current) hostRef.current.tone('wake');
    wasListening.current = listening;
  }, [phase, source]);

  // Desktop: (re)register the system-wide shortcuts, once the OS is known
  // (the passthrough defaults depend on it).
  const { info, infoLoaded } = useNativeHeraldState();
  const { globalShortcuts, talkChord, toggleChord, briefChord, stopChord } = prefs;
  const ptTalk = passthroughFor(prefs, 'talk', info);
  const ptToggle = passthroughFor(prefs, 'toggle', info);
  const ptBrief = passthroughFor(prefs, 'brief', info);
  const ptStop = passthroughFor(prefs, 'stop', info);
  useEffect(() => {
    if (platform !== 'desktop' || !infoLoaded) return;
    let cancelled = false;
    const cfg = globalShortcuts
      ? {
          talk: talkChord,
          toggle: toggleChord,
          brief: briefChord,
          stop: stopChord,
          passthrough: { talk: ptTalk, toggle: ptToggle, brief: ptBrief, stop: ptStop },
        }
      : {};
    void setGlobalShortcuts(cfg).then((res) => {
      if (cancelled) return;
      nativeHeraldStore.setShortcuts(res ?? []);
      void getPassthroughStatus().then((st) => { if (!cancelled) nativeHeraldStore.setPassthroughStatus(st); });
    });
    return () => { cancelled = true; };
  }, [platform, infoLoaded, globalShortcuts, talkChord, toggleChord, briefChord, stopChord, ptTalk, ptToggle, ptBrief, ptStop]);
  useEffect(() => {
    if (platform !== 'desktop') return;
    void getNativeInfo().then((i) => nativeHeraldStore.setInfo(i));
    let off: (() => void) | null = null;
    let cancelled = false;
    void listenPassthroughStatus((st) => nativeHeraldStore.setPassthroughStatus(st)).then((u) => {
      if (cancelled) u();
      else off = u;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [platform]);

  // Desktop: the tray's "Mute tones" and volume checks mirror the preferences.
  const tonesOn = host.tonesOn;
  const volume = host.volume;
  useEffect(() => {
    if (platform === 'desktop') void setTrayState(!tonesOn, volume);
  }, [platform, tonesOn, volume]);

  // Mobile: the earbud button belongs to Herald only while Herald is usable here.
  const mobile = platform === 'android' || platform === 'ios';
  const earbud = mobile && prefs.earbudButton && host.enabled;
  useEffect(() => {
    if (!mobile) return;
    void setMediaSession(earbud);
  }, [mobile, earbud]);

  // Mobile: other audio ducks while Herald speaks (unless turned off).
  const duck = host.speaking && prefs.duckOthers;
  useEffect(() => {
    if (!mobile) return;
    void setAudioFocus(duck);
  }, [mobile, duck]);
}
