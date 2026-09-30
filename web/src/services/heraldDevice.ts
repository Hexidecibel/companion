/**
 * This device's identity for Herald's active-device arbitration: a friendly
 * label ("Chrome on Windows", "Companion app on Android"), auto-detected and
 * renameable, plus a random device key that lets a pinned device keep its pin
 * across a quick reconnect. Both persist per browser / app install.
 */
import type { HeraldActiveDevice } from '../types/herald';

const LABEL_KEY = 'herald_device_label';
const DEVICE_KEY = 'herald_device_key';
export const MAX_LABEL_CHARS = 60;

export interface PlatformHints {
  userAgent: string;
  /** navigator.userAgentData?.platform or navigator.platform. */
  platform?: string;
  /** Running inside the Tauri shell (desktop or mobile app). */
  tauri?: boolean;
}

function osName(ua: string, platform: string): string | null {
  const u = ua.toLowerCase();
  const p = platform.toLowerCase();
  if (/android/.test(u)) return 'Android';
  if (/iphone/.test(u)) return 'iPhone';
  if (/ipad/.test(u) || (/macintosh/.test(u) && /mobile/.test(u))) return 'iPad';
  if (/windows/.test(u) || p.startsWith('win')) return 'Windows';
  if (/mac os x|macintosh/.test(u) || p.startsWith('mac')) return 'Mac';
  if (/cros/.test(u)) return 'ChromeOS';
  if (/linux|x11/.test(u) || p.startsWith('linux')) return 'Linux';
  return null;
}

function browserName(ua: string): string | null {
  if (/edg(e|a|ios)?\//i.test(ua)) return 'Edge';
  if (/opr\/|opera/i.test(ua)) return 'Opera';
  if (/firefox|fxios/i.test(ua)) return 'Firefox';
  if (/samsungbrowser/i.test(ua)) return 'Samsung Internet';
  if (/chrome|crios|chromium/i.test(ua)) return 'Chrome';
  if (/safari/i.test(ua)) return 'Safari';
  return null;
}

/** A readable default name for this device. */
export function detectDeviceLabel(h: PlatformHints): string {
  const os = osName(h.userAgent, h.platform ?? '');
  if (h.tauri) {
    if (os === 'Android' || os === 'iPhone' || os === 'iPad') return `Companion app on ${os}`;
    return os ? `${os} desktop` : 'Companion desktop';
  }
  const browser = browserName(h.userAgent) ?? 'Browser';
  return os ? `${browser} on ${os}` : browser;
}

export function cleanLabel(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_CHARS);
}

function currentHints(): PlatformHints {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const uaData = (nav as unknown as { userAgentData?: { platform?: string } } | null)?.userAgentData;
  return {
    userAgent: nav?.userAgent ?? '',
    platform: uaData?.platform || nav?.platform || '',
    tauri: typeof window !== 'undefined' && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
  };
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the name just won't persist
  }
}

/** The user's name for this device, if they set one. */
export function loadCustomLabel(): string | null {
  const v = read(LABEL_KEY);
  return v ? cleanLabel(v) || null : null;
}

/** Save a new name; empty resets to the detected one. Returns the label now in effect. */
export function saveCustomLabel(raw: string): string {
  const v = cleanLabel(raw);
  write(LABEL_KEY, v || null);
  return v || detectDeviceLabel(currentHints());
}

export function deviceLabel(): string {
  return loadCustomLabel() ?? detectDeviceLabel(currentHints());
}

export function defaultDeviceLabel(): string {
  return detectDeviceLabel(currentHints());
}

/** Stable random key for this browser / app install. */
export function deviceKey(): string {
  const existing = read(DEVICE_KEY);
  if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
  let key = '';
  try {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    key = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
  write(DEVICE_KEY, key);
  return key;
}

/** "Windows PC, pinned" style summary of the active device. */
export function describeActive(active: HeraldActiveDevice | null | undefined, selfId: string | null): string | null {
  if (!active) return null;
  const who = active.id === selfId ? 'This device' : active.label;
  return active.pinned ? `${who} · pinned` : who;
}
