/**
 * What Herald said recently, so voice input can recognise (and drop) Herald's
 * own voice coming back through the speakers. Echo cancellation in the capture
 * constraints is not enough: WKWebView (the macOS app) does not cancel our
 * WebAudio playback at all, so without this Herald hears itself, barges in on
 * itself, and sends its own words back as a user message, in a loop.
 *
 * Pure (inject `now`), no React / DOM.
 */
import type { TtsEngine } from '../tts/types';
import { isClearBargeIn, isLikelyEcho, stripEcho } from './echoMatch';

/** Sentences queued or played this recently count as "just said". */
export const ECHO_WINDOW_MS = 10_000;
/**
 * A transcript of one or two words is only called echo when Herald was talking
 * (or stopped less than this long ago): "yes" a minute later is an answer.
 */
export const SHORT_ECHO_WINDOW_MS = 4000;
/** A pause shorter than this (next sentence still being synthesised) is the same utterance. */
export const RUN_GAP_MS = 2500;

interface Spoken {
  text: string;
  at: number;
}

export class SpokenLog {
  private entries: Spoken[] = [];
  private speaking = false;
  /** When the current (or last) run of speech started. */
  private runStart = 0;
  private stoppedAt = -Infinity;
  private lastRecord = -Infinity;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** A sentence was handed to the TTS engine. */
  record(text: string): void {
    const t = text.trim();
    if (!t) return;
    const at = this.now();
    this.maybeNewRun(at);
    this.lastRecord = at;
    this.entries.push({ text: t, at });
    this.prune(at);
  }

  setSpeaking(on: boolean): void {
    if (on === this.speaking) return;
    const t = this.now();
    this.speaking = on;
    if (on) {
      this.maybeNewRun(t);
    } else {
      this.stoppedAt = t;
      // Everything in this utterance was audible until now.
      for (const e of this.entries) if (e.at >= this.runStart) e.at = t;
    }
  }

  private maybeNewRun(t: number): void {
    if (this.speaking) return;
    if (t - this.stoppedAt > RUN_GAP_MS && t - this.lastRecord > RUN_GAP_MS) this.runStart = t;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Herald is speaking, or stopped less than `ms` ago. */
  speakingWithin(ms: number): boolean {
    return this.speaking || this.now() - this.stoppedAt < ms;
  }

  /**
   * Text Herald said recently: everything queued or audible in the last
   * ECHO_WINDOW_MS, plus the whole current utterance (a long reply may have
   * been queued earlier than that and still be playing). Short pauses between
   * sentences do not start a new utterance.
   */
  recent(): string[] {
    const t = this.now();
    this.prune(t);
    const from = this.speaking ? Math.min(t - ECHO_WINDOW_MS, this.runStart) : t - ECHO_WINDOW_MS;
    return this.entries.filter((e) => e.at >= from).map((e) => e.text);
  }

  /**
   * Is this transcript most likely Herald's own voice? `minTokens` raises the
   * bar for deliberate captures (push-to-talk): only a long echo counts there.
   */
  isEcho(transcript: string, opts: { minTokens?: number } = {}): boolean {
    const spoken = this.recent();
    if (spoken.length === 0) return false;
    const echo = isLikelyEcho(transcript, spoken, { minTokens: opts.minTokens });
    if (!echo) return false;
    // One or two words: only while (or right after) Herald was talking.
    const words = transcript.trim().split(/\s+/).filter(Boolean).length;
    if (words <= 2 && !this.speakingWithin(SHORT_ECHO_WINDOW_MS)) return false;
    return true;
  }

  /**
   * A partial transcript heard while Herald talks: clearly a person (an
   * interrupt word, or mostly words Herald did not say)? See isClearBargeIn.
   */
  isBargeIn(transcript: string): boolean {
    return isClearBargeIn(transcript, this.recent());
  }

  /** A transcript known to contain the user (confirmed barge-in): cut Herald's words out of it. */
  stripEcho(transcript: string): string {
    const spoken = this.recent();
    return spoken.length === 0 ? transcript.trim() : stripEcho(transcript, spoken);
  }

  reset(): void {
    this.entries = [];
  }

  private prune(t: number): void {
    // Keep a generous history; recent() narrows it.
    const keepFrom = Math.min(t - 5 * 60_000, this.runStart);
    if (this.entries.length > 200 || (this.entries[0] && this.entries[0].at < keepFrom)) {
      this.entries = this.entries.filter((e) => e.at >= keepFrom).slice(-200);
    }
  }
}

/**
 * Wrap a TTS engine so every sentence it is asked to say, and its speaking
 * state, lands in `log`. Everything else passes straight through.
 */
export function recordingEngine(engine: TtsEngine, log: SpokenLog): TtsEngine {
  engine.on((e) => {
    if (e.type === 'speaking') log.setSpeaking(e.speaking);
  });
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'speak') {
        return (text: string, opts?: Parameters<TtsEngine['speak']>[1]) => {
          log.record(text);
          return target.speak(text, opts);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
