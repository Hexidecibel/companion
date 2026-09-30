/**
 * Decides when the VAD runs and what speech means (no React, testable):
 *
 * Interrupt (barge-in): while Herald is speaking, and for a short grace period
 * after, the VAD listens. Real speech (past minSpeechMs, so a cough or click
 * does not count) immediately stops Herald on both the client and the server
 * queue, and the utterance is transcribed and sent when the speaker pauses.
 *
 * The mic is only ever opened here if permission was ALREADY granted (e.g. by
 * push-to-talk): interrupt never triggers a permission prompt on its own.
 */
import { float32ToInt16Frames, floatToInt16, meterLevel, rms16 } from './pcm';
import type { VadEvents, VadLike, VadSensitivity } from './vadListener';
import type { VoiceInputController } from './voiceInput';

export interface AutomationConfig {
  /** Voice input usable (connected, service up, secure context). */
  available: boolean;
  /** Microphone permission already granted. */
  micGranted: boolean;
  interrupt: boolean;
  sensitivity: VadSensitivity;
  /** Herald is speaking right now. */
  speaking: boolean;
}

export interface AutomationDeps {
  vad: VadLike;
  input: VoiceInputController;
  /** Barge-in: cancel TTS playback and the server synthesis queue. */
  stopSpeech: () => void;
  now?: () => number;
  /** Report a VAD load failure (e.g. WASM blocked). */
  onError?: (message: string) => void;
}

/** Keep listening this long after Herald stops, for an immediate reply. */
export const INTERRUPT_GRACE_MS = 1500;

export class VoiceAutomation implements VadEvents {
  protected cfg: AutomationConfig = { available: false, micGranted: false, interrupt: false, sensitivity: 'normal', speaking: false };
  protected capturing: 'interrupt' | null = null;
  private graceUntil = 0;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private starting: Promise<void> | null = null;
  private wantRunning = false;
  private disposed = false;
  protected readonly now: () => number;

  constructor(protected deps: AutomationDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  update(next: AutomationConfig): void {
    const prev = this.cfg;
    this.cfg = next;
    if (prev.speaking && !next.speaking) {
      this.graceUntil = this.now() + INTERRUPT_GRACE_MS;
      if (this.graceTimer) clearTimeout(this.graceTimer);
      this.graceTimer = setTimeout(() => this.reconcile(), INTERRUPT_GRACE_MS + 20);
    }
    if (prev.sensitivity !== next.sensitivity) this.deps.vad.setSensitivity(next.sensitivity);
    this.reconcile();
  }

  /** Interrupt is armed: Herald speaking (or just finished) and the feature on. */
  get interruptArmed(): boolean {
    const c = this.cfg;
    return c.available && c.micGranted && c.interrupt && (c.speaking || this.now() < this.graceUntil);
  }

  protected wantVad(): boolean {
    return this.interruptArmed || this.capturing !== null;
  }

  protected reconcile(): void {
    if (this.disposed) return;
    const want = this.wantVad();
    if (want === this.wantRunning) return;
    this.wantRunning = want;
    if (want) {
      this.starting = this.deps.vad
        .start(this, this.cfg.sensitivity)
        .catch((err: unknown) => {
          this.wantRunning = false;
          this.deps.onError?.(`Voice detection unavailable: ${(err as Error)?.message || err}`);
        })
        .finally(() => {
          this.starting = null;
          // Config may have changed while loading.
          if (!this.wantVad() && this.deps.vad.running) {
            this.wantRunning = false;
            this.deps.vad.pause();
          }
        });
    } else if (!this.starting) {
      this.deps.vad.pause();
    }
  }

  // ---- VAD events -----------------------------------------------------------

  onSpeechStart(): void {
    // Wait for onSpeechRealStart: a single loud frame must not cut Herald off.
  }

  onSpeechRealStart(): void {
    if (this.capturing || !this.interruptArmed) return;
    if (this.deps.input.state.phase !== 'idle') return; // push-to-talk owns the mic
    this.capturing = 'interrupt';
    this.deps.stopSpeech();
    this.deps.input.beginExternal('interrupt');
  }

  onMisfire(): void {
    if (this.capturing === 'interrupt') {
      this.capturing = null;
      this.deps.input.endExternal();
      this.reconcile();
    }
  }

  onSpeechEnd(audio: Float32Array): void {
    if (this.capturing !== 'interrupt') return;
    this.capturing = null;
    void this.deps.input.transcribeUtterance(float32ToInt16Frames(audio), 'interrupt');
    this.reconcile();
  }

  onFrame(frame: Float32Array, _probability: number): void {
    if (this.capturing) this.deps.input.setLevel(meterLevel(rms16(floatToInt16(frame))));
  }

  dispose(): void {
    this.disposed = true;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.deps.vad.destroy();
  }
}
