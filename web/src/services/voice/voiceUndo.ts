/**
 * "Undo that": cancel the newest echo-tier action that is still counting down
 * (Herald read it back and will send it in a few seconds). Uses the ordinary
 * herald_confirm cancel, so the hub decides whether it was still in time.
 *
 * Pure over injected actions so every branch is unit-tested.
 */
import type { HeraldAction } from '../../types/herald';

export type UndoOutcome = 'cancelled' | 'too_late' | 'failed' | 'nothing' | 'stopped';

export interface UndoDeps {
  /** Current actions from Herald state. */
  actions: () => readonly HeraldAction[];
  /** herald_confirm cancel; the updated action, or null when the hub refused. */
  cancel: (actionId: string) => Promise<HeraldAction | null>;
  /** Herald is speaking right now (e.g. reading the action back). */
  speaking: () => boolean;
  /** Silence Herald (the readback, or a reply). */
  stopSpeech: () => void;
  /** Spoken confirmation (also shown briefly). */
  say: (text: string) => void;
}

export const UNDO_LINES = {
  cancelled: 'Cancelled.',
  tooLate: 'Too late, that already went.',
  failed: "I couldn't cancel that.",
  nothing: 'Nothing to undo.',
} as const;

/**
 * The newest pending echo-tier action (the one "undo that" means), or null.
 * A `suggested` card (the babysitter's suggested answer) is not one: it never
 * sends by itself, so there is nothing about to go that could be undone.
 */
export function undoTarget(actions: readonly HeraldAction[]): HeraldAction | null {
  let best: HeraldAction | null = null;
  for (const a of actions) {
    if (a.status !== 'pending' || a.tier !== 'echo' || a.suggested) continue;
    if (!best || a.createdAt > best.createdAt) best = a;
  }
  return best;
}

export async function runUndo(d: UndoDeps): Promise<UndoOutcome> {
  const target = undoTarget(d.actions());
  if (!target) {
    // "Cancel that" while Herald is talking, with nothing about to be sent:
    // the user wants it to stop, not a lecture about undo.
    if (d.speaking()) {
      d.stopSpeech();
      return 'stopped';
    }
    d.say(UNDO_LINES.nothing);
    return 'nothing';
  }
  // Silence the readback first: the confirmation must be heard, and fast.
  d.stopSpeech();
  let res: HeraldAction | null = null;
  try {
    res = await d.cancel(target.id);
  } catch {
    res = null;
  }
  if (res?.status === 'cancelled') {
    d.say(UNDO_LINES.cancelled);
    return 'cancelled';
  }
  if (res && (res.status === 'sent' || res.status === 'failed' || res.status === 'expired')) {
    d.say(UNDO_LINES.tooLate);
    return 'too_late';
  }
  // Refused: most often the countdown ran out while we were transcribing.
  const now = d.actions().find((a) => a.id === target.id);
  if (now && now.status === 'sent') {
    d.say(UNDO_LINES.tooLate);
    return 'too_late';
  }
  d.say(UNDO_LINES.failed);
  return 'failed';
}
