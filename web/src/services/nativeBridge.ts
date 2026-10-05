/**
 * Native Herald bridge: the Tauri apps' extra inputs, delivered to the SAME
 * web handlers the browser uses (push-to-talk, the remote-trigger actions).
 *
 *   Desktop (Tauri): system-wide shortcuts with true hold-to-talk, and the tray
 *     / menu-bar items, arrive as a `herald-native` event `{ action }`.
 *   Android / iOS: an earbud or headset play-pause arrives as the
 *     `herald-native` plugin's `media` event `{ action: 'toggle' }`.
 *
 * The web layer tells the native side what to do in return: which shortcuts to
 * register (desktop), whether the earbud button belongs to Herald, and when
 * Herald is speaking so other audio ducks (mobile).
 *
 * Every call is a no-op in a browser, and never throws: a missing command in an
 * older native build must not break the page.
 */
import { parseChord } from './voice/hotkeys';
import { nativePlatform, type NativePlatform } from '../utils/platform';

export type NativeHeraldAction =
  | 'talk_down' | 'talk_up' | 'toggle' | 'brief' | 'mute_tones' | 'stop'
  | 'volume_up' | 'volume_down' | 'volume_set' | 'orb' | 'quiet_hour';

const ACTIONS: ReadonlySet<string> = new Set<NativeHeraldAction>([
  'talk_down', 'talk_up', 'toggle', 'brief', 'mute_tones', 'stop', 'volume_up', 'volume_down', 'volume_set', 'orb', 'quiet_hour',
]);

export interface NativeHeraldHandlers {
  /** Hold-to-talk pressed (desktop global shortcut). */
  talkDown: () => void;
  /** Hold-to-talk released. */
  talkUp: () => void;
  /** Speaking: stop; listening: cancel; otherwise listen (remote-trigger `toggle`). */
  toggle: () => void;
  /** Brief me (remote-trigger `brief`). */
  brief: () => void;
  /** Tray "Mute tones". */
  muteTones: () => void;
  /** Stop speaking (on any device) and cancel any capture: the stop shortcut, the tray, the orb's button. */
  stop: () => void;
  /** Tray "Herald volume": louder / quieter (one step) or a level (0..1.5). */
  volume: (cmd: { kind: 'step'; dir: 1 | -1 } | { kind: 'set'; value: number }) => void;
  /** Tray "Hide floating orb" / "Show floating orb" (value 0 / 1). Optional for older hosts. */
  orb?: (on: boolean) => void;
  /** Tray "Quiet for 1 hour": no tones on this device for an hour. Optional for older hosts. */
  quietHour?: () => void;
}

/** Validate a native payload and run its handler. False when it was not ours. */
export function dispatchNativeEvent(payload: unknown, h: NativeHeraldHandlers): boolean {
  const action = (payload as { action?: unknown } | null)?.action;
  if (typeof action !== 'string' || !ACTIONS.has(action)) return false;
  const value = (payload as { value?: unknown }).value;
  switch (action as NativeHeraldAction) {
    case 'talk_down': h.talkDown(); break;
    case 'talk_up': h.talkUp(); break;
    case 'toggle': h.toggle(); break;
    case 'brief': h.brief(); break;
    case 'mute_tones': h.muteTones(); break;
    case 'stop': h.stop(); break;
    case 'volume_up': h.volume({ kind: 'step', dir: 1 }); break;
    case 'volume_down': h.volume({ kind: 'step', dir: -1 }); break;
    case 'volume_set':
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      h.volume({ kind: 'set', value });
      break;
    case 'orb':
      if (typeof value !== 'number') return false;
      h.orb?.(value > 0);
      break;
    case 'quiet_hour':
      h.quietHour?.();
      break;
  }
  return true;
}

export const NATIVE_EVENT = 'herald-native';
const PLUGIN = 'herald-native';

/**
 * Subscribe to native Herald input. Resolves to an unsubscribe function (a
 * no-op in a browser or when the native side lacks the feature).
 */
