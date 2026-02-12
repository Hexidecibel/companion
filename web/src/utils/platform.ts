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
 * Track visual viewport height and expose as --app-height CSS variable.
 * When the virtual keyboard opens, the visual viewport shrinks. Instead of
 * adding padding, we set the container height to the visible area so the
 * flex layout naturally keeps the input bar above the keyboard.
 *
 * Uses thresholds + debounce to avoid "sliding" during keyboard animations
 * and to ignore small changes from URL bar / autocomplete bar adjustments.
 *
 * On Tauri mobile (Android/iOS), the WebView resizes via adjustResize,
 * so the keyboard is already accounted for and we skip this entirely.
 */
export function initKeyboardHeightListener(): void {
  if (isTauriMobile()) return;

  const vv = window.visualViewport;
  if (!vv) return;

  let fullHeight = vv.height; // viewport height without keyboard
  let lastApplied = vv.height;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const apply = (height: number) => {
    lastApplied = height;
    document.documentElement.style.setProperty('--app-height', `${height}px`);
  };

  const update = () => {
    if (debounceTimer) clearTimeout(debounceTimer);

    const h = vv.height;

    // Viewport grew back (keyboard closing, URL bar hiding) — snap immediately
    if (h >= fullHeight) {
      fullHeight = h;
      if (Math.abs(h - lastApplied) > 5) {
        apply(h);
      }
      return;
    }

    const shrinkFromFull = fullHeight - h;
    const changeFromApplied = Math.abs(h - lastApplied);

    // Small shrink from full height (< 100px) — URL bar, autocomplete, ignore
    if (shrinkFromFull < 100) return;

    // Already tracking keyboard, small adjustment (< 50px) — ignore jitter
    if (changeFromApplied < 50) return;

    // Significant keyboard change — debounce to let animation settle
    debounceTimer = setTimeout(() => {
      apply(vv.height);
    }, 100);
  };

  vv.addEventListener('resize', update);
  apply(vv.height);
}
