/**
 * Fleet-wide "Herald is speaking" signal (hub side).
 *
 * Echo cancellation only removes Herald's voice on the device that PLAYS it:
 * a second device nearby hears Herald with nothing to cancel it against. The
 * speaking device reports `herald_speaking` start (repeated every ~1 s as a
 * heartbeat) and end; this tracker keeps the current speaker, broadcasts each
 * change as a `speaking` herald_event, and answers "is this device inside
 * someone else's speaking window?" for the voice-send backstop.
 *
 * The window: from a start until an end (or a missed heartbeat, or the cap),
 * plus a short tail for the room. One speaker at a time: a start from another
 * device takes over (the last device to start is the one playing).
 */
import type { HeraldSpeakingSignal } from '../protocol';

export const SPEAKING_LIMITS = {
  /** No heartbeat for this long: the speaker is treated as stopped (end lost). */
  heartbeatTimeoutMs: 2500,
  /** One utterance holds the window at most this long (a stuck client cannot mute the fleet). */
  maxMs: 30_000,
  /** After the end, the room still rings: other devices keep holding back this long. */
  tailMs: 800,
  /** Estimates further out than this are clamped. */
  maxRemainingMs: 30_000,
};

const UTTERANCE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class SpeakingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpeakingError';
  }
}

interface Speaker {
  clientId: string;
  utteranceId: string;
  startedAt: number;
  beatAt: number;
  /** Hub-clock estimate of the playback end (0 = unknown). */
  endAt: number;
}

export interface SpeakingTrackerOptions {
  /** Broadcast a change to every device. */
  broadcast: (signal: HeraldSpeakingSignal) => void;
  /** Friendly name of a device (for "Speaking on <device>"). */
  labelOf: (clientId: string) => string;
  now?: () => number;
  limits?: Partial<typeof SPEAKING_LIMITS>;
  /** Debug log line (rejections, timeouts). */
  debug?: (line: string) => void;
}

export class SpeakingTracker {
  private speaker: Speaker | null = null;
  /** When the last speaker stopped (for the tail) and who it was. */
  private endedAt = 0;
  private endedBy: string | null = null;
  /** An utterance that hit the cap: its heartbeats never reopen the window. */
  private capped: { clientId: string; utteranceId: string } | null = null;
  private readonly limits: typeof SPEAKING_LIMITS;
  private readonly now: () => number;

  constructor(private opts: SpeakingTrackerOptions) {
    this.limits = { ...SPEAKING_LIMITS, ...(opts.limits || {}) };
    this.now = opts.now || Date.now;
  }

  /** herald_speaking from `clientId`. Throws SpeakingError on a malformed report. */
  report(clientId: string, raw: unknown): { ok: true } {
    const p = (raw || {}) as {
      state?: unknown;
      utteranceId?: unknown;
      approxEndAt?: unknown;
      sentAt?: unknown;
    };
    if (p.state !== 'start' && p.state !== 'end')
      throw new SpeakingError("state must be 'start' or 'end'");
    if (typeof p.utteranceId !== 'string' || !UTTERANCE_ID.test(p.utteranceId))
      throw new SpeakingError('utteranceId must be 1-64 characters of [A-Za-z0-9_-]');
    this.expire();
    const now = this.now();
    if (p.state === 'end') {
      const s = this.speaker;
      if (s && s.clientId === clientId && s.utteranceId === p.utteranceId) this.finish('end');
      return { ok: true };
    }
    const c = this.capped;
    if (c && c.clientId === clientId && c.utteranceId === p.utteranceId) return { ok: true };
    const remaining = remainingFrom(p.approxEndAt, p.sentAt, this.limits.maxRemainingMs);
    const cur = this.speaker;
    if (cur && cur.clientId === clientId && cur.utteranceId === p.utteranceId) {
      cur.beatAt = now;
      cur.endAt = remaining > 0 ? now + remaining : 0;
    } else {
      // A new utterance (or another device took over: the newest start is playing).
      this.speaker = {
        clientId,
        utteranceId: p.utteranceId,
        startedAt: now,
        beatAt: now,
        endAt: remaining > 0 ? now + remaining : 0,
      };
    }
    this.emit(true);
    return { ok: true };
  }

  /** The device that is speaking now (null: nobody). */
  get speakerId(): string | null {
    this.expire();
    return this.speaker?.clientId ?? null;
  }

  get utteranceId(): string | null {
    this.expire();
    return this.speaker?.utteranceId ?? null;
  }

  /**
   * `clientId` is inside ANOTHER device's speaking window (speaking now, or
   * stopped less than the tail ago): its hands-off voice input may be Herald.
   */
  suppresses(clientId: string): boolean {
    this.expire();
    const s = this.speaker;
    if (s) return s.clientId !== clientId;
    return (
      this.endedBy !== null &&
      this.endedBy !== clientId &&
      this.now() - this.endedAt < this.limits.tailMs
    );
  }

  /** Someone asked the speaker to stop: the window closes now (the tail still applies). */
  stopped(clientId: string): void {
    if (this.speaker?.clientId === clientId) this.finish('stopped');
  }

  /** Disconnected: a speaker that is gone is not speaking. */
  clientGone(clientId: string): void {
    if (this.speaker?.clientId === clientId) this.finish('gone');
  }

  /** Periodic check: a lost `end` (no heartbeat) or the cap ends the window. */
  sweep(): void {
    this.expire();
  }

  private expire(): void {
    const s = this.speaker;
    if (!s) return;
    const now = this.now();
    if (now - s.beatAt > this.limits.heartbeatTimeoutMs) this.finish('timeout');
    else if (now - s.startedAt > this.limits.maxMs) this.finish('cap');
  }

  private finish(why: 'end' | 'stopped' | 'gone' | 'timeout' | 'cap'): void {
    const s = this.speaker;
    if (!s) return;
    if (why === 'timeout' || why === 'cap') {
      this.opts.debug?.(`Herald voice: speaking window on ${s.clientId} closed (${why})`);
    }
    this.emit(false);
    this.speaker = null;
    this.capped = why === 'cap' ? { clientId: s.clientId, utteranceId: s.utteranceId } : null;
    this.endedAt = this.now();
    this.endedBy = s.clientId;
  }

  private emit(active: boolean): void {
    const s = this.speaker;
    if (!s) return;
    const signal: HeraldSpeakingSignal = {
      active,
      deviceId: s.clientId,
      label: this.opts.labelOf(s.clientId),
      utteranceId: s.utteranceId,
      remainingMs: active && s.endAt > 0 ? Math.max(0, s.endAt - this.now()) : 0,
    };
    try {
      this.opts.broadcast(signal);
    } catch (err) {
      console.error('Herald voice: speaking broadcast failed:', err);
    }
  }
}

/** Playback left per the sender's own clock (skew-free), clamped; 0 = unknown. */
function remainingFrom(approxEndAt: unknown, sentAt: unknown, max: number): number {
  if (typeof approxEndAt !== 'number' || !Number.isFinite(approxEndAt)) return 0;
  const base = typeof sentAt === 'number' && Number.isFinite(sentAt) ? sentAt : Date.now();
  return Math.max(0, Math.min(max, approxEndAt - base));
}
