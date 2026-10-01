/**
 * Floating orb (desktop app) and bring-to-front: the web side of
 * `desktop/src-tauri/src/overlay.rs`. The main window pushes views; the
 * overlay window (the same bundle, started with `window.__HERALD_OVERLAY__`)
 * renders them and reports its interactive regions.
 *
 * Every call is a no-op outside the desktop app and never throws: an older
 * native build without these commands must not break the page.
 */
import type { OverlayView } from './heraldSetup/overlay';
import { nativePlatform } from '../utils/platform';

export const OVERLAY_VIEW_EVENT = 'herald-overlay-view';

declare global {
  interface Window {
    __HERALD_OVERLAY__?: boolean;
  }
}

/** This page is the floating orb window, not the app. */
export function isOverlayWindow(): boolean {
  return typeof window !== 'undefined' && window.__HERALD_OVERLAY__ === true;
}

async function call(cmd: string, args?: Record<string, unknown>): Promise<boolean> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke(cmd, args);
    return true;
  } catch (err) {
    console.warn(`[herald-overlay] ${cmd} failed`, err);
    return false;
  }
}

// ---------------------------------------------------------------- main window

export async function pushOverlayView(view: OverlayView): Promise<void> {
  if (nativePlatform() !== 'desktop') return;
  await call('herald_overlay_update', { view });
}

/**
 * The floating orb is on / off for this device and profile. The native side
 * hides it at once when off and refuses to show it, and the tray item
 * ("Hide floating orb" / "Show floating orb") follows.
 */
export async function pushOverlayEnabled(enabled: boolean): Promise<void> {
  if (nativePlatform() !== 'desktop') return;
  await call('herald_overlay_set_enabled', { enabled });
}

/** Show and focus the Companion window (wake word / trigger). */
export async function bringToFront(): Promise<void> {
  if (nativePlatform() !== 'desktop') return;
  await call('herald_bring_to_front');
}

// ---------------------------------------------------------------- overlay window

export interface OverlayRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export async function listenOverlayView(cb: (v: OverlayView) => void): Promise<() => void> {
  try {
    const { listen } = await import('@tauri-apps/api/event');
    return await listen<OverlayView>(OVERLAY_VIEW_EVENT, (e) => cb(e.payload));
  } catch (err) {
    console.warn('[herald-overlay] listen failed', err);
    return () => {};
  }
}

export const overlayReady = () => call('herald_overlay_ready');
export const setOverlayRegions = (regions: OverlayRect[]) => call('herald_overlay_regions', { regions });
export const startOverlayDrag = () => call('herald_overlay_drag');
export const overlayAction = (action: 'stop' | 'open') => call('herald_overlay_action', { action });
