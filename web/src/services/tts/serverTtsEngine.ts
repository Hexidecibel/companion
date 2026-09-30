/**
 * Neural TTS through the Herald daemon (Kokoro on the voice service).
 *
 * Each sentence is requested as soon as it is spoken (the daemon synthesises a
 * client's sentences in order, one at a time), and played through WebAudio on
 * a gapless timeline: every buffer is scheduled at exactly the end time of the
 * previous one. Ordering is by queue position, never by arrival.
 *
 * Barge-in (`cancel`) stops scheduled audio, drops the queue, and tells the
 * daemon to abort the in-flight and queued synthesis for this client.
 *
 * When the service is unavailable, the failed sentence and everything queued
 * after it go to `onFallback` (Web Speech) in order, once the audio already
 * scheduled has finished, so a reply never goes silent or out of order.
 */
import type { HeraldTtsRequest, HeraldTtsResult, HeraldVoiceInfo } from '../../types/herald';
import type { TtsEngine, TtsEvent, TtsSpeakOptions, TtsVoice } from './types';

export const NEURAL_PREFIX = 'neural:';

export class TtsRequestError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'TtsRequestError';
  }
}

export interface TtsRequester {
  synth(req: HeraldTtsRequest): Promise<HeraldTtsResult>;
  /** Abort this client's pending synthesis on the server (best effort). */
  cancel(): void;
}

export interface PlayingHandle {
  stop(): void;
}

/** Minimal audio output, so the scheduling logic is testable without WebAudio. */
export interface AudioSink {
  isRunning(): boolean;
  resume(): Promise<boolean>;
  currentTime(): number;
  /** Schedule mono PCM16 at absolute time `when` (sink clock). */
  play(pcm: Int16Array, sampleRate: number, when: number, onEnded: () => void): PlayingHandle;
}

interface Item {
  text: string;
  state: 'pending' | 'ready' | 'failed' | 'scheduled';
  result?: HeraldTtsResult;
  error?: TtsRequestError;
  opts: TtsSpeakOptions;
}

/** Tiny lead so the first buffer never starts in the past. */
const START_LEAD_S = 0.03;

/**
 * Split a long opening sentence at its first clause boundary so the first
 * audio arrives sooner (synthesis time scales with length).
 */
export function splitForFastStart(text: string): string[] {
  if (text.length < 70) return [text];
  const re = /[,;:—–]\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const cut = m.index + 1;
    if (cut < 16) continue;
    if (cut > 90) break;
    const head = text.slice(0, cut).trim();
    const tail = text.slice(m.index + m[0].length).trim();
    if (tail.length < 12) break;
    return [head, tail];
  }
  return [text];
}

export function decodePcm16(b64: string): Int16Array {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const lo = bin.charCodeAt(2 * i);
    const hi = bin.charCodeAt(2 * i + 1);
    const v = lo | (hi << 8);
    out[i] = v >= 0x8000 ? v - 0x10000 : v;
  }
  return out;
}

export function toTtsVoices(voices: HeraldVoiceInfo[], defaultVoice: string | null): TtsVoice[] {
  return voices.map((v) => ({
    id: NEURAL_PREFIX + v.id,
    name: v.name,
    lang: v.lang,
    local: false,
    isDefault: v.id === defaultVoice,
    engine: 'neural' as const,
  }));
}

export class ServerTtsEngine implements TtsEngine {
  readonly id = 'neural';
  private _available = false;
  private voices: TtsVoice[] = [];
  private items: Item[] = [];
  private playing = new Set<PlayingHandle>();
  private playhead = 0;
  private gen = 0;
  private isSpeaking = false;
  private listeners = new Set<(e: TtsEvent) => void>();
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  /** Time of the first speak() after idle, for time-to-first-audio. */
  private idleSpeakAt: number | null = null;
  lastFirstAudioMs: number | null = null;

  constructor(
    private requester: TtsRequester,
    private sink: AudioSink,
    private onFallback: (text: string, opts: TtsSpeakOptions) => void,
    private now: () => number = () => performance.now(),
  ) {}

  get available(): boolean {
    return this._available;
  }

  get speaking(): boolean {
    return this.isSpeaking;
  }

  /** Voice-service status from the daemon. */
  setStatus(available: boolean, voices: HeraldVoiceInfo[], defaultVoice: string | null): void {
    const list = available ? toTtsVoices(voices, defaultVoice) : [];
    const changed = available !== this._available || list.length !== this.voices.length || list.some((v, i) => v.id !== this.voices[i]?.id);
    this._available = available && list.length > 0;
    this.voices = list;
    if (changed) this.emit({ type: 'voices', voices: this.getVoices() });
  }

  getVoices(): TtsVoice[] {
    return [...this.voices];
  }

