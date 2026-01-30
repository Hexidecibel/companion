/**
 * Epoch-based guard that prevents stale responses from leaking across
 * rapid session switches. Each call to `beginSwitch` increments the epoch.
 * Incoming poll/broadcast data is validated via `isValid()`.
 */

let currentServerId: string | null = null;
let currentSessionId: string | null = null;
let epoch = 0;

export function beginSwitch(serverId: string, sessionId: string): number {
  currentServerId = serverId;
  currentSessionId = sessionId;
  epoch += 1;
  return epoch;
}

export function isValid(
  serverId: string,
  sessionId: string,
  guardEpoch: number,
): boolean {
  return (
    serverId === currentServerId &&
    sessionId === currentSessionId &&
    guardEpoch === epoch
  );
}

export function getCurrentEpoch(): number {
  return epoch;
}

export function getCurrentSession(): { serverId: string | null; sessionId: string | null } {
  return { serverId: currentServerId, sessionId: currentSessionId };
}
