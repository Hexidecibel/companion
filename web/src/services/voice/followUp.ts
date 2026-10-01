/**
 * When to open the follow-up window: right after Herald finishes SPEAKING its
 * reply to a turn that came by VOICE from this device. Pure timing (inject
 * timers); the provider checks the rest (setting on, this device active, mic
 * already allowed, no echo pause) at the moment `arm` is called.
 *
 *   idle --voiceTurn--> awaiting --speaking--> replying --quiet + not busy for
 *   SETTLE_MS--> arm() --> idle
 *
 * A typed turn, STOP, a host switch or a long wait (AWAIT_MAX_MS) go back to
 * idle without arming. Speaking or thinking again during the settle restarts
 * it (the next sentence was still being synthesised).
 */

/** Quiet this long (and the turn over) before the window opens. Covers the echo tail. */
export const FOLLOW_UP_SETTLE_MS = 650;
/** A voice turn whose reply never got spoken stops waiting after this. */
export const FOLLOW_UP_AWAIT_MAX_MS = 90_000;

/** Window lengths offered in the menu (ms). */
export const FOLLOW_UP_CHOICES = [4000, 6000, 8000, 10000] as const;

type Timer = ReturnType<typeof setTimeout>;

export interface FollowUpTrackerDeps {
  /** The reply was heard: open the window now (the caller applies its own checks). */
  arm: () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
}

type Phase = 'idle' | 'awaiting' | 'replying';

export class FollowUpTracker {
  private phase: Phase = 'idle';
  private since = 0;
  private speaking = false;
  private busy = false;
  private settle: Timer | null = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (t: Timer) => void;

  constructor(private readonly d: FollowUpTrackerDeps) {
    this.now = d.now ?? (() => Date.now());
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t));
  }

  get state(): Phase {
    return this.phase;
  }

  /** A voice turn went out from this device (or a voice command that speaks: repeat, go on). */
  voiceTurn(): void {
    this.clearSettle();
    this.phase = 'awaiting';
    this.since = this.now();
    // Already speaking (a local "repeat"): that speech is the reply.
    if (this.speaking) this.phase = 'replying';
  }

  /** Typed turn, STOP, barge-in, host switch: no follow-up for this one. */
  cancel(): void {
    this.clearSettle();
    this.phase = 'idle';
  }

  /** Herald speaking / thinking changed. */
  update(s: { speaking: boolean; busy: boolean }): void {
    this.speaking = s.speaking;
    this.busy = s.busy;
    if (this.phase === 'idle') return;
    if (this.phase === 'awaiting') {
      if (this.now() - this.since > FOLLOW_UP_AWAIT_MAX_MS) {
        this.cancel();
        return;
      }
      if (s.speaking) this.phase = 'replying';
      else return;
    }
    // replying
    if (s.speaking || s.busy) {
      this.clearSettle();
      return;
    }
    if (this.settle) return;
    this.settle = this.setTimer(() => {
      this.settle = null;
      if (this.phase !== 'replying' || this.speaking || this.busy) return;
      this.phase = 'idle';
      this.d.arm();
    }, FOLLOW_UP_SETTLE_MS);
  }

  dispose(): void {
    this.cancel();
  }

  private clearSettle(): void {
    if (this.settle) this.clearTimer(this.settle);
    this.settle = null;
  }
}
