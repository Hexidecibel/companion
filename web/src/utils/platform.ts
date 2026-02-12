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

/** Minimum height change to be considered a keyboard event (vs URL bar). */
const KEYBOARD_THRESHOLD = 100;

export interface KeyboardHandler {
  /** Process a viewport resize. Call with the current visualViewport.height. */
  handleResize(viewportHeight: number): void;
  /** Whether the keyboard is currently detected as open. */
  isKeyboardOpen(): boolean;
  /** The current "full" (no-keyboard) baseline height. */
  getFullHeight(): number;
}

/**
 * Create a keyboard height handler. Extracted for testability.
 * @param initialHeight - the viewport height at init time
 * @param setProperty - called with height string when keyboard opens/resizes
 * @param removeProperty - called when keyboard closes
 */
export function createKeyboardHandler(
  initialHeight: number,
  setProperty: (value: string) => void,
  removeProperty: () => void,
): KeyboardHandler {
  let fullHeight = initialHeight;
  let keyboardOpen = false;
  let lastAppliedHeight = initialHeight;

  return {
    handleResize(viewportHeight: number) {
      // Viewport grew back to full size — keyboard closed
      if (viewportHeight >= fullHeight) {
        fullHeight = viewportHeight;
        lastAppliedHeight = viewportHeight;
        if (keyboardOpen) {
          keyboardOpen = false;
          removeProperty();
        }
        return;
      }

      const shrinkFromFull = fullHeight - viewportHeight;

      // Small shrink (< threshold) — URL bar or keyboard closed with URL bar visible
      if (shrinkFromFull < KEYBOARD_THRESHOLD) {
        if (keyboardOpen) {
          // Was keyboard-open, now close to full → keyboard closed
          keyboardOpen = false;
          lastAppliedHeight = viewportHeight;
          removeProperty();
        }
        return;
      }

      // Keyboard is open — but ignore small jitter (< 40px) from autocomplete
      // bar or suggestion strip changes while typing
      const changeFromApplied = Math.abs(viewportHeight - lastAppliedHeight);
      if (keyboardOpen && changeFromApplied < 40) return;

      keyboardOpen = true;
      lastAppliedHeight = viewportHeight;
      setProperty(`${viewportHeight}px`);
    },

    isKeyboardOpen() {
      return keyboardOpen;
    },

    getFullHeight() {
      return fullHeight;
    },
  };
}

export function initKeyboardHeightListener(): void {
  if (isTauriMobile()) return;

  const vv = window.visualViewport;
  if (!vv) return;

  const style = document.documentElement.style;
  const handler = createKeyboardHandler(
    vv.height,
    (value) => style.setProperty('--app-height', value),
    () => style.removeProperty('--app-height'),
  );

  vv.addEventListener('resize', () => handler.handleResize(vv.height));
  // Do NOT set --app-height on init — let CSS 100dvh handle the default
}
