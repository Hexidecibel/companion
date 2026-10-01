/**
 * "Show me" focus: after Herald opens a session, its message list scrolls to
 * the question / choice waiting there and highlights it, or to the latest
 * message. The request is parked here because the list usually mounts (and
 * loads) after the navigation, so it picks the request up when ready.
 */

export interface SessionFocusRequest {
  serverId: string;
  sessionId: string;
  /** The hub says a question / choice is waiting there. */
  pending: boolean;
  at: number;
}

/** A request older than this is stale (the list never loaded it). */
export const FOCUS_TTL_MS = 15_000;
/** How long the highlight stays on the prompt. */
export const FOCUS_HIGHLIGHT_MS = 2600;
export const FOCUS_CLASS = 'herald-focus-flash';

/** What the list should scroll to, in priority order (the newest wins within each). */
export const PROMPT_SELECTORS = ['.question-block', '.msg-approval-prompt'];

let current: SessionFocusRequest | null = null;
const listeners = new Set<() => void>();

export function requestSessionFocus(serverId: string, sessionId: string, pending: boolean, now = Date.now()): void {
  current = { serverId, sessionId, pending, at: now };
  for (const l of listeners) l();
}

/** Take the request for this session (once), or null. */
export function takeSessionFocus(sessionId: string, now = Date.now()): SessionFocusRequest | null {
  const c = current;
  if (!c || c.sessionId !== sessionId) return null;
  current = null;
  return now - c.at <= FOCUS_TTL_MS ? c : null;
}

/** Peek without consuming (the list waits until it has loaded). */
export function hasSessionFocus(sessionId: string, now = Date.now()): boolean {
  return !!current && current.sessionId === sessionId && now - current.at <= FOCUS_TTL_MS;
}

export function onSessionFocus(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The element to bring into view: the LAST waiting prompt in the list, or null. */
export function findPromptElement(root: ParentNode): HTMLElement | null {
  for (const sel of PROMPT_SELECTORS) {
    const all = root.querySelectorAll<HTMLElement>(sel);
    if (all.length > 0) return all[all.length - 1];
  }
  return null;
}

/** Test hook. */
export function _resetSessionFocus(): void {
  current = null;
  listeners.clear();
}
