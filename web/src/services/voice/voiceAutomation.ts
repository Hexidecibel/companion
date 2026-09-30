/**
 * Decides when the VAD runs and what speech means (no React, testable).
 *
 * Interrupt (barge-in): while Herald is speaking, and for a short grace period
 * after, real speech (past minSpeechMs, so a cough or click does not count)
 * immediately stops Herald on both the client and the server queue; the
 * utterance is transcribed and sent when the speaker pauses.
 *
 * Hands-free ("Hey Jarvis"): the VAD runs continuously. Audio is sent ONLY
 * while someone is talking: each utterance opens a wake stream (with ~0.6 s of
 * pre-roll) that the daemon checks with openWakeWord as it arrives. On the
 * wake word: chime, show listening, and when the speaker pauses the utterance
 * is transcribed with the wake phrase stripped and sent. "Hey Jarvis" on its
 * own waits (briefly) for the command as the next utterance. Utterances
 * without the wake word are discarded unheard (never transcribed).
 *
 * Remote trigger `listen` (a hotkey on another machine): like a woken
 * hands-free, minus the wake word. The VAD starts (if it was not running), the
 * next utterance is captured whole and transcribed when the speaker pauses.
 * Nothing heard within LISTEN_WAIT_MS gives up quietly.
 *
 * Interrupt never opens the mic on its own (permission must already be
 * granted); hands-free is turned on by the user, which may prompt.
 */
import type { HeraldVoiceEvent } from '../../types/herald';
import type { HeraldTransport } from '../heraldTransport';
import { Framer, float32ToInt16Frames, floatToInt16, meterLevel, rms16 } from './pcm';
import type { VadEvents, VadLike, VadSensitivity } from './vadListener';
import type { VoiceInputController } from './voiceInput';
import { VoiceUplink } from './voiceUplink';

export interface AutomationConfig {
  /** Voice input usable (connected, service up, secure context). */
  available: boolean;
  /** Microphone permission already granted. */
  micGranted: boolean;
  interrupt: boolean;
  sensitivity: VadSensitivity;
  /** Herald is speaking right now. */
  speaking: boolean;
  /** Hands-free is on, owned by this device, and allowed right now (tab visible etc.). */
  handsFree?: boolean;
}

export interface AutomationDeps {
  vad: VadLike;
  input: VoiceInputController;
  /** Barge-in: cancel TTS playback and the server synthesis queue. */
  stopSpeech: () => void;
  getTransport?: () => HeraldTransport | null;
  /** Wake word heard: acknowledgement chime. */
  onWake?: () => void;
  now?: () => number;
  /** Report a VAD load failure (e.g. WASM blocked). */
  onError?: (message: string) => void;
}

/** Keep listening this long after Herald stops, for an immediate reply. */
export const INTERRUPT_GRACE_MS = 1500;
/** After a bare "Hey Jarvis", wait this long for the command. */
export const COMMAND_WAIT_MS = 8000;
/** A wake check may still be in flight when the speaker pauses: wait this long. */
export const WAKE_SETTLE_MS = 600;
/** A remote-trigger listen waits this long for speech to begin. */
export const LISTEN_WAIT_MS = 8000;
/** Pre-roll kept ahead of speech start (VAD frames are 32 ms). */
const PREROLL_FRAMES = 20;

type Capture = 'interrupt' | 'wake' | 'command' | 'listen';

interface WakeStream {
  uplink: VoiceUplink;
  framer: Framer;
  woke: boolean;
  closed: boolean;
}

export class VoiceAutomation implements VadEvents {
  protected cfg: AutomationConfig = { available: false, micGranted: false, interrupt: false, sensitivity: 'normal', speaking: false, handsFree: false };
  protected capturing: Capture | null = null;
  private graceUntil = 0;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private starting: Promise<void> | null = null;
  private wantRunning = false;
  private disposed = false;
  private preroll: Float32Array[] = [];
  private wake: WakeStream | null = null;
  private awaitingUntil = 0;
  private awaitTimer: ReturnType<typeof setTimeout> | null = null;
  /** A remote-trigger listen is waiting for speech to start. */
  private listenWaiting = false;
  private listenTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStartError: string | null = null;
  protected readonly now: () => number;

