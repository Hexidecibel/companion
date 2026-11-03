/**
 * What a session means for the user on Mission Control. A "waiting" session
 * either needs them (a prompt, or the turn ended on a question) or is just
 * done and reported back (daemon `attention`). Older daemons send no
 * `attention`: waiting then counts as needs you. Pure.
 */
import type { SessionSummary } from '../types';

export type MissionState = 'needs_you' | 'done' | 'working' | 'idle' | 'error';
export type MissionSection = 'active' | 'quiet';

/** Waiting on the user (a prompt or a question), not just finished. */
export function needsYou(s: SessionSummary): boolean {
  return s.status === 'waiting' && s.attention !== 'done';
}

/**
 * A "done" session the user has already looked at reads as idle. `marked` =
 * the user marked it done by hand (services/markedDone, already checked for
 * newer activity): it reads as viewed and done, so idle, unless it works again.
 */
export function missionState(s: SessionSummary, unseen: boolean, marked = false): MissionState {
  if (s.status === 'working') return 'working';
  if (marked) return 'idle';
  if (s.status === 'error') return 'error';
  if (s.status === 'waiting') {
    if (needsYou(s)) return 'needs_you';
    return unseen ? 'done' : 'idle';
  }
  return 'idle';
}

/** Full tiles on top (needs you, working, unseen done, error); quiet rows below. */
export function missionSection(state: MissionState): MissionSection {
  return state === 'idle' ? 'quiet' : 'active';
}