export async function listenNativeHerald(
  h: NativeHeraldHandlers,
  platform: NativePlatform = nativePlatform(),
): Promise<() => void> {
  try {
    if (platform === 'desktop') {
      const { listen } = await import('@tauri-apps/api/event');
      return await listen(NATIVE_EVENT, (e) => { dispatchNativeEvent(e.payload, h); });
    }
    if (platform === 'android' || platform === 'ios') {
      const { addPluginListener } = await import('@tauri-apps/api/core');
      const listener = await addPluginListener(PLUGIN, 'media', (payload) => { dispatchNativeEvent(payload, h); });
      return () => { void listener.unregister().catch(() => {}); };
    }
  } catch (err) {
    console.warn('[herald-native] listen failed', err);
  }
  return () => {};
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.warn(`[herald-native] ${cmd} failed`, err);
    return null;
  }
}

// ---------------------------------------------------------------- desktop

export type ShortcutName = 'talk' | 'toggle' | 'brief' | 'stop';

export interface ShortcutConfig {
  talk?: string | null;
  toggle?: string | null;
  brief?: string | null;
  stop?: string | null;
  /** Per shortcut: observe the keys without taking them (Discord etc. still get them). */
  passthrough?: Partial<Record<ShortcutName, boolean>>;
}

export interface ShortcutResult {
  name: ShortcutName;
  accelerator: string;
  ok: boolean;
  error: string | null;
  /** How it is held: 'exclusive' (only Companion gets the keys) or 'passthrough'. Absent on older apps. */
  mode?: 'exclusive' | 'passthrough';
  /** Passthrough was asked for and is not possible ('unsupported', 'needs_permission', ...). */
  passthroughError?: string | null;
}

export interface NativeInfo {
  os: string;
  /** Linux Wayland session: system-wide shortcuts only work while a Companion window is focused. */
  wayland: boolean;
  /** Passthrough shortcuts work here (Windows, macOS). Absent on older apps. */
  passthrough?: boolean;
}

/** Passthrough status (desktop): the hook, macOS permission, Windows elevation. */
export interface PassthroughStatus {
  supported: boolean;
  running: boolean;
  needsPermission: boolean;
  selfElevated: boolean;
  foregroundElevated: boolean;
}

export const NATIVE_STATUS_EVENT = 'herald-native-status';

/**
 * Web chord ("Ctrl+Alt+Shift+H", KeyboardEvent.code keys) to a Tauri global
 * shortcut accelerator. Null when the chord is not usable.
 */
export function chordToAccelerator(chord: string): string | null {
  const c = parseChord(chord);
  if (!c) return null;
  const parts: string[] = [];
  if (c.ctrl) parts.push('Ctrl');
  if (c.alt) parts.push('Alt');
  if (c.shift) parts.push('Shift');
  if (c.meta) parts.push('Super');
  parts.push(c.code);
  return parts.join('+');
}

/** Replace the registered system-wide shortcuts (desktop only). */
export async function setGlobalShortcuts(cfg: ShortcutConfig): Promise<ShortcutResult[] | null> {
  if (nativePlatform() !== 'desktop') return null;
  const config = {
    talk: cfg.talk ? chordToAccelerator(cfg.talk) : null,
    toggle: cfg.toggle ? chordToAccelerator(cfg.toggle) : null,
    brief: cfg.brief ? chordToAccelerator(cfg.brief) : null,
    stop: cfg.stop ? chordToAccelerator(cfg.stop) : null,
    passthrough: {
      talk: !!cfg.passthrough?.talk,
      toggle: !!cfg.passthrough?.toggle,
      brief: !!cfg.passthrough?.brief,
      stop: !!cfg.passthrough?.stop,
    },
  };
  return call<ShortcutResult[]>('herald_set_shortcuts', { config });
}

export async function getPassthroughStatus(): Promise<PassthroughStatus | null> {
  if (nativePlatform() !== 'desktop') return null;
  return call<PassthroughStatus>('herald_passthrough_status');
}

/** Status changes pushed by the native side (Windows: an elevated app took focus). */
export async function listenPassthroughStatus(cb: (s: PassthroughStatus) => void): Promise<() => void> {
  if (nativePlatform() !== 'desktop') return () => {};
  try {
    const { listen } = await import('@tauri-apps/api/event');
    return await listen<PassthroughStatus>(NATIVE_STATUS_EVENT, (e) => cb(e.payload));
  } catch {
    return () => {};
  }
}

/** macOS: ask for Input Monitoring (prompt once, then System Settings). True when granted. */
export async function requestInputMonitoring(): Promise<boolean> {
  if (nativePlatform() !== 'desktop') return false;
  return (await call<boolean>('herald_request_input_monitoring')) ?? false;
}

