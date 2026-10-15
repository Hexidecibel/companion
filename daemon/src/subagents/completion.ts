/**
 * Subagent completion state machine (pure).
 *
 *   starting -> running -> (waiting_child) -> done | failed | stopped | lost
 *
 * - done / failed / stopped come ONLY from the parent's task-notification (or
 *   meta.stoppedByUser). Definitive, but not latched: transcript entries newer
 *   than the notification mean the agent was resumed (SendMessage) -> running.
 * - A pending tool keeps an agent running however long it is quiet (a 20-minute
 *   test run is not "done").
 * - Text-only assistant entries never complete an agent (Claude Code writes each
 *   content block as its own entry; a tool_use often follows a text entry).
 * - done_unconfirmed: the last assistant entry ended the turn and nothing was
 *   written since, but no notification arrived (parent unreadable, or late).
 * - lost: nothing pending, no notification, no bytes for 30 min.
 */

import type { SubagentStatus } from './protocol';
import type { NotifyStatus } from './notify';

export const LOST_AFTER_MS = 30 * 60 * 1000;
/** Quiet time after an end_turn before "finished (unconfirmed)", parent file unknown. */
export const UNCONFIRMED_NO_PARENT_MS = 30 * 1000;
/** Same, when the parent file is tailed (its notification normally lands within a second). */
export const UNCONFIRMED_WITH_PARENT_MS = 2 * 60 * 1000;
/** Entries this much newer than a notification mean the agent was resumed. */
export const RESUME_TOLERANCE_MS = 1500;
const STARTING_MS = 60 * 1000;

export interface CompletionInput {
  now: number;
  startedAt: number;
  /** Newest entry timestamp in the agent's transcript. */
  lastEntryAt: number;
  /** When the file last grew (our observation). */
  lastBytesAt: number;
  /** Assistant entries seen. */
  assistantEntries: number;
  /** Tools started but without a result. */
  pendingCount: number;
  /** An Agent / Task call is among the pending ones. */
  pendingAgentCall: boolean;
  /** A nested child agent is still active. */
  childActive: boolean;
  /** stop_reason of the newest assistant entry. */
  lastStopReason: string | null;
  notification: { status: NotifyStatus; at: number } | null;
  stoppedByUser: boolean;
  /** The parent transcript is being scanned for notifications. */
  parentKnown: boolean;
}

export function isActive(s: SubagentStatus): boolean {
  return s === 'starting' || s === 'running' || s === 'waiting_child';
}

export function isFinished(s: SubagentStatus): boolean {
  return !isActive(s);
}

/** True when transcript entries arrived after the notification (a resumed agent). */
export function resumedAfter(lastEntryAt: number, notifiedAt: number): boolean {
  return notifiedAt > 0 && lastEntryAt > notifiedAt + RESUME_TOLERANCE_MS;
}

export function deriveStatus(i: CompletionInput): SubagentStatus {
  const n = i.notification;
  if (n && !resumedAfter(i.lastEntryAt, n.at)) {
    if (i.stoppedByUser || n.status === 'stopped') return 'stopped';
    return n.status === 'failed' ? 'failed' : 'done';
  }
  if (i.pendingAgentCall) return 'waiting_child';
  if (i.pendingCount > 0) return 'running';
  if (i.childActive) return 'waiting_child';
  const quiet = i.now - Math.max(i.lastBytesAt, i.lastEntryAt);
  if (i.assistantEntries === 0) {
    if (quiet >= LOST_AFTER_MS) return 'lost';
    return i.now - i.startedAt < STARTING_MS ? 'starting' : 'running';
  }
  if (i.lastStopReason === 'end_turn') {
    if (i.stoppedByUser) return 'stopped';
    const wait = i.parentKnown ? UNCONFIRMED_WITH_PARENT_MS : UNCONFIRMED_NO_PARENT_MS;
    if (quiet >= wait) return 'done_unconfirmed';
    return 'running';
  }
  if (i.stoppedByUser && quiet >= UNCONFIRMED_NO_PARENT_MS) return 'stopped';
  if (quiet >= LOST_AFTER_MS) return 'lost';
  return 'running';
}

/** Legacy SubAgent.status for old clients. */
export function legacyStatus(s: SubagentStatus): 'running' | 'completed' | 'error' {
  if (isActive(s)) return 'running';
  return s === 'failed' ? 'error' : 'completed';
}