  on(listener: (event: TtsEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  speak(text: string, opts: TtsSpeakOptions = {}): void {
    if (!text.trim()) return;
    const idle = this.items.length === 0 && this.playing.size === 0;
    if (idle) this.idleSpeakAt = this.now();
    const pieces = idle ? splitForFastStart(text) : [text];
    for (const piece of pieces) this.enqueue(piece, opts);
    this.setSpeaking(true);
  }

  cancel(): void {
    const hadWork = this.items.some((i) => i.state === 'pending') ;
    this.gen++;
    this.items = [];
    for (const h of [...this.playing]) {
      try {
        h.stop();
      } catch {
        // already stopped
      }
    }
    this.playing.clear();
    this.playhead = 0;
    this.idleSpeakAt = null;
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
    if (hadWork) this.requester.cancel();
    this.setSpeaking(false);
  }

  unlock(): void {
    void this.sink.resume();
  }

  dispose(): void {
    this.cancel();
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

  private enqueue(text: string, opts: TtsSpeakOptions): void {
    const gen = this.gen;
    const item: Item = { text, state: 'pending', opts };
    this.items.push(item);
    const voiceId = opts.voiceId?.startsWith(NEURAL_PREFIX) ? opts.voiceId.slice(NEURAL_PREFIX.length) : null;
    this.requester
      .synth({ text, voice: voiceId, speed: opts.rate ?? 1 })
      .then((result) => {
        if (gen !== this.gen) return;
        item.state = 'ready';
        item.result = result;
      })
      .catch((err: unknown) => {
        if (gen !== this.gen) return;
        item.state = 'failed';
        item.error = err instanceof TtsRequestError ? err : new TtsRequestError(String((err as Error)?.message ?? err), 'failed');
      })
      .finally(() => {
        if (gen === this.gen) void this.pump(gen);
      });
  }

  private async pump(gen: number): Promise<void> {
    while (this.items.length > 0 && gen === this.gen) {
      const head = this.items[0];
      if (head.state === 'pending') return;
      if (head.state === 'failed') {
        this.handleFailure(head.error!);
        return;
      }
      if (head.state === 'scheduled') {
        this.items.shift();
        continue;
      }
      if (!this.sink.isRunning()) {
        const ok = await this.sink.resume();
        if (gen !== this.gen) return;
        if (!ok) {
          // Autoplay policy: nothing will play until a gesture. Drop the backlog.
          this.cancel();
          this.emit({ type: 'blocked' });
          return;
        }
      }
      this.schedule(head, gen);
      this.items.shift();
    }
    this.maybeIdle();
  }

  private schedule(item: Item, gen: number): void {
    const r = item.result!;
    const pcm = decodePcm16(r.audio);
    item.state = 'scheduled';
    if (pcm.length === 0) return;
    const at = Math.max(this.sink.currentTime() + START_LEAD_S, this.playhead);
    this.playhead = at + pcm.length / r.sampleRate;
    if (this.idleSpeakAt !== null) {
      this.lastFirstAudioMs = Math.round(this.now() - this.idleSpeakAt + (at - this.sink.currentTime()) * 1000);
      this.idleSpeakAt = null;
    }
    const handle = this.sink.play(pcm, r.sampleRate, at, () => {
      this.playing.delete(handle);
      if (gen !== this.gen) return;
      this.emit({ type: 'chunk_end', text: item.text });
      this.maybeIdle();
    });
    this.playing.add(handle);
    this.emit({ type: 'chunk_start', text: item.text });
  }

  private maybeIdle(): void {
    if (this.items.length === 0 && this.playing.size === 0 && !this.fallbackTimer) this.setSpeaking(false);
  }

  private handleFailure(err: TtsRequestError): void {
    if (err.code === 'cancelled') {
      this.items.shift();
      void this.pump(this.gen);
      return;
    }
    // Hand this and every later sentence to the fallback, after what's already
    // scheduled finishes. Stop pending server work for them.
    const rest = this.items.splice(0);
    this.requester.cancel();
    if (err.code === 'unavailable' || err.code === 'failed' || err.code === 'timeout') this._available = false;
    this.emit({ type: 'error', error: err.message });
    const gen = this.gen;
    const waitMs = Math.max(0, (this.playhead - this.sink.currentTime()) * 1000);
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      if (gen !== this.gen) return;
      for (const item of rest) this.onFallback(item.text, item.opts);
      this.maybeIdle();
    }, waitMs);
  }
}

/** WebAudio output. The context is created lazily inside a user gesture. */
export class WebAudioSink implements AudioSink {
  private ctx: AudioContext | null = null;

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = typeof window !== 'undefined'
      ? (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      return null;
    }
    return this.ctx;
  }

  isRunning(): boolean {
    return this.ctx?.state === 'running';
  }

  async resume(): Promise<boolean> {
    const ctx = this.context();
    if (!ctx) return false;
    if (ctx.state === 'running') return true;
    try {
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 400))]);
    } catch {
      // fall through
    }
    return (ctx.state as string) === 'running';
  }

  currentTime(): number {
    return this.ctx?.currentTime ?? 0;
  }

  play(pcm: Int16Array, sampleRate: number, when: number, onEnded: () => void): PlayingHandle {
    const ctx = this.context()!;
    const buf = ctx.createBuffer(1, pcm.length, sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    let done = false;
    src.onended = () => {
      if (done) return;
      done = true;
      onEnded();
    };
    src.start(when);
    return {
      stop: () => {
        done = true;
        try {
          src.stop();
        } catch {
          // not started / already stopped
        }
        src.disconnect();
      },
    };
  }
}