  constructor(protected deps: AutomationDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  update(next: AutomationConfig): void {
    const prev = this.cfg;
    this.cfg = { ...next, handsFree: !!next.handsFree };
    if (prev.speaking && !next.speaking) {
      this.graceUntil = this.now() + INTERRUPT_GRACE_MS;
      if (this.graceTimer) clearTimeout(this.graceTimer);
      this.graceTimer = setTimeout(() => this.reconcile(), INTERRUPT_GRACE_MS + 20);
    }
    if (prev.sensitivity !== next.sensitivity) this.deps.vad.setSensitivity(next.sensitivity);
    if (prev.handsFree && !this.cfg.handsFree) this.stopHandsFree();
    this.reconcile();
  }

  /**
   * Interrupt is armed: Herald speaking (or just finished) and the feature on.
   * Hands-free counts as mic permission: it only runs with the mic open, and
   * browsers without the Permissions API (Firefox) never report "granted"
   * otherwise, which left talking over Herald dead in hands-free mode.
   */
  get interruptArmed(): boolean {
    const c = this.cfg;
    return c.available && (c.micGranted || !!c.handsFree) && c.interrupt && (c.speaking || this.now() < this.graceUntil);
  }

  get handsFreeActive(): boolean {
    return this.cfg.available && !!this.cfg.handsFree;
  }

  get awaitingCommand(): boolean {
    return this.now() < this.awaitingUntil;
  }

  protected wantVad(): boolean {
    return this.interruptArmed || this.handsFreeActive || this.listenWaiting || this.capturing !== null;
  }

  protected reconcile(): void {
    if (this.disposed) return;
    const want = this.wantVad();
    if (want === this.wantRunning) return;
    this.wantRunning = want;
    if (want) {
      this.lastStartError = null;
      this.starting = this.deps.vad
        .start(this, this.cfg.sensitivity)
        .catch((err: unknown) => {
          this.wantRunning = false;
          const message = (err as Error)?.message || String(err);
          this.lastStartError = message;
          // A trigger listen reports its own failure (tone + notice); the
          // interrupt / hands-free path turns hands-free off via onError.
          if (!this.listenWaiting) this.deps.onError?.(`Voice detection unavailable: ${message}`);
        })
        .finally(() => {
          this.starting = null;
          if (!this.wantVad() && this.deps.vad.running) {
            this.wantRunning = false;
            this.deps.vad.pause();
          }
        });
    } else if (!this.starting) {
      this.deps.vad.pause();
      this.preroll = [];
    }
  }

  // ---- remote trigger: listen -------------------------------------------------

  /** A trigger listen is armed or capturing. */
  get listenActive(): boolean {
    return this.listenWaiting || this.capturing === 'listen';
  }

  /**
   * Capture ONE utterance for a remote trigger; it is transcribed (source
   * `trigger`) when the speaker pauses. Resolves true once the VAD is running,
   * false when another capture owns the input (push-to-talk held). Rejects when
   * the microphone / VAD cannot start (e.g. a background tab without mic
   * permission): the caller reports it.
   */
  async listen(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.listenActive) return true;
    if (this.capturing === 'interrupt' || this.capturing === 'command') return true; // already capturing speech
    if (this.capturing === 'wake' && !this.wake?.woke) {
      // Someone is mid-utterance and hands-free was checking it for the wake
      // word: the trigger means "this is for you". The VAD delivers the whole
      // utterance at its end, so nothing is lost.
      this.dropWakeStream();
      if (!this.deps.input.beginExternal('trigger')) return false;
      this.capturing = 'listen';
      return true;
    }
    if (this.capturing === 'wake') return true; // woken: already listening
    if (!this.deps.input.beginExternal('trigger')) return false;
    this.clearAwait();
    this.armListenWait();
    this.reconcile();
    if (this.starting) await this.starting;
    if (!this.deps.vad.running && this.listenActive) {
      const reason = this.lastStartError;
      this.cancelListen();
      throw new Error(reason ? `Could not open the microphone: ${reason}` : 'Could not open the microphone');
    }
    return this.listenActive;
  }

