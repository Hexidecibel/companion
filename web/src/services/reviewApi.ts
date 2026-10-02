/**
 * Thin typed wrapper over the Code Review request/response messages.
 * Failures carry the daemon's ReviewErrorCode when it sent one.
 */
import type { ReviewErrorCode } from '../types/review';
import { connectionManager } from './ConnectionManager';

export class ReviewRequestError extends Error {
  constructor(message: string, readonly code: ReviewErrorCode | null) {
    super(message);
    this.name = 'ReviewRequestError';
  }
}

export type ReviewRequestFn = <T>(type: string, payload: unknown, timeoutMs?: number) => Promise<T>;

const FRIENDLY: Partial<Record<ReviewErrorCode, string>> = {
  unknown_session: 'This session is no longer known to the server.',
  unavailable: 'Review data is not available for this session.',
  expired: 'That confirmation expired. Try again.',
  busy: 'The server is busy. Try again in a moment.',
  herald_unavailable: 'Herald is not available right now.',
  session_waiting: 'The session is waiting on a choice. Answer it first.',
  not_found: 'That change could not be found any more.',
  blocked: 'The server refused this action.',
  tier_mismatch: 'This revert needs a press-and-hold confirmation.',
};

export function reviewErrorMessage(err: unknown): string {
  if (err instanceof ReviewRequestError) return (err.code && FRIENDLY[err.code]) || err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Request bound to one server. */
export function reviewRequester(serverId: string | null | undefined): ReviewRequestFn {
  return async <T,>(type: string, payload: unknown, timeoutMs = 15000): Promise<T> => {
    if (!serverId) throw new ReviewRequestError('No server', null);
    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) throw new ReviewRequestError('Not connected', null);
    const res = await conn.sendRequest(type, payload, timeoutMs);
    if (!res.success) {
      const code = ((res.payload as { code?: ReviewErrorCode } | undefined)?.code) ?? null;
      throw new ReviewRequestError(res.error || code || 'Request failed', code);
    }
    return res.payload as T;
  };
}
