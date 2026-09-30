/** Test helper: pretend to run in a browser tab or one of the Tauri apps. */
import type { NativePlatform } from '../utils/platform';

const UA: Record<NativePlatform | 'ipad', string> = {
  browser: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/130',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36',
  ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
  // iPadOS reports a Mac user agent; only touch support gives it away.
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
};

export function setNativeEnv(env: NativePlatform | 'ipad'): void {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (env === 'browser') delete w.__TAURI_INTERNALS__;
  else w.__TAURI_INTERNALS__ = {};
  Object.defineProperty(navigator, 'userAgent', { value: UA[env], configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { value: env === 'ipad' || env === 'ios' ? 5 : 0, configurable: true });
}
