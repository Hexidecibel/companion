import type { ServerSummary } from '../types';
import { needsYou } from './missionState';

export interface WaitingRef {
  serverId: string;
  sessionId: string;
  name: string;
  /** When it started waiting (summary waitingSince, else its lastActivity on older daemons). */
  waitingSince: number;
}

export interface SessionRef {
  serverId: string;
  sessionId: string;
}

/**
 * The sessions that need the user (a prompt or a question; not the ones that
 * just finished and reported back) across every server, the one waiting
 * longest first, without the current one. Pure (no stores).
 */
export function waitingSessions(
  summaries: Map<string, ServerSummary>,
  current?: SessionRef | null,
): WaitingRef[] {
  const out: WaitingRef[] = [];
  for (const [serverId, summary] of summaries) {
    for (const s of summary.sessions) {
      if (!needsYou(s) || s.inactive) continue;
      if (current && current.serverId === serverId && current.sessionId === s.id) continue;
      out.push({
        serverId,
        sessionId: s.id,
        name: s.friendlyName || s.name,
        waitingSince: s.waitingSince ?? s.lastActivity,
      });
    }
  }
  return out.sort((a, b) => a.waitingSince - b.waitingSince);
}

/** The next session to jump to (the one waiting longest), or null. */
export function nextWaiting(
  summaries: Map<string, ServerSummary>,
  current?: SessionRef | null,
): WaitingRef | null {
  return waitingSessions(summaries, current)[0] ?? null;
}
