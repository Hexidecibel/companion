/**
 * Glue between Herald's event stream and a TtsEngine. Pure logic (no React, no
 * DOM beyond the injected callbacks) so gating and barge-in are unit-testable.
 */
import type { HeraldEvent, HeraldInboxItem, HeraldMessage } from '../../types/herald';
import { SentenceChunker, isSpeakable, normalizeForSpeech } from './speechText';
import type { TtsEngine, TtsSpeakOptions } from './types';

/**
 * Where an event came from. `push` = live `herald_event` from the socket;
 * `fetch` = a `herald_get_state` snapshot (initial load, reconnect, refresh).
 */
export type HeraldEventSource = 'push' | 'fetch';

interface LiveReply {
  id: string;
  chunker: SentenceChunker;
  /** Raw text received so far (to diff against message_end's final text). */
  received: string;
  /** Barge-in happened: keep consuming the stream, never speak it. */
  silenced: boolean;
  /** Normalised sentences actually spoken (what "repeat that" replays). */
  spoken: string[];
  spokenWords: number;
  /** The spoken cap was reached: later sentences wait for "go on". */
  capped: boolean;
  /** Raw sentences held back by the cap, in order. */
  withheld: string[];
  /** "go on" arrived mid-reply: speak everything from here on. */
  uncapped: boolean;
  limit: SpokenLimit;
}

/** What the last voiced reply said, for REPEAT and MORE. */
interface LastReply {
  id: string;
  spoken: string[];
  /** Raw sentences not yet spoken (the cap held them back). */
  remainder: string[];
}

/**
 * How much of a reply is spoken. `short`: at most `sentences` sentences and
 * `words` words, whichever is shorter, sentence-aligned (the first sentence is
 * always spoken whole). The full text is always on screen.
 */
export interface SpokenLimit {
  sentences: number;
  words: number;
}

export const SHORT_SPOKEN_LIMIT: SpokenLimit = { sentences: 2, words: 40 };
/** A briefing is up to three items plus "and N more". */
export const BRIEFING_SPOKEN_LIMIT: SpokenLimit = { sentences: 4, words: 75 };
export const MORE_TAIL = "There's more on screen \u2014 say go on.";

export type SpokenLength = 'short' | 'full';

export interface SpeechControllerOptions {
  /** Voice on/off switch, read on every decision. */
  isEnabled: () => boolean;
  /** Page visible? Background tabs and idle devices must stay quiet. */
  isVisible: () => boolean;
  /** Current voice / rate. */
  speakOptions: () => TtsSpeakOptions;
  /** Spoken length preference (default: full, i.e. no cap). */
  spokenLength?: () => SpokenLength;
}

export function countWords(text: string): number {
  const m = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu);
  return m ? m.length : 0;
}

export class HeraldSpeechController {
  private known = new Set<string>();
  private live: LiveReply | null = null;
  private last: LastReply | null = null;
  /** A Herald turn is running (busy). */
  private turnActive = false;
  /** STOP during a turn: the reply it produces stays silent. */
  private muteTurn = false;
  /** Spoken limit for the next reply only (e.g. a briefing). */
  private nextLimit: SpokenLimit | null = null;

  constructor(private engine: TtsEngine, private opts: SpeechControllerOptions) {}

  /** Id of the reply currently being voiced, if any. */
  get liveId(): string | null {
    return this.live && !this.live.silenced ? this.live.id : null;
  }

  /** Something to say for "go on" without asking the brain. */
  get hasRemainder(): boolean {
    if (this.live && !this.live.silenced && this.live.capped) return true;
    return !!this.last && this.last.remainder.length > 0;
  }

  /** Something to say for "repeat that". */
  get canRepeat(): boolean {
    return !!this.last && this.last.spoken.length > 0;
  }

