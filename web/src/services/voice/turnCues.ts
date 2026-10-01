/**
 * Sound cues around a voice turn, so the wait between "I stopped talking" and
 * Herald's first word is never dead air:
 *
 *   tick     the moment end-of-speech is detected (the capture goes to
 *            transcribing): a tiny soft tick, under 80 ms. On by default.
 *   shimmer  a very subtle looping "thinking" tone when no audio has started
 *            SHIMMER_AFTER_MS after end-of-speech and a turn really went out.
 *            Off by default (Advanced). Stops the instant Herald speaks, when
 *            the turn ends, when nothing was sent (a local command, an echo,
 *            "didn't catch that"), and after SHIMMER_MAX_MS whatever happens.
 *
 * Pure timing over injected sound functions (fake timers in tests).
 */

export const SHIMMER_AFTER_MS = 1500;
/** No turn went out this long after end-of-speech: it was not a turn. */
export const TURN_SENT_GRACE_MS = 6000;
export const SHIMMER_MAX_MS = 20_000;

type Timer = ReturnType<typeof setTimeout>;

export interface TurnCueDeps {
  tick: () => void;
  /** Start the shimmer loop; returns its stop function. */
  startShimmer: () => () => void;
  tickOn: () => boolean;
  shimmerOn: () => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
}

export class TurnCues {
  private endAt = 0;
  private armed = false;
  private sent = false;
  private stopShimmer: (() => void) | null = null;
  private timers: Timer[] = [];
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (t: Timer) => void;

  constructor(private readonly d: TurnCueDeps) {
    this.now = d.now ?? (() => Date.now());
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t));
  }

  /** The shimmer is playing (tests, diagnostics). */
  get shimmering(): boolean {
    return this.stopShimmer !== null;
  }

  /** A voice capture ended and is being transcribed. */
  endOfSpeech(): void {
    this.reset();
    if (this.d.tickOn()) this.d.tick();
    if (!this.d.shimmerOn()) return;
    this.armed = true;
    this.endAt = this.now();
    this.later(() => this.maybeStart(), SHIMMER_AFTER_MS);
    this.later(() => { if (!this.sent) this.reset(); }, TURN_SENT_GRACE_MS);
  }

  /** The transcript went out as a voice turn (or a brain request). */
  turnSent(): void {
    if (!this.armed) return;
    this.sent = true;
    if (this.now() - this.endAt >= SHIMMER_AFTER_MS) this.maybeStart();
  }

  /** Herald's first audio started: silence the shimmer for good. */
  audioStarted(): void {
    this.reset();
  }

  /** The turn finished (busy went false) or nothing was sent: stop. */
  turnDone(): void {
    this.reset();
  }

  dispose(): void {
    this.reset();
  }

  private maybeStart(): void {
    if (!this.armed || !this.sent || this.stopShimmer || !this.d.shimmerOn()) return;
    this.stopShimmer = this.d.startShimmer();
    const left = Math.max(0, SHIMMER_MAX_MS - (this.now() - this.endAt));
    this.later(() => this.reset(), left);
  }

  private later(fn: () => void, ms: number): void {
    this.timers.push(this.setTimer(fn, ms));
  }

  private reset(): void {
    for (const t of this.timers) this.clearTimer(t);
    this.timers = [];
    this.armed = false;
    this.sent = false;
    const stop = this.stopShimmer;
    this.stopShimmer = null;
    stop?.();
  }
}
