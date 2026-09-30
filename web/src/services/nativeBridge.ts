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

export type NativeHeraldAction = 'talk_down' | 'talk_up' | 'toggle' | 'brief' | 'mute_tones';

const ACTIONS: ReadonlySet<string> = new Set<NativeHeraldAction>(['talk_down', 'talk_up', 'toggle', 'brief', 'mute_tones']);

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
}

/** Validate a native payload and run its handler. False when it was not ours. */
export function dispatchNativeEvent(payload: unknown, h: NativeHeraldHandlers): boolean {
  const action = (payload as { action?: unknown } | null)?.action;
  if (typeof action !== 'string' || !ACTIONS.has(action)) return false;
  switch (action as NativeHeraldAction) {
    case 'talk_down': h.talkDown(); break;
    case 'talk_up': h.talkUp(); break;
    case 'toggle': h.toggle(); break;
    case 'brief': h.brief(); break;
    case 'mute_tones': h.muteTones(); break;
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

export interface ShortcutConfig {
  talk?: string | null;
  toggle?: string | null;
  brief?: string | null;
}

export interface ShortcutResult {
  name: 'talk' | 'toggle' | 'brief';
  accelerator: string;
  ok: boolean;
  error: string | null;
}

export interface NativeInfo {
  os: string;
  /** Linux Wayland session: system-wide shortcuts only work while a Companion window is focused. */
  wayland: boolean;
}

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
  };
  return call<ShortcutResult[]>('herald_set_shortcuts', { config });
}

export async function getNativeInfo(): Promise<NativeInfo | null> {
  if (nativePlatform() !== 'desktop') return null;
  return call<NativeInfo>('herald_native_info');
}

/** Keep the tray's "Mute tones" check in sync (desktop only). */
export async function setTrayTonesMuted(muted: boolean): Promise<void> {
  if (nativePlatform() !== 'desktop') return;
  await call('herald_set_tray_state', { tonesMuted: muted });
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
