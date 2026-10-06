/**
 * One way out of the app for links.
 *
 * In the Tauri apps a link must never navigate the webview: there is no back
 * button, so the user would be stranded on the other site. External URLs go to
 * the system browser through the opener plugin; the native navigation guard
 * (desktop/src-tauri/src/external_links.rs) is the backstop.
 */
import { isTauri } from './platform';

const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * Does this href lead out of the app? `base` is the page's own URL: relative
 * links and absolute links to the app's own origin (tauri://localhost,
 * http://tauri.localhost, the dev server) stay inside.
 */
export function isExternalHref(href: string | null | undefined, base: string): boolean {
  if (!href) return false;
  let url: URL;
  let own: URL;
  try {
    own = new URL(base);
    url = new URL(href, own);
  } catch {
    return false;
  }
  if (!EXTERNAL_SCHEMES.has(url.protocol)) return false;
  if (url.protocol === 'mailto:' || url.protocol === 'tel:') return true;
  return url.protocol !== own.protocol || url.host !== own.host;
}

/**
 * Open a URL outside the app: the system browser in the Tauri apps, a new tab
 * in a browser.
 */
export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('plugin:opener|open_url', { url });
  } catch (err) {
    console.warn('openExternal: opener failed, falling back to navigation guard', err);
    // The native guard refuses the navigation and opens the system browser.
    if (isExternalHref(url, window.location.href)) window.location.href = url;
  }
}

/** The anchor a click landed on, when following it would leave the app. */
export function externalAnchorHref(target: EventTarget | null, base: string): string | null {
  const el = target as Element | null;
  const link = el && typeof el.closest === 'function' ? el.closest('a') : null;
  if (!link) return null;
  if (link.hasAttribute('download')) return null;
  const href = link.getAttribute('href');
  if (!isExternalHref(href, base)) return null;
  try {
    return new URL(href!, base).toString();
  } catch {
    return null;
  }
}

/**
 * Install a global click interceptor for external links on Tauri.
 *
 * A plain click would navigate the webview itself (no back button: the user is
 * stranded), and target="_blank" / middle click is a new-window request the
 * webview drops. Every click on an external <a> is taken over and handed to
 * the system browser instead.
 */
export function installExternalLinkHandler(): void {
  if (!isTauri()) return;

  const onClick = (e: MouseEvent) => {
    const href = externalAnchorHref(e.target, window.location.href);
    if (!href) return;

    e.preventDefault();
    e.stopPropagation();
    void openExternal(href);
  };
  document.addEventListener('click', onClick, true);
  // Middle click.
  document.addEventListener('auxclick', (e) => {
    if (e.button === 1) onClick(e);
  }, true);
}
