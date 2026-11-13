/**
 * Keeps the chat in step with a live AskUserQuestion box.
 *
 * Claude Code writes nothing to the transcript while the picker is up: not
 * when it appears, not when the user checks a box or moves to the next
 * question in the terminal, not on the review screen. Without a capture the
 * chat learns of it only on its own 30 s poll. So:
 *
 *  - probe(session): after a transcript write (the turn that may end in a
 *    question), capture the pane a few times over the next 30 s
 *    (PROBE_SCHEDULE_MS, restarted by every write, so a busy session costs
 *    nothing until it goes quiet).
 *  - once a box is seen (or watch() after an answer), capture every
 *    LIVE_INTERVAL_MS while it stays up, at most LIVE_MAX_MS.
 *  - every change of what the card shows (question, tab, checks, typed
 *    Other text, review) and the box going away emits one update.
 *
 * One capture in flight per session; captures are bounded by the injector's
 * tmux timeout. Timers are unref'd and all cleared by stopAll().
 */
import type { TerminalChoicePrompt } from './types';

export interface LiveChoiceWatchDeps {
  /** ANSI capture of the pane, or null when it cannot be read. */
  capture(session: string): Promise<string | null>;
  /** Feed the capture to the watcher's caches; returns the AskUserQuestion box on it (or null). */
  note(session: string, pane: string): TerminalChoicePrompt | null;
  /** Tell clients to refetch the session (conversation-update). */
  emitUpdate(session: string): void;
  now?: () => number;
}

/** Delays from the last transcript write at which a probe captures. */
export const PROBE_SCHEDULE_MS = [1500, 3000, 5000, 8000, 12000, 20000, 30000];
export const LIVE_INTERVAL_MS = 1000;
export const LIVE_MAX_MS = 30 * 60 * 1000;
/** After an answer: first look this soon. */
export const AFTER_ANSWER_DELAY_MS = 400;

interface Entry {
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
  live: boolean;
  liveSince: number;
  probeStart: number;
  probeStep: number;
  lastSig: string | null;
  /** Emit on the next tick whatever it sees (an answer was just sent). */
  force: boolean;
}

/** What the chat card shows: a change means clients must refetch. Cursor moves do not count. */
export function liveChoiceStateSig(c: TerminalChoicePrompt): string {
  const a = c.auq;
  return JSON.stringify([
    c.header || '',
    c.question,
    c.options.map((o) => [o.label, o.description || '', !!o.selected]),
    a?.screen,
    a?.activeTab,
    a?.tabs?.map((t) => [t.label, t.answered]),
    a?.other?.text ?? null,
    !!a?.other?.checked,
    a?.review ?? null,
    !!a?.incomplete,
  ]);
}

export class LiveChoiceWatch {
  private entries = new Map<string, Entry>();
  private now: () => number;

  constructor(private deps: LiveChoiceWatchDeps) {
    this.now = deps.now ?? Date.now;
  }

  private entry(session: string): Entry {
    let e = this.entries.get(session);
    if (!e) {
      e = {
        timer: null,
        inFlight: false,
        live: false,
        liveSince: 0,
        probeStart: 0,
        probeStep: 0,
        lastSig: null,
        force: false,
      };
      this.entries.set(session, e);
    }
    return e;
  }

  /** A transcript write: look for a box over the next 30 s (restarts the schedule). */
  probe(session: string): void {
    const e = this.entry(session);
    if (e.live) return;
    e.probeStart = this.now();
    e.probeStep = 0;
    this.schedule(session, e, PROBE_SCHEDULE_MS[0]);
  }

  /** An answer was just sent: follow the box until it goes away. */
  watch(session: string): void {
    const e = this.entry(session);
    e.live = true;
    e.liveSince = this.now();
    e.force = true;
    this.schedule(session, e, AFTER_ANSWER_DELAY_MS);
  }

  /**
   * A box was seen by someone else's capture (get_highlights): follow it from
   * here without an update for what the caller already has.
   */
  follow(session: string, box: TerminalChoicePrompt): void {
    const e = this.entry(session);
    if (e.live) return;
    e.live = true;
    e.liveSince = this.now();
    e.lastSig = liveChoiceStateSig(box);
    this.schedule(session, e, LIVE_INTERVAL_MS);
  }

  isWatching(session: string): boolean {
    return !!this.entries.get(session)?.live;
  }

  stop(session: string): void {
    const e = this.entries.get(session);
    if (e?.timer) clearTimeout(e.timer);
    this.entries.delete(session);
  }

  stopAll(): void {
    for (const e of this.entries.values()) if (e.timer) clearTimeout(e.timer);
    this.entries.clear();
  }

  private schedule(session: string, e: Entry, ms: number): void {
    if (e.timer) clearTimeout(e.timer);
    e.timer = setTimeout(() => {
      e.timer = null;
      void this.tick(session, e);
    }, ms);
    e.timer.unref?.();
  }

  private async tick(session: string, e: Entry): Promise<void> {
    if (this.entries.get(session) !== e) return;
    if (e.inFlight) {
      this.schedule(session, e, LIVE_INTERVAL_MS);
      return;
    }
    e.inFlight = true;
    let box: TerminalChoicePrompt | null = null;
    let readable = true;
    try {
      const pane = await this.deps.capture(session);
      if (pane === null) readable = false;
      else box = this.deps.note(session, pane);
    } catch {
      readable = false;
    } finally {
      e.inFlight = false;
    }
    if (this.entries.get(session) !== e) return;

    if (readable) {
      const sig = box ? liveChoiceStateSig(box) : null;
      if (e.force || sig !== e.lastSig) {
        if (e.force || sig !== null || e.lastSig !== null) this.deps.emitUpdate(session);
        e.lastSig = sig;
        e.force = false;
      }
    }

    if (box) {
      if (!e.live) {
        e.live = true;
        e.liveSince = this.now();
      }
      if (this.now() - e.liveSince > LIVE_MAX_MS) {
        this.stop(session);
        return;
      }
      this.schedule(session, e, LIVE_INTERVAL_MS);
      return;
    }
    if (e.live && readable) {
      // The box went away (answered, cancelled): done until the next probe.
      e.live = false;
      e.lastSig = null;
      return;
    }
    if (e.live) {
      // Unreadable pane while live: try again, within the cap.
      if (this.now() - e.liveSince > LIVE_MAX_MS) this.stop(session);
      else this.schedule(session, e, LIVE_INTERVAL_MS);
      return;
    }
    // Probing: next step of the schedule, if any.
    e.probeStep++;
    if (e.probeStep >= PROBE_SCHEDULE_MS.length) return;
    const due = e.probeStart + PROBE_SCHEDULE_MS[e.probeStep];
    this.schedule(session, e, Math.max(0, due - this.now()));
  }
}
