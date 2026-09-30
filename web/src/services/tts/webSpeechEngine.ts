import type { TtsEngine, TtsEvent, TtsSpeakOptions, TtsVoice } from './types';

interface QueuedChunk {
  text: string;
  opts: TtsSpeakOptions;
}

/** Chars per second at rate 1, used to size the stuck-utterance watchdog. */
const CHARS_PER_SEC = 13;

function toVoice(v: SpeechSynthesisVoice): TtsVoice {
  return {
    id: v.voiceURI || v.name,
    name: v.name,
    lang: v.lang,
    local: v.localService,
    isDefault: v.default,
  };
}

/**
 * Browser Web Speech (`speechSynthesis`) engine.
 *
 * Feeds utterances one at a time from its own queue rather than leaning on the
 * browser's queue, which lets it: report accurate speaking state, recover from
 * Chrome's lost `end` events (watchdog), keep the current utterance referenced
 * (Chrome garbage-collects in-flight utterances and drops their events), and
 * cancel cleanly without stale callbacks (generation counter).
 */
export class WebSpeechEngine implements TtsEngine {
  readonly id = 'webspeech';
  readonly available: boolean;

  private synth: SpeechSynthesis | null;
  private queue: QueuedChunk[] = [];
  private current: SpeechSynthesisUtterance | null = null;
  private gen = 0;
  private listeners = new Set<(e: TtsEvent) => void>();
  private voices: SpeechSynthesisVoice[] = [];
  private isSpeaking = false;
  private unlocked = false;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private voicePoll: ReturnType<typeof setInterval> | null = null;

  constructor(synth?: SpeechSynthesis | null) {
    this.synth = synth !== undefined
      ? synth
      : typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function'
        ? window.speechSynthesis
        : null;
    this.available = !!this.synth;
    if (!this.synth) return;
    this.loadVoices();
    this.synth.addEventListener?.('voiceschanged', this.onVoicesChanged);
    // Some engines never fire voiceschanged; poll briefly as a fallback.
    let tries = 0;
    this.voicePoll = setInterval(() => {
      tries++;
      if (this.loadVoices() || tries > 20) this.stopVoicePoll();
    }, 250);
  }

  get speaking(): boolean {
    return this.isSpeaking;
  }

  on(listener: (event: TtsEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getVoices(): TtsVoice[] {
    return this.voices.map(toVoice);
  }

  speak(text: string, opts: TtsSpeakOptions = {}): void {
    if (!this.synth || !text.trim()) return;
    this.queue.push({ text, opts });
    if (!this.current) this.next();
  }

  cancel(): void {
    this.gen++;
    this.queue = [];
    this.current = null;
    this.clearTimers();
    try {
      this.synth?.cancel();
    } catch {
      // ignore
    }
    this.setSpeaking(false);
  }

  unlock(): void {
    if (!this.synth || this.unlocked) return;
    this.unlocked = true;
    if (this.current || this.synth.speaking) return;
    try {
      // A silent utterance inside a gesture satisfies autoplay rules (Chrome,
      // iOS Safari) for the rest of the page's life.
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      this.synth.speak(u);
    } catch {
      // ignore
    }
  }

  dispose(): void {
    this.cancel();
    this.stopVoicePoll();
    this.synth?.removeEventListener?.('voiceschanged', this.onVoicesChanged);
    this.listeners.clear();
  }

  // ---- internals ----------------------------------------------------------

  private emit(e: TtsEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        // listener errors must not break playback
      }
    }
  }

  private setSpeaking(v: boolean): void {
    if (this.isSpeaking === v) return;
    this.isSpeaking = v;
    this.emit({ type: 'speaking', speaking: v });
  }

  private onVoicesChanged = () => {
    if (this.loadVoices()) this.stopVoicePoll();
  };

  private loadVoices(): boolean {
    if (!this.synth) return false;
    let list: SpeechSynthesisVoice[] = [];
    try {
      list = this.synth.getVoices() ?? [];
    } catch {
      list = [];
    }
    if (list.length === 0) return false;
    const changed = list.length !== this.voices.length || list.some((v, i) => v !== this.voices[i]);
    this.voices = list;
    if (changed) this.emit({ type: 'voices', voices: this.getVoices() });
    return true;
  }

  private stopVoicePoll(): void {
    if (this.voicePoll) clearInterval(this.voicePoll);
    this.voicePoll = null;
  }

  private clearTimers(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.watchdog = null;
    this.keepAlive = null;
  }

  private next(): void {
    const synth = this.synth;
    if (!synth) return;
    this.clearTimers();
    const item = this.queue.shift();
    if (!item) {
      this.current = null;
      this.setSpeaking(false);
      return;
    }
    const gen = this.gen;
    const u = new SpeechSynthesisUtterance(item.text);
    const rate = item.opts.rate ?? 1;
    u.rate = rate;
    if (item.opts.pitch !== undefined) u.pitch = item.opts.pitch;
    if (item.opts.volume !== undefined) u.volume = item.opts.volume;
    const voice = item.opts.voiceId ? this.voices.find((v) => (v.voiceURI || v.name) === item.opts.voiceId) : undefined;
    if (voice) {
      try {
        u.voice = voice;
        u.lang = voice.lang;
      } catch {
        // some webviews reject voice objects; the default voice still works
      }
    }

    let done = false;
    const finish = (err?: string) => {
      if (done || gen !== this.gen) return;
      done = true;
      this.emit({ type: 'chunk_end', text: item.text });
      if (err === 'not-allowed') {
        // Autoplay policy: nothing will play until a gesture. Drop the queue so
        // a stale backlog doesn't burst out later.
        this.unlocked = false;
        this.queue = [];
        this.current = null;
        this.clearTimers();
        this.setSpeaking(false);
        this.emit({ type: 'blocked' });
        return;
      }
      if (err && err !== 'interrupted' && err !== 'canceled') this.emit({ type: 'error', error: err });
      this.current = null;
      this.next();
    };
    u.onstart = () => {
      if (gen === this.gen) this.emit({ type: 'chunk_start', text: item.text });
    };
    u.onend = () => finish();
    u.onerror = (ev: SpeechSynthesisErrorEvent) => finish(ev.error || 'error');

    this.current = u;
    this.setSpeaking(true);
    try {
      synth.speak(u);
    } catch (err) {
      finish(err instanceof Error ? err.message : 'speak failed');
      return;
    }
    // Chrome occasionally loses `end`; never let the queue wedge.
    const budgetMs = (item.text.length / (CHARS_PER_SEC * Math.max(0.5, rate))) * 1000 + 4000;
    let extra = 0;
    const check = () => {
      if (gen !== this.gen || this.current !== u) return;
      // Still genuinely talking (slow voice): look again shortly, within reason.
      if (synth.speaking && !synth.paused && extra++ < 10) {
        this.watchdog = setTimeout(check, 3000);
        return;
      }
      finish();
    };
    this.watchdog = setTimeout(check, budgetMs);
    // Chrome pauses long remote-voice utterances after ~15s; a periodic resume
    // keeps them going and is a no-op elsewhere.
    this.keepAlive = setInterval(() => {
      try {
        if (synth.speaking) synth.resume();
      } catch {
        // ignore
      }
    }, 5000);
  }
}

let shared: WebSpeechEngine | null = null;

/** Lazily-created singleton so voice lists survive panel remounts. */
export function getWebSpeechEngine(): WebSpeechEngine {
  if (!shared) shared = new WebSpeechEngine();
  return shared;
}
