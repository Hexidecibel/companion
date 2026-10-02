/**
 * "Open the review drawer for session X" from outside the session view (the
 * Herald inbox chip). The session may not be mounted yet when asked, so the
 * request is parked here and consumed by that session's ReviewProvider when it
 * mounts (or immediately, if it is already showing).
 */
import { eventBus } from '../utils/eventBus';
import type { ReviewScope, ReviewView } from '../types/review';

export interface ReviewOpenOpts {
  scope?: ReviewScope;
  view?: ReviewView;
  focusTurnId?: string;
  focusEditId?: string;
}

const TTL_MS = 15_000;
let pending: { serverId: string; sessionId: string; at: number; opts: ReviewOpenOpts } | null = null;

export function requestReviewDrawer(serverId: string, sessionId: string, opts: ReviewOpenOpts = {}): void {
  pending = { serverId, sessionId, at: Date.now(), opts };
  eventBus.emit('review-open', { serverId, sessionId });
}

/** The parked request for this session, if any (consumes it). */
export function takeReviewOpen(serverId: string, sessionId: string): ReviewOpenOpts | null {
  if (!pending) return null;
  if (Date.now() - pending.at > TTL_MS) {
    pending = null;
    return null;
  }
  if (pending.serverId !== serverId || pending.sessionId !== sessionId) return null;
  const { opts } = pending;
  pending = null;
  return opts;
}
