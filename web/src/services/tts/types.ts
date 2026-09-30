/**
 * Text-to-speech engine contract. The UI and the speech controller only ever
 * talk to this interface, so a server-side engine (neural TTS streaming audio
 * from a GPU box) can replace the browser's Web Speech without UI changes.
 *
 * Model: the engine owns a FIFO queue of text chunks. `speak` enqueues and
 * starts playback if idle; `cancel` drops the queue and silences immediately.
 */

export interface TtsVoice {
  /** Stable identifier used for persistence (engine-specific). */
  id: string;
  /** Human label for pickers. */
  name: string;
  /** BCP-47 language tag, e.g. "en-US". */
  lang: string;
  /** True for on-device voices (lower latency, works offline). */
  local: boolean;
  /** True when the engine would pick it with no preference. */
  isDefault: boolean;
}

export interface TtsSpeakOptions {
  /** 0.5 - 2, 1 = normal. */
  rate?: number;
  pitch?: number;
  /** 0 - 1. */
  volume?: number;
  voiceId?: string | null;
}

export type TtsEvent =
  | { type: 'speaking'; speaking: boolean }
  | { type: 'chunk_start'; text: string }
  | { type: 'chunk_end'; text: string }
  | { type: 'voices'; voices: TtsVoice[] }
  /** Playback refused until a user gesture (autoplay policy). */
  | { type: 'blocked' }
  | { type: 'error'; error: string };

export interface TtsEngine {
  /** Short engine id, e.g. "webspeech". */
  readonly id: string;
  /** False when the platform has no usable backend (hide voice UI). */
  readonly available: boolean;
  /** True while audio is playing or queued. */
  readonly speaking: boolean;
  /** Enqueue one chunk (normally a sentence). */
  speak(text: string, opts?: TtsSpeakOptions): void;
  /** Stop now and drop everything queued. */
  cancel(): void;
  /** Voices known so far (may grow; listen for `voices`). */
  getVoices(): TtsVoice[];
  /**
   * Call from inside a user gesture handler. Engines that are gated by
   * autoplay rules use it to prime playback silently. Idempotent.
   */
  unlock(): void;
  on(listener: (event: TtsEvent) => void): () => void;
  dispose(): void;
}