  /** Abandon a trigger listen (stop / toggle again). True when one was running. */
  cancelListen(): boolean {
    const was = this.listenActive;
    this.clearListenWait();
    if (this.capturing === 'listen') this.capturing = null;
    if (was) this.deps.input.endExternal();
    this.reconcile();
    return was;
  }

  private armListenWait(): void {
    this.clearListenWait();
    this.listenWaiting = true;
    this.listenTimer = setTimeout(() => {
      this.listenTimer = null;
      if (!this.listenWaiting) return;
      this.listenWaiting = false;
      this.deps.input.endExternal();
      this.deps.input.fail("Didn't hear anything");
      this.reconcile();
    }, LISTEN_WAIT_MS);
  }

  private clearListenWait(): void {
    if (this.listenTimer) clearTimeout(this.listenTimer);
    this.listenTimer = null;
    this.listenWaiting = false;
  }

  // ---- VAD events -----------------------------------------------------------

  onSpeechStart(): void {
    if (this.listenWaiting && !this.capturing) {
      this.clearListenWait();
      this.capturing = 'listen';
      return;
    }
    // Interrupt waits for onSpeechRealStart (a single loud frame must not cut
    // Herald off). Hands-free starts streaming at once so the wake word's
    // first syllable is not lost; misfires are simply discarded.
    if (this.capturing || this.interruptArmed || !this.handsFreeActive) return;
    if (this.deps.input.state.phase !== 'idle' && !this.deps.input.listeningExternally) return;
    if (this.awaitingCommand) {
      this.capturing = 'command';
      this.clearAwait();
      this.deps.input.beginExternal('wake');
      return;
    }
    this.openWakeStream();
  }

  onSpeechRealStart(): void {
    if (this.capturing === 'wake' && this.interruptArmed) {
      // Hands-free opened a wake stream for this utterance just before Herald
      // started talking (or while its first words were still being fetched).
      // Talking over Herald must still stop it: woken, the wake flow carries
      // on (and has already silenced Herald); otherwise it becomes an interrupt.
      if (this.wake?.woke) {
        this.deps.stopSpeech();
        return;
      }
      this.dropWakeStream();
      this.capturing = null;
    }
    if (this.capturing === 'wake' || this.capturing === 'command') return;
    if (this.capturing || !this.interruptArmed) return;
    if (this.deps.input.state.phase !== 'idle') return; // push-to-talk owns the mic
    this.capturing = 'interrupt';
    this.deps.stopSpeech();
    this.deps.input.beginExternal('interrupt');
  }

  onMisfire(): void {
    const cap = this.capturing;
    this.capturing = null;
    if (cap === 'interrupt') this.deps.input.endExternal();
    else if (cap === 'wake') this.dropWakeStream();
    else if (cap === 'command') {
      this.deps.input.endExternal();
      this.startAwait(); // still waiting for the actual command
    } else if (cap === 'listen') {
      this.armListenWait(); // a cough is not the question: keep waiting
    }
    this.reconcile();
  }

  onSpeechEnd(audio: Float32Array): void {
    const cap = this.capturing;
    this.capturing = null;
    if (cap === 'listen') {
      void this.deps.input.transcribeUtterance(float32ToInt16Frames(audio), 'trigger');
    } else if (cap === 'interrupt' || cap === 'command') {
      void this.deps.input.transcribeUtterance(float32ToInt16Frames(audio), cap === 'command' ? 'wake' : 'interrupt');
    } else if (cap === 'wake') {
      void this.finishWakeStream();
    }
    this.reconcile();
  }