/** macOS: open System Settings > Privacy & Security > Input Monitoring (no prompt). */
export async function openInputMonitoringSettings(): Promise<boolean> {
  if (nativePlatform() !== 'desktop') return false;
  return (await call<boolean>('herald_open_input_monitoring')) ?? false;
}

export async function getNativeInfo(): Promise<NativeInfo | null> {
  if (nativePlatform() !== 'desktop') return null;
  return call<NativeInfo>('herald_native_info');
}

/** Keep the tray's "Mute tones" check and volume level in sync (desktop only). */
export async function setTrayState(muted: boolean, volume?: number): Promise<void> {
  if (nativePlatform() !== 'desktop') return;
  await call('herald_set_tray_state', volume === undefined ? { tonesMuted: muted } : { tonesMuted: muted, volume });
}

// ---------------------------------------------------------------- mobile

function isNativeMobile(): boolean {
  const p = nativePlatform();
  return p === 'android' || p === 'ios';
}

/** Earbud / headset play-pause belongs to Herald while on (mobile only). */
export async function setMediaSession(active: boolean): Promise<void> {
  if (!isNativeMobile()) return;
  await call('plugin:herald-native|set_media_session', { active });
}

/** Herald starts (true) / stops (false) speaking: other audio ducks meanwhile (mobile only). */
export async function setAudioFocus(active: boolean): Promise<void> {
  if (!isNativeMobile()) return;
  await call('plugin:herald-native|set_audio_focus', { active });
}

// ---------------------------------------------------------------- pairing

/**
 * Browse mDNS for `_companion._tcp` for about `timeoutMs` (all native apps).
 * Raw services `{name, host, addresses, port, txt}`; null in a browser or when
 * the native side lacks the command (older app).
 */
export async function discoverDaemonsNative(timeoutMs: number): Promise<unknown[] | null> {
  if (nativePlatform() === 'browser') return null;
  const r = await call<{ daemons?: unknown[] }>('plugin:herald-native|discover_daemons', { timeoutMs });
  return r && Array.isArray(r.daemons) ? r.daemons : null;
}

export const DEEP_LINK_EVENT = 'companion-deep-link';

/** A `companion://` link that launched / reopened the app (native only). */
export async function listenDeepLinks(cb: (url: string) => void): Promise<() => void> {
  const platform = nativePlatform();
  if (platform === 'browser') return () => {};
  const offs: Array<() => void> = [];
  try {
    if (platform === 'android') {
      const { addPluginListener } = await import('@tauri-apps/api/core');
      const l = await addPluginListener(PLUGIN, 'deepLink', (p: { url?: unknown }) => {
        if (typeof p?.url === 'string') cb(p.url);
      });
      offs.push(() => { void l.unregister().catch(() => {}); });
    } else {
      const { listen } = await import('@tauri-apps/api/event');
      offs.push(await listen<string>(DEEP_LINK_EVENT, (e) => { if (typeof e.payload === 'string') cb(e.payload); }));
    }
  } catch (err) {
    console.warn('[herald-native] deep link listen failed', err);
  }
  // The link that cold-started the app arrived before this listener.
  const pending = await call<{ url?: string | null }>('plugin:herald-native|take_pending_link');
  if (pending && typeof pending.url === 'string' && pending.url) cb(pending.url);
  return () => offs.forEach((f) => f());
}

// ---------------------------------------------------------------- secure storage

/** A small secret store (the paired-device tokens). */
export interface SecureStoreBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

async function invokeStrict<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/**
 * Android Keystore / iOS Keychain through the herald-native plugin (mobile
 * apps only; null on desktop and in a browser, which keep app storage).
 * Unlike the other bridge calls these REJECT on failure (an older native
 * build without the commands, a Keystore error): the caller must not drop a
 * plaintext copy it could not move.
 */
export function nativeSecureStore(platform: NativePlatform = nativePlatform()): SecureStoreBackend | null {
  if (platform !== 'android' && platform !== 'ios') return null;
  return {
    async get(key) {
      const r = await invokeStrict<{ value?: string | null } | null>('plugin:herald-native|secure_get', { key });
      return r && typeof r.value === 'string' ? r.value : null;
    },
    async set(key, value) {
      await invokeStrict('plugin:herald-native|secure_set', { key, value });
    },
    async delete(key) {
      await invokeStrict('plugin:herald-native|secure_delete', { key });
    },
  };
}
