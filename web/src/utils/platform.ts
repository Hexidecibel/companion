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

/**
 * Apply safe area insets for Tauri mobile.
 * On Android, env(safe-area-inset-top) often returns 0 even with edge-to-edge,
 * so we set CSS custom properties with a JS fallback.
 */
export function applySafeAreaInsets(): void {
  if (!isTauriMobile()) return;
  const style = document.documentElement.style;
  // Android status bar is typically 24dp; with edge-to-edge on high-DPI
  // devices this is around 48px. Check if env() already provides a value.
  const test = getComputedStyle(document.documentElement).getPropertyValue('--safe-top').trim();
  if (!test || test === '0px') {
    style.setProperty('--safe-top', '48px');
  }
  // Navigation bar (gesture pill) height — usually 48px on gesture nav
  const testBottom = getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom').trim();
  if (!testBottom || testBottom === '0px') {
    style.setProperty('--safe-bottom', '24px');
  }
}

/**
 * Track keyboard height via visualViewport API and expose as CSS variable.
 * When the virtual keyboard opens on mobile, the visual viewport shrinks
 * but the layout viewport stays the same. We compute the difference and
 * set --keyboard-height so CSS can adjust bottom-fixed elements.
 *
 * On Tauri mobile (Android/iOS), the WebView resizes via adjustResize,
 * so the keyboard is already accounted for and we skip the CSS variable
 * to avoid double-counting (WebView shrink + CSS padding).
 */
export function initKeyboardHeightListener(): void {
  // Tauri mobile WebViews handle keyboard resize natively via adjustResize.
  // Adding CSS padding on top would double-count, pushing the input bar too high.
  if (isTauriMobile()) return;

  const vv = window.visualViewport;
  if (!vv) return;

  const update = () => {
    const keyboardHeight = Math.max(0, window.innerHeight - vv.height);
    document.documentElement.style.setProperty('--keyboard-height', `${keyboardHeight}px`);
  };

  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
}