  onFrame(frame: Float32Array, _probability: number): void {
    const w = this.wake;
    if (w && !w.closed) {
      for (const f of w.framer.push(floatToInt16(frame))) w.uplink.push(f);
    } else if (this.handsFreeActive) {
      this.preroll.push(frame);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
    }
    if (this.capturing === 'interrupt' || this.capturing === 'command' || this.capturing === 'listen' || (this.capturing === 'wake' && w?.woke)) {
      this.deps.input.setLevel(meterLevel(rms16(floatToInt16(frame))));
    }
  }

  /** Per-client daemon pushes (wake detected, stream errors, hands-free revoked). */
  onVoiceEvent(ev: HeraldVoiceEvent): void {
    const w = this.wake;
    if (ev.kind === 'wake' && w && ev.streamId === w.uplink.streamId && !w.woke) {
      w.woke = true;
      // "Hey Jarvis" always silences Herald, even with talk-over interrupt off.
      if (this.cfg.speaking) this.deps.stopSpeech();
      this.deps.onWake?.();
      this.deps.input.beginExternal('wake');
    } else if (ev.kind === 'stream_error' && w && ev.streamId === w.uplink.streamId) {
      w.closed = true;
      if (w.woke) this.deps.input.deliverExternal(null, 'wake', ev.error);
      this.wake = null;
      if (this.capturing === 'wake') this.capturing = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.clearListenWait();
    this.clearAwait();
    this.dropWakeStream();
    this.deps.vad.destroy();
  }

  // ---- wake stream ------------------------------------------------------------

  private openWakeStream(): void {
    const t = this.deps.getTransport?.();
    if (!t || !t.isConnected()) return;
    const uplink = new VoiceUplink(t, 'wake');
    const w: WakeStream = { uplink, framer: new Framer(), woke: false, closed: false };
    for (const f of this.preroll) for (const out of w.framer.push(floatToInt16(f))) uplink.push(out);
    this.preroll = [];
    this.wake = w;
    this.capturing = 'wake';
  }

  private dropWakeStream(): void {
    const w = this.wake;
    this.wake = null;
    if (!w || w.closed) return;
    w.closed = true;
    w.uplink.discard();
  }

  private async finishWakeStream(): Promise<void> {
    const w = this.wake;
    if (!w || w.closed) return;
    const rest = w.framer.flush();
    if (rest.length) w.uplink.push(rest);
    w.closed = true; // no more frames
    if (!w.woke) {
      // The last wake check may still be in flight.
      const until = this.now() + WAKE_SETTLE_MS;
      while (!w.woke && this.now() < until && this.wake === w) await new Promise((r) => setTimeout(r, 50));
    }
    if (this.wake === w) this.wake = null;
    if (!w.woke) {
      w.uplink.discard();
      return;
    }
    this.deps.input.externalTranscribing('wake');
    try {
      const res = await w.uplink.finish('transcribe');
      const text = res.text.trim();
      if (text) {
        this.deps.input.deliverExternal(text, 'wake');
      } else {
        // Just "Hey Jarvis": the command is the next utterance.
        this.deps.input.deliverExternal(null, 'wake');
        this.deps.input.beginExternal('wake');
        this.startAwait();
      }
    } catch (err) {
      this.deps.input.deliverExternal(null, 'wake', (err as Error).message || 'Transcription failed');
    }
  }

  private startAwait(): void {
    this.clearAwait();
    this.awaitingUntil = this.now() + COMMAND_WAIT_MS;
    this.awaitTimer = setTimeout(() => {
      this.awaitingUntil = 0;
      if (!this.capturing) this.deps.input.endExternal();
    }, COMMAND_WAIT_MS);
  }

  private clearAwait(): void {
    if (this.awaitTimer) clearTimeout(this.awaitTimer);
    this.awaitTimer = null;
    this.awaitingUntil = 0;
  }

  private stopHandsFree(): void {
    this.clearAwait();
    if (this.capturing === 'wake' || this.capturing === 'command') {
      if (this.capturing === 'command' || this.wake?.woke) this.deps.input.endExternal();
      this.capturing = null;
    }
    this.dropWakeStream();
    this.preroll = [];
  }
}
