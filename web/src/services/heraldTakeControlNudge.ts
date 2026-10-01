/**
 * "Use Herald here? Take control": a one-line nudge when the user talks to or
 * types to Herald on a device that is not the active one (the active device
 * keeps the tones, hands-free and remote triggers, so replies may play
 * elsewhere). Shown at most once per session, dismissible, never switches by
 * itself.
 */
export const NUDGE_SESSION_KEY = 'herald_take_control_nudged';

export interface NudgeInput {
  /** The hub reports devices (newer daemons). */
  supported: boolean;
  selfId: string | null;
  /** This device is the active one. */
  isActive: boolean;
  /** Already shown (or dismissed) in this session. */
  shownThisSession: boolean;
}

/** Herald was just used here: offer to take control? */
export function shouldNudgeTakeControl(i: NudgeInput): boolean {
  return i.supported && !!i.selfId && !i.isActive && !i.shownThisSession;
}

export function nudgeShownThisSession(): boolean {
  try {
    return sessionStorage.getItem(NUDGE_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

export function markNudgeShown(): void {
  try {
    sessionStorage.setItem(NUDGE_SESSION_KEY, '1');
  } catch {
    // storage unavailable: once per page load instead
  }
}
