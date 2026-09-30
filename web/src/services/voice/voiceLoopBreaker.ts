/**
 * Last line of defence against Herald talking to itself: if speech keeps
 * sending messages on its own (more than LOOP_MAX_SENDS within LOOP_WINDOW_MS)
 * with no keyboard, mouse, touch or hotkey use in between, it is almost
 * certainly Herald's own voice coming back through the speakers. Auto-send
 * pauses (transcripts wait in the composer for the user) until the user
 * interacts again or resumes it.
 *
 * Pure (inject `now`), no React / DOM.
 */

export const LOOP_MAX_SENDS = 3;
export const LOOP_WINDOW_MS = 20_000;

export class VoiceLoopBreaker {
  private sends: number[] = [];
  private pausedFlag = false;
  private listeners = new Set<(paused: boolean) => void>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  get paused(): boolean {
    return this.pausedFlag;
  }

  /** Keyboard, mouse, touch or a hotkey: a person is here. Resumes auto-send. */
  noteInteraction(): void {
    this.sends = [];
    this.setPaused(false);
  }

  /** Resume auto-send by hand (same as an interaction). */
  resume(): void {
    this.noteInteraction();
  }

  /**
   * A voice transcript is about to be sent without anyone touching anything
   * (talk-over interrupt, hands-free). True: go ahead. False: auto-send is
   * paused, hold it for review.
   */
  allowSend(): boolean {
    if (this.pausedFlag) return false;
    const t = this.now();
    // (An interaction clears the list, so only hands-off sends are here.)
    this.sends = this.sends.filter((s) => s > t - LOOP_WINDOW_MS);
    if (this.sends.length >= LOOP_MAX_SENDS) {
      this.setPaused(true);
      return false;
    }
    this.sends.push(t);
    return true;
  }

  subscribe(l: (paused: boolean) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private setPaused(p: boolean): void {
    if (p === this.pausedFlag) return;
    this.pausedFlag = p;
    for (const l of [...this.listeners]) l(p);
  }
}
