/**
 * A panel that owns keyboard focus while it is open (the Code Review drawer)
 * marks itself with `data-focus-trap`. Code that would otherwise grab focus
 * for the message composer (desktop keep-focused logic, post-send refocus,
 * prefill) checks this first, so it neither steals the panel's keyboard
 * shortcuts nor pops the soft keyboard on phones.
 */
export const FOCUS_TRAP_ATTR = 'data-focus-trap';

export function focusTrapActive(): boolean {
  return typeof document !== 'undefined' && !!document.querySelector(`[${FOCUS_TRAP_ATTR}]`);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Tabbable elements inside `root`, in DOM order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true',
  );
}
