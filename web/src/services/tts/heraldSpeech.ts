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
}

export interface SpeechControllerOptions {
  /** Voice on/off switch, read on every decision. */
  isEnabled: () => boolean;
  /** Page visible? Background tabs and idle devices must stay quiet. */
  isVisible: () => boolean;
  /** Current voice / rate. */
  speakOptions: () => TtsSpeakOptions;
}

export class HeraldSpeechController {
  private known = new Set<string>();
  private live: LiveReply | null = null;

  constructor(private engine: TtsEngine, private opts: SpeechControllerOptions) {}

  /** Id of the reply currently being voiced, if any. */
  get liveId(): string | null {
    return this.live && !this.live.silenced ? this.live.id : null;
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
        // Turn over (possibly aborted with no message_end): say what's buffered.
        if (!event.busy && this.live) this.finishLive(null);
        return;
      default:
        return;
    }
  }

  /** Barge-in: silence now and drop the rest of the current reply. */
  stop(): void {
    this.engine.cancel();
    if (this.live) this.live.silenced = true;
  }

  /** Host switch / reset: forget everything. */
  reset(): void {
    this.engine.cancel();
    this.live = null;
    this.known.clear();
  }

  // ---- internals ----------------------------------------------------------

  private canSpeak(): boolean {
    return this.engine.available && this.opts.isEnabled() && this.opts.isVisible();
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
    this.live = { id, chunker: new SentenceChunker(), received: '', silenced: false };
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
    if (!live.silenced) for (const s of sentences) this.say(live, s);
  }

  /** Flush the rest of the live reply. `finalText` is the authoritative full text if known. */
  private finishLive(finalText: string | null): void {
    const live = this.live;
    if (!live) return;
    this.live = null;
    if (live.silenced) return;
    if (finalText !== null && finalText.length > live.received.length && finalText.startsWith(live.received)) {
      for (const s of live.chunker.push(finalText.slice(live.received.length))) this.say(live, s);
    }
    for (const s of live.chunker.flush()) this.say(live, s);
  }

  private say(live: LiveReply, raw: string): void {
    if (live.silenced) return;
    if (!this.canSpeak()) {
      // Tab hidden or voice switched off mid-reply: go quiet for the rest of it.
      live.silenced = true;
      this.engine.cancel();
      return;
    }
    const text = normalizeForSpeech(raw);
    if (isSpeakable(text)) this.engine.speak(text, this.opts.speakOptions());
  }
}

// ---------------------------------------------------------------------------
// Inbox chime detection
// ---------------------------------------------------------------------------

export type ChimeKind = 'blocked' | 'finished';

/**
 * Decides when a new inbox item deserves a chime. Snapshots (initial load,
 * reconnect) only seed the seen-set; live `inbox` pushes with unseen, unheard
 * blocked/finished items chime once (blocked wins).
 */
export class InboxChimeTracker {
  private seen = new Set<string>();
  private seeded = false;

  handleEvent(event: HeraldEvent, source: HeraldEventSource): ChimeKind | null {
    if (event.kind === 'state') {
      this.seed(event.state.inbox);
      return null;
    }
    if (event.kind !== 'inbox' || source !== 'push') return null;
    if (!this.seeded) {
      this.seed(event.inbox);
      return null;
    }
    let kind: ChimeKind | null = null;
    for (const item of event.inbox) {
      if (this.seen.has(item.id)) continue;
      this.seen.add(item.id);
      if (item.heard) continue;
      if (item.priority === 'blocked') kind = 'blocked';
      else if (item.priority === 'finished' && kind === null) kind = 'finished';
    }
    return kind;
  }

  reset(): void {
    this.seen.clear();
    this.seeded = false;
  }

  private seed(items: HeraldInboxItem[]): void {
    this.seeded = true;
    for (const i of items) this.seen.add(i.id);
  }
}
