/**
 * Per-device Herald setup: the chosen profile, the device check result, and
 * the few settings that belong to the profile layer (floating orb, bring to
 * front, switch automatically). Stored in this browser / app install only.
 *
 * A tiny external store (like the native prefs), so the menu, the device
 * check, the overlay and the provider share it without another React context.
 */
import { useSyncExternalStore } from 'react';
import { syncToStore } from '../persistentStorage';
import { isProfileId, type EchoCheck, type ProfileId } from './profiles';
import type { NativePlatform } from '../../utils/platform';

export const SETUP_KEY = 'herald_setup';

export interface HeraldSetupState {
  /** Null until chosen (device check or menu). */
  profile: ProfileId | null;
  /** Switch profiles by themselves when the audio changes (else: suggest). */
  autoSwitch: boolean;
  /** The device check was finished or dismissed here (it never opens by itself again). */
  onboarded: boolean;
  /** Headphones profile: read whole replies aloud. */
  fullReplies: boolean;
  /** Floating orb (desktop app), outside the Gaming profile. */
  showOverlay: boolean;
  /** Floating orb while the Gaming profile is on (off unless the user turns it on). */
  overlayInGaming: boolean;
  /** "Hey Jarvis" / a trigger brings the Companion window to the front (never in Gaming). */
  bringToFront: boolean;
  /** Last echo check on this device. */
  echo: EchoCheck | null;
  /** Environment suggestions the user said no to (see environmentSuggestion). */
  dismissed: string[];
}

export const DEFAULT_SETUP: HeraldSetupState = {
  profile: null,
  autoSwitch: false,
  onboarded: false,
  fullReplies: false,
  showOverlay: true,
  overlayInGaming: false,
  bringToFront: false,
  echo: null,
  dismissed: [],
};

const MAX_DISMISSED = 24;

export function parseSetup(raw: string | null): HeraldSetupState {
  if (!raw) return DEFAULT_SETUP;
  try {
    const p = JSON.parse(raw) as Partial<HeraldSetupState>;
    const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
    const echo = p.echo && typeof p.echo === 'object'
      && typeof p.echo.erleDb === 'number' && typeof p.echo.residualSpeechDetected === 'boolean'
      ? { erleDb: p.echo.erleDb, residualSpeechDetected: p.echo.residualSpeechDetected, at: typeof p.echo.at === 'number' ? p.echo.at : 0 }
      : null;
    return {
      profile: isProfileId(p.profile) ? p.profile : null,
      autoSwitch: bool(p.autoSwitch, DEFAULT_SETUP.autoSwitch),
      onboarded: bool(p.onboarded, DEFAULT_SETUP.onboarded),
      fullReplies: bool(p.fullReplies, DEFAULT_SETUP.fullReplies),
      showOverlay: bool(p.showOverlay, DEFAULT_SETUP.showOverlay),
      overlayInGaming: bool(p.overlayInGaming, DEFAULT_SETUP.overlayInGaming),
      bringToFront: bool(p.bringToFront, DEFAULT_SETUP.bringToFront),
      echo,
      dismissed: Array.isArray(p.dismissed) ? p.dismissed.filter((d): d is string => typeof d === 'string').slice(-MAX_DISMISSED) : [],
    };
  } catch {
    return DEFAULT_SETUP;
  }
}

function load(): HeraldSetupState {
  try {
    return parseSetup(localStorage.getItem(SETUP_KEY));
  } catch {
    return DEFAULT_SETUP;
  }
}

let state: HeraldSetupState = load();
const listeners = new Set<() => void>();

function commit(next: HeraldSetupState): void {
  state = next;
  const json = JSON.stringify(next);
  try {
    localStorage.setItem(SETUP_KEY, json);
  } catch {
    // storage unavailable: this session only
  }
  // Native apps: survives a WebView data clear.
  syncToStore(SETUP_KEY, json);
  listeners.forEach((l) => l());
}

export const heraldSetupStore = {
  get: (): HeraldSetupState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
  set<K extends keyof HeraldSetupState>(key: K, value: HeraldSetupState[K]): void {
    if (state[key] === value) return;
    commit({ ...state, [key]: value });
  },
  patch(p: Partial<HeraldSetupState>): void {
    commit({ ...state, ...p });
  },
  dismissSuggestion(key: string): void {
    if (state.dismissed.includes(key)) return;
    commit({ ...state, dismissed: [...state.dismissed, key].slice(-MAX_DISMISSED) });
  },
  /** Tests only. */
  reset(): void {
    state = load();
    listeners.forEach((l) => l());
  },
};

export function useHeraldSetupState(): HeraldSetupState {
  return useSyncExternalStore(heraldSetupStore.subscribe, heraldSetupStore.get, heraldSetupStore.get);
}

/** Gaming mode is on (other features read this: no bring-to-front, quieter). */
export function isGamingMode(s: HeraldSetupState = state): boolean {
  return s.profile === 'gaming';
}

/** The floating orb is wanted on this device (desktop app only). */
export function overlayEnabled(s: HeraldSetupState, platform: NativePlatform): boolean {
  if (platform !== 'desktop') return false;
  return s.profile === 'gaming' ? s.overlayInGaming : s.showOverlay;
}

/** The "Show floating orb" switch edits the Gaming value while Gaming is on. */
export function setOverlayEnabled(on: boolean): void {
  heraldSetupStore.set(state.profile === 'gaming' ? 'overlayInGaming' : 'showOverlay', on);
}