  handleEvent(event: HeraldEvent, source: HeraldEventSource): void {
    switch (event.kind) {
      case 'state':
        this.onSnapshot(event.state.messages);
        return;
      case 'message_start':
        if (source !== 'push') return;
        this.onStart(event.message);
        return;
      case 'message_delta':
        if (source !== 'push') return;
        this.onDelta(event.messageId, event.delta);
        return;
      case 'message_end':
        if (source !== 'push') return;
        this.onEnd(event.message);
        return;
      case 'busy':
        this.turnActive = event.busy;
        if (!event.busy) {
          this.muteTurn = false;
          // Turn over (possibly aborted with no message_end): say what's buffered.
          if (this.live) this.finishLive(null);
        }
        return;
      default:
        return;
    }
  }

  /**
   * Barge-in: silence now and drop the rest of the current reply.
   * `muteTurn` (the STOP command): a reply still being thought about stays
   * silent too, instead of starting to talk a moment later.
   */
  stop(opts: { muteTurn?: boolean } = {}): void {
    this.engine.cancel();
    if (this.live) {
      this.live.silenced = true;
      this.rememberLive(this.live);
    }
    if (opts.muteTurn && this.turnActive) this.muteTurn = true;
  }

  /** "Repeat that": say the last reply again (from the top). */
  repeat(): boolean {
    const last = this.last;
    if (!last || last.spoken.length === 0) return false;
    this.engine.cancel();
    if (this.live) this.live.silenced = true;
    const o = this.opts.speakOptions();
    for (const s of last.spoken) this.engine.speak(s, o);
    if (last.remainder.length > 0) this.engine.speak(MORE_TAIL, o);
    return true;
  }

  /**
   * "Go on": speak what the spoken cap held back. Returns false when there is
   * nothing held back (the caller then asks the brain for more).
   */
  continueRemainder(): boolean {
    const live = this.live;
    if (live && !live.silenced && live.capped) {
      // Still streaming: lift the cap and say everything from here on.
      live.uncapped = true;
      live.capped = false;
      const held = live.withheld.splice(0);
      for (const s of held) this.offer(live, s);
      return true;
    }
    const last = this.last;
    if (!last || last.remainder.length === 0) return false;
    this.engine.cancel();
    const limit = this.limitFor();
    const rest = last.remainder.slice();
    last.remainder = [];
    last.spoken = [];
    const o = this.opts.speakOptions();
    let words = 0;
    while (rest.length > 0) {
      const text = normalizeForSpeech(rest[0]);
      const n = countWords(text);
      if (limit && last.spoken.length > 0 && (last.spoken.length >= limit.sentences || words + n > limit.words)) break;
      rest.shift();
      if (!isSpeakable(text)) continue;
      this.engine.speak(text, o);
      last.spoken.push(text);
      words += n;
    }
    last.remainder = rest;
    if (rest.length > 0) this.engine.speak(MORE_TAIL, o);
    return true;
  }

  /** The next reply gets this spoken limit instead of the default (a briefing). */
  setNextLimit(limit: SpokenLimit | null): void {
    this.nextLimit = limit;
  }

  /** Speak a short confirmation ("Okay.") right now, replacing anything playing. */
  say(text: string): void {
    if (!this.engine.available || !this.opts.isEnabled()) return;
    this.engine.cancel();
    if (this.live) this.live.silenced = true;
    this.engine.speak(text, this.opts.speakOptions());
  }

  /** Host switch / reset: forget everything. */
  reset(): void {
    this.engine.cancel();
    this.live = null;
    this.last = null;
    this.known.clear();
    this.turnActive = false;
    this.muteTurn = false;
    this.nextLimit = null;
  }

  // ---- internals ----------------------------------------------------------

  private canSpeak(): boolean {
    return this.engine.available && this.opts.isEnabled() && this.opts.isVisible();
  }

  private limitFor(): SpokenLimit | null {
    return (this.opts.spokenLength?.() ?? 'full') === 'short' ? SHORT_SPOKEN_LIMIT : null;
  }

