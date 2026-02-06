/** Detect whether we're running inside a Tauri WebView (any platform). */
export function isTauri(): boolean {
  return !!(window as any).__TAURI_INTERNALS__;
}

/** Detect mobile viewport (used as a layout hint, not a platform check). */
export function isMobileViewport(): boolean {
  return window.innerWidth <= 768;
}

/** Detect touch-primary device (phones/tablets). */
export function isTouchDevice(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

/**
 * Detect Tauri mobile (Android or iOS WebView).
 * Tauri 2.0 mobile sets `__TAURI_INTERNALS__` the same as desktop,
 * so we combine it with UA and touch detection.
 */
export function isTauriMobile(): boolean {
  if (!isTauri()) return false;
  const ua = navigator.userAgent.toLowerCase();
  return /android|iphone|ipad/.test(ua) || (isTouchDevice() && isMobileViewport());
}

/** Tauri desktop (macOS, Linux, Windows). */
export function isTauriDesktop(): boolean {
  return isTauri() && !isTauriMobile();
}
