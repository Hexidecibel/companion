import { useEffect, useRef, useSyncExternalStore } from 'react';
import {
  getNativeInfo,
  listenNativeHerald,
  setAudioFocus,
  setGlobalShortcuts,
  setMediaSession,
  setTrayTonesMuted,
  type NativeHeraldHandlers,
  type NativeInfo,
  type ShortcutResult,
} from '../services/nativeBridge';
import { parseChord } from '../services/voice/hotkeys';
import type { VoiceInputSource, VoiceInputState } from '../services/voice/voiceInput';
import { nativePlatform, type NativePlatform } from '../utils/platform';

/**
 * Native-app Herald preferences (per device). Defaults avoid Discord's
 * defaults (Ctrl+Shift+M mute, Ctrl+Shift+D deafen, the unbound push-to-talk
 * key) and the browser-tab chords (Ctrl+Shift+Space talk, Ctrl+Shift+B brief),
 * which keep working inside the app window.
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
  /** Mobile: the earbud / headset play-pause toggles Herald. */
  earbudButton: boolean;
}

export const DEFAULT_NATIVE_PREFS: NativeHeraldPrefs = {
  globalShortcuts: true,
  talkChord: 'Ctrl+Alt+Space',
  toggleChord: 'Ctrl+Alt+Shift+H',
  briefChord: 'Ctrl+Alt+Shift+B',
  earbudButton: true,
};

const PREFS_KEY = 'herald_native_prefs';

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
      earbudButton: typeof p.earbudButton === 'boolean' ? p.earbudButton : DEFAULT_NATIVE_PREFS.earbudButton,
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
}

// A tiny store shared by the provider hook (which applies the prefs) and the
// settings UI (which edits them), so neither needs a new React context.
let state: NativeState = { prefs: loadNativePrefs(), shortcuts: [], info: null };
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
  setInfo: (info: NativeInfo | null) => setState({ info }),
  /** Tests only. */
  reset(): void {
    state = { prefs: loadNativePrefs(), shortcuts: [], info: null };
    listeners.forEach((l) => l());
  },
};

export function useNativeHeraldState(): NativeState {
  return useSyncExternalStore(nativeHeraldStore.subscribe, nativeHeraldStore.get, nativeHeraldStore.get);
}

/** What the provider hands the native layer. Read through a ref: always current. */
export interface NativeHeraldHost {
  /** Run a remote-trigger action locally (same logic as a daemon trigger). */
  runTrigger: (action: 'toggle' | 'brief') => void;
  input: {
    state: VoiceInputState;
    available: boolean;
    unavailableReason: string | null;
    start: (source: VoiceInputSource) => void;
    stop: () => void;
  };
  tonesOn: boolean;
  setTonesOn: (on: boolean) => void;
  /** Herald is speaking right now (mobile audio focus). */
  speaking: boolean;
  /** Herald is usable on this device (connected to its host). */
  enabled: boolean;
  tone: (kind: 'wake' | 'error') => void;
  notice: (message: string) => void;
}

/** The handlers native input runs. Pure over the host, so it is unit tested. */
export function nativeHandlers(host: () => NativeHeraldHost): NativeHeraldHandlers {
  return {
    talkDown: () => {
      const h = host();
      if (h.input.state.phase !== 'idle') return; // key auto-repeat, or already capturing
      if (!h.input.available) {
        h.tone('error');
        h.notice(h.input.unavailableReason ?? 'Voice input unavailable');
        return;
      }
      h.input.start('global');
    },
    talkUp: () => {
      const h = host();
      if (h.input.state.source === 'global') h.input.stop();
    },
    toggle: () => host().runTrigger('toggle'),
    brief: () => host().runTrigger('brief'),
    muteTones: () => {
      const h = host();
      h.setTonesOn(!h.tonesOn);
    },
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

  // Desktop: (re)register the system-wide shortcuts.
  const { globalShortcuts, talkChord, toggleChord, briefChord } = prefs;
  useEffect(() => {
    if (platform !== 'desktop') return;
    let cancelled = false;
    const cfg = globalShortcuts ? { talk: talkChord, toggle: toggleChord, brief: briefChord } : {};
    void setGlobalShortcuts(cfg).then((res) => {
      if (!cancelled) nativeHeraldStore.setShortcuts(res ?? []);
    });
    return () => { cancelled = true; };
  }, [platform, globalShortcuts, talkChord, toggleChord, briefChord]);
  useEffect(() => {
    if (platform !== 'desktop') return;
    void getNativeInfo().then((info) => nativeHeraldStore.setInfo(info));
  }, [platform]);

  // Desktop: tray "Mute tones" mirrors the preference.
  const tonesOn = host.tonesOn;
  useEffect(() => {
    if (platform === 'desktop') void setTrayTonesMuted(!tonesOn);
  }, [platform, tonesOn]);

  // Mobile: the earbud button belongs to Herald only while Herald is usable here.
  const mobile = platform === 'android' || platform === 'ios';
  const earbud = mobile && prefs.earbudButton && host.enabled;
  useEffect(() => {
    if (!mobile) return;
    void setMediaSession(earbud);
  }, [mobile, earbud]);

  // Mobile: other audio ducks while Herald speaks.
  const speaking = host.speaking;
  useEffect(() => {
    if (!mobile) return;
    void setAudioFocus(speaking);
  }, [mobile, speaking]);
}