  private onSnapshot(messages: HeraldMessage[]): void {
    for (const m of messages) {
      if (this.live && m.id === this.live.id) {
        // We missed message_end (e.g. a reconnect): the snapshot is final.
        if (!m.streaming) this.finishLive(m.text);
        continue;
      }
      this.known.add(m.id);
    }
  }

  private beginLive(id: string): LiveReply | null {
    this.known.add(id);
    if (this.live && this.live.id !== id) {
      // A new reply replaces whatever was still being said.
      this.engine.cancel();
      this.live = null;
    }
    if (!this.canSpeak()) return null;
    const base = this.limitFor();
    const limit = this.nextLimit ?? base ?? { sentences: Infinity, words: Infinity };
    this.nextLimit = null;
    this.live = {
      id, chunker: new SentenceChunker(), received: '', silenced: this.muteTurn,
      spoken: [], spokenWords: 0, capped: false, withheld: [], uncapped: false, limit,
    };
    return this.live;
  }

  private onStart(message: HeraldMessage): void {
    if (message.role !== 'herald') {
      this.known.add(message.id);
      return;
    }
    // Replayed / already-seen message (history, reconnect): never speak.
    if (this.known.has(message.id)) return;
    const live = this.beginLive(message.id);
    if (live && message.text) this.feed(live, message.text);
  }

  private onDelta(id: string, delta: string): void {
    if (!delta) return;
    let live = this.live && this.live.id === id ? this.live : null;
    if (!live) {
      // Delta without a start we saw: only a brand-new message qualifies.
      if (this.known.has(id)) return;
      live = this.beginLive(id);
      if (!live) return;
    }
    this.feed(live, delta);
  }

  private onEnd(message: HeraldMessage): void {
    if (message.role !== 'herald') {
      this.known.add(message.id);
      return;
    }
    if (this.live && this.live.id === message.id) {
      this.finishLive(message.text);
      return;
    }
    if (this.known.has(message.id)) return;
    // Complete message delivered in one go (no start seen).
    const live = this.beginLive(message.id);
    if (!live) return;
    this.feed(live, message.text);
    this.finishLive(null);
  }

  private feed(live: LiveReply, text: string): void {
    live.received += text;
    const sentences = live.chunker.push(text);
    if (!live.silenced) for (const s of sentences) this.offer(live, s);
    else live.withheld.push(...sentences);
  }

  /** Flush the rest of the live reply. `finalText` is the authoritative full text if known. */
  private finishLive(finalText: string | null): void {
    const live = this.live;
    if (!live) return;
    this.live = null;
    const rest: string[] = [];
    if (finalText !== null && finalText.length > live.received.length && finalText.startsWith(live.received)) {
      rest.push(...live.chunker.push(finalText.slice(live.received.length)));
    }
    rest.push(...live.chunker.flush());
    if (live.silenced) {
      live.withheld.push(...rest);
      this.rememberLive(live);
      return;
    }
    for (const s of rest) this.offer(live, s);
    if (live.capped && live.withheld.length > 0 && !live.silenced) {
      this.engine.speak(MORE_TAIL, this.opts.speakOptions());
    }
    this.rememberLive(live);
  }

  private rememberLive(live: LiveReply): void {
    if (live.spoken.length === 0 && live.withheld.length === 0) return;
    this.last = { id: live.id, spoken: live.spoken.slice(), remainder: live.withheld.slice() };
  }

  /** Speak one sentence, or hold it back once the spoken cap is reached. */
  private offer(live: LiveReply, raw: string): void {
    if (live.silenced) return;
    if (live.capped) {
      live.withheld.push(raw);
      return;
    }
    if (!this.canSpeak()) {
      // Tab hidden or voice switched off mid-reply: go quiet for the rest of it.
      live.silenced = true;
      live.withheld.push(raw);
      this.engine.cancel();
      return;
    }
    const text = normalizeForSpeech(raw);
    if (!isSpeakable(text)) return;
    const words = countWords(text);
    const lim = live.limit;
    if (!live.uncapped && live.spoken.length > 0 && (live.spoken.length >= lim.sentences || live.spokenWords + words > lim.words)) {
      live.capped = true;
      live.withheld.push(raw);
      return;
    }
    this.engine.speak(text, this.opts.speakOptions());
    live.spoken.push(text);
    live.spokenWords += words;
  }
}

// ---------------------------------------------------------------------------
// Inbox chime detection
// ---------------------------------------------------------------------------

export type ChimeKind = 'blocked' | 'finished';

/** A blocked item still unheard this long after its tone gets a gentle reminder. */
export const REMINDER_AFTER_MS = 5 * 60_000;
/** At most this many reminders per item. */
export const MAX_REMINDERS = 2;

interface Toned {
  lastToneAt: number;
  reminders: number;
}

/**
 * Decides when a new inbox item deserves a tone. Snapshots (initial load,
 * reconnect) only seed the seen-set; live `inbox` pushes with unseen, unheard
 * blocked/finished items tone once (blocked wins). Herald never speaks about
 * them on its own: the tone says "something is ready", the user asks for it.
 *
 * Blocked items that were toned and are still unheard are remembered, so
 * `dueReminder` can replay the tone after REMINDER_AFTER_MS (at most
 * MAX_REMINDERS times). Hearing the item (a briefing, a tap) ends it.
 */
export class InboxChimeTracker {
  private seen = new Set<string>();
  private seeded = false;
  private toned = new Map<string, Toned>();

  handleEvent(event: HeraldEvent, source: HeraldEventSource, now: number = Date.now()): ChimeKind | null {
    if (event.kind === 'state') {
      this.seed(event.state.inbox);
      this.prune(event.state.inbox);
      return null;
    }
    if (event.kind !== 'inbox' || source !== 'push') return null;
    this.prune(event.inbox);
    if (!this.seeded) {
      this.seed(event.inbox);
      return null;
    }
    let kind: ChimeKind | null = null;
    for (const item of event.inbox) {
      if (this.seen.has(item.id)) continue;
      this.seen.add(item.id);
      if (item.heard) continue;
      if (item.priority === 'blocked') {
        kind = 'blocked';
        this.toned.set(item.id, { lastToneAt: now, reminders: 0 });
      } else if (item.priority === 'finished' && kind === null) kind = 'finished';
    }
    return kind;
  }

  /** A reminder tone is due now (marks it played). */
  dueReminder(now: number = Date.now()): ChimeKind | null {
    let due = false;
    for (const t of this.toned.values()) {
      if (t.reminders < MAX_REMINDERS && now - t.lastToneAt >= REMINDER_AFTER_MS) due = true;
    }
    if (!due) return null;
    // One tone covers every item that is due; each counts it.
    for (const t of this.toned.values()) {
      if (t.reminders < MAX_REMINDERS && now - t.lastToneAt >= REMINDER_AFTER_MS) {
        t.reminders++;
        t.lastToneAt = now;
      }
    }
    return 'blocked';
  }

  /** Items still waiting for a possible reminder (tests / diagnostics). */
  get pendingReminders(): number {
    let n = 0;
    for (const t of this.toned.values()) if (t.reminders < MAX_REMINDERS) n++;
    return n;
  }

  reset(): void {
    this.seen.clear();
    this.toned.clear();
    this.seeded = false;
  }

  private seed(items: HeraldInboxItem[]): void {
    this.seeded = true;
    for (const i of items) this.seen.add(i.id);
  }

  /** Forget reminders for items that were heard, resolved, or left the inbox. */
  private prune(items: HeraldInboxItem[]): void {
    if (this.toned.size === 0) return;
    const open = new Set(items.filter((i) => !i.heard && i.priority === 'blocked').map((i) => i.id));
    for (const id of [...this.toned.keys()]) if (!open.has(id)) this.toned.delete(id);
  }
}
