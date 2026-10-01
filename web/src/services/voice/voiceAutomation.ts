/**
 * Decides when the VAD runs and what speech means (no React, testable).
 *
 * Interrupt (barge-in): while Herald is speaking, and for a short grace period
 * after, real speech (past minSpeechMs, so a cough or click does not count)
 * stops Herald on both the client and the server queue; the utterance is
 * transcribed and sent when the speaker pauses.
 *
 * Two talk-over modes (`bargeIn`, chosen by audioEnvironment / bargeInMode.ts):
 * - 'vad': the mic is echo-cancelled well enough (measured) that the VAD never
 *   hears Herald: real speech stops Herald at once (minSpeechMs, ~0.3 s). If one
 *   such stop turns out to be Herald's own voice anyway, `onFalseBargeIn` drops
 *   this setup back to 'gated'.
 * - 'gated' (below): no or weak echo cancellation.
 *
 * Echo gating: through speakers the mic hears Herald itself, and echo
 * cancellation does not always remove our own playback (WKWebView never does).
 * So while Herald is speaking, speech only stops it once a quick transcript of
 * what was heard (the latest ~1.6 s, re-checked every ~0.45 s while the speech
 * goes on, one check in flight at a time) is NOT Herald's own words (`isEcho`, see echoGuard.ts). A real
 * "stop" / "wait" is not in what Herald said, so it still cuts through, about
 * half a second later. Why not an energy test (mic louder than the playback)?
 * Room, volume, device and partial AEC all move the ratio, and the Web Speech
 * fallback has no playback signal to compare with; the words themselves do not
 * lie. For ECHO_TAIL_MS after Herald stops, new speech is ignored for barge-in
 * (the room is still ringing with its last word).
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
 * Follow-up window (`followUp`): right after Herald finishes speaking a reply
 * to a voice turn, the next utterance within a few seconds is a follow-up: no
 * wake word, no key. Like a trigger listen, minus the "go ahead" tone, and
 * silence closes it quietly. The VAD listens to the CLEANED mic (Herald has
 * stopped, so the canceller only has the room tail to remove), speech that
 * starts inside the echo tail is not taken, Herald speaking again closes it,
 * and the transcript still goes through the self-echo filter downstream.
 *
 * Interrupt never opens the mic on its own (permission must already be
 * granted); hands-free is turned on by the user, which may prompt.
 *
 * Two signals (with in-graph echo cancellation, `raw`): the VAD listens to the
 * CLEANED mic (Herald removed, so Herald never triggers it), while the words of
 * a talk-over and the wake stream come from the RAW mic: the canceller clamps
 * the user's voice while Herald is still talking, exactly when they say
 * "stop". Herald's words in the raw audio are cut at the text level.
 */
import type { HeraldVoiceEvent } from '../../types/herald';
import type { HeraldTransport } from '../heraldTransport';
import { Framer, float32ToInt16Frames, floatToInt16, meterLevel, rms16 } from './pcm';
import type { VadEvents, VadLike, VadSensitivity } from './vadListener';
import type { VoiceInputController } from './voiceInput';
import { VoiceUplink } from './voiceUplink';
import type { RawAudio } from './rawTap';
import { isStopUtterance, stopAfterWake } from './fleetSpeaking';

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
  /** Talk-over detection: instant on the VAD ('vad') or transcript-checked ('gated', default). */
  bargeIn?: 'vad' | 'gated';
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
  /** Is this transcript Herald's own voice (heard through the speakers)? */
  isEcho?: (text: string) => boolean;
  /**
   * A partial transcript heard while Herald talks is clearly a person (stricter
   * than "not echo"). Default: not echo.
   */
  isBargeIn?: (text: string) => boolean;
  /** Cut Herald's own words out of a confirmed interruption (it may be mixed in). */
  stripEcho?: (text: string) => string;
  /** Quick transcription for echo checks (default: a daemon STT stream). */
  transcribe?: (audio: Float32Array) => Promise<string>;
  /** A gated check found Herald's own voice: the VAD hears it through the canceller. */
  onEchoHeard?: () => void;
  /** An instant ('vad') talk-over turned out to be Herald's own voice. */
  onFalseBargeIn?: () => void;
  /** Time (ms) from the VAD's speech start to Herald being stopped (diagnostics). */
  onBargeInLatency?: (ms: number, mode: 'vad' | 'gated') => void;
  /** The mic before echo cancellation (16 kHz), when the graph cancels in-app. */
  raw?: () => RawAudio | null;
  /** The follow-up window opened (`until`: epoch ms it closes, `ms`: its length) or closed (null). */
  onFollowUp?: (w: FollowUpWindow | null) => void;
  /**
   * Herald is speaking on ANOTHER device (or just stopped): this mic hears it
   * with nothing to cancel it against. No talk-over, no follow-up, and a wake
   * word only counts when "stop" follows at once (`onFleetStop`).
   */
  fleetSuppressed?: () => boolean;
  /** "Hey Jarvis, stop" heard while another device speaks. */
  onFleetStop?: () => void;
}

export interface FollowUpWindow {
  until: number;
  ms: number;
}

/** Default follow-up window after a spoken reply to a voice turn. */
export const FOLLOW_UP_MS = 6000;

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
/** After Herald stops, speech this soon is its own tail, not a barge-in. */
export const ECHO_TAIL_MS = 600;
/** First echo check this many frames (32 ms) after real speech start. */
export const GATE_FIRST_CHECK_FRAMES = 10;
/** Then re-check this often while the speech goes on and is still echo. */
export const GATE_CHECK_EVERY_FRAMES = 14;
/** Each check transcribes at most this much of the latest audio (~1.6 s): less echo mixed in. */
export const GATE_WINDOW_FRAMES = 50;
/** VAD frame size (16 kHz samples). */
const FRAME = 512;
/**
 * Raw audio kept ahead of the VAD's speech start: the cleaned path's extra
 * latency over the tap (MediaStream hop, worklet, ONNX; ~250 ms measured in
 * Chromium and WebKit) plus a margin. More would only add Herald's voice.
 */
export const RAW_LEAD_SAMPLES = Math.round(16000 * 0.35);

/**
 * Strip Herald's words only where they can be: in an instant stop, Herald talks
 * over the first `echoFraction` of the clip and is silent after. Words past that
 * part (plus a two-word margin) are the user's, even when they happen to match
 * something Herald said ("hold ON A second" vs "waiting ON you").
 */
export function stripEchoPrefix(text: string, echoFraction: number, strip: (t: string) => string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const n = Math.min(words.length, Math.ceil(words.length * Math.max(0, Math.min(1, echoFraction))) + 2);
  if (n >= words.length) return strip(text);
  const head = strip(words.slice(0, n).join(' '));
  return [head, ...words.slice(n)].filter(Boolean).join(' ').trim();
}

interface InterruptGate {
  frames: Float32Array[];
  sinceCheck: number;
  checks: number;
  checking: boolean;
  /** Not echo: Herald stopped, this is the user. */
  confirmed: boolean;
  /** Frames dropped from the front at confirmation (the echo before the user spoke). */
  trimmed: boolean;
  /** Confirmed instantly on the VAD alone ('vad' mode) while Herald was talking. */
  instant: boolean;
  /** Echo already reported for this utterance. */
  echoReported: boolean;
  /** When the VAD first heard it (speech start), for latency. */
  heardAt: number;
  /** Raw mic (before cancellation) and where this utterance starts in it. */
  raw: RawAudio | null;
  rawStart: number;
  /** Start of the last gate check's window (raw), for trimming at confirmation. */
  rawWindowFrom: number;
  /** Raw position when Herald was stopped (-1: not yet). */
  rawStopAt: number;
}

function concatFrames(frames: Float32Array[]): Float32Array {
  let n = 0;
  for (const f of frames) n += f.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const f of frames) {
    out.set(f, o);
    o += f.length;
  }
  return out;
}

type Capture = 'interrupt' | 'wake' | 'command' | 'listen' | 'followup';

interface WakeStream {
  uplink: VoiceUplink;
  framer: Framer;
  woke: boolean;
  closed: boolean;
  /** Streaming the raw mic from here (position), instead of the VAD's frames. */
  raw: RawAudio | null;
  rawPos: number;
  /** Woken while another device was speaking: no chime, no listening UI; only "stop" counts. */
  quiet?: boolean;
  /** The latest ~3 s of frames (no raw tap): a quiet wake's early stop checks look back at them. */
  recent?: Float32Array[];
  /** Quiet wake: "stop" already acted on. */
  stopFired?: boolean;
}

/** Quiet wake: look for "Jarvis, stop" this long after the wake word, without waiting for a pause. */
export const FLEET_STOP_CHECKS_MS = [300, 700, 1200, 1800, 2600];
/** Each early check transcribes the latest this-much audio (16 kHz samples). */
const FLEET_STOP_WINDOW = 16000 * 3;

export class VoiceAutomation implements VadEvents {
  protected cfg: AutomationConfig = { available: false, micGranted: false, interrupt: false, sensitivity: 'normal', speaking: false, handsFree: false, bargeIn: 'gated' };
  private speechStartAt = 0;
  private raw: RawAudio | null = null;
  private rawStart = 0;
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
  private tailUntil = 0;
  /** Follow-up window: waiting for speech until this time (0: closed). */
  private followUntil = 0;
  private followMs = 0;
  /** When the current window closes, kept while a follow-up is being captured. */
  private followDeadline = 0;
  private followTimer: ReturnType<typeof setTimeout> | null = null;
  private gate: InterruptGate | null = null;
  protected readonly now: () => number;

  constructor(protected deps: AutomationDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  update(next: AutomationConfig): void {
    const prev = this.cfg;
    this.cfg = { ...next, handsFree: !!next.handsFree, bargeIn: next.bargeIn ?? 'gated' };
    // Herald talks again (a new reply, a confirmation): the window is over.
    if (next.speaking && this.followUpWaiting) this.closeFollowUp();
    if (prev.speaking && !next.speaking) {
      this.tailUntil = this.now() + ECHO_TAIL_MS;
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
    return this.interruptArmed || this.handsFreeActive || this.listenWaiting || this.followUpWaiting || this.capturing !== null;
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
          // A follow-up window that cannot open just closes, quietly.
          const onlyFollowUp = this.followUpWaiting && !this.listenWaiting && !this.interruptArmed && !this.handsFreeActive;
          if (this.followUpWaiting) this.closeFollowUp();
          // A trigger listen reports its own failure (tone + notice); the
          // interrupt / hands-free path turns hands-free off via onError.
          if (!this.listenWaiting && !onlyFollowUp) this.deps.onError?.(`Voice detection unavailable: ${message}`);
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
    // A trigger during a follow-up window: the trigger's capture takes over.
    if (this.followUpWaiting) this.closeFollowUp();
    if (this.capturing === 'followup') return true; // already capturing the follow-up
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

  // ---- follow-up window -------------------------------------------------------

  /** Waiting for a follow-up (speech not started yet). */
  get followUpWaiting(): boolean {
    return this.followUntil > 0;
  }

  /**
   * Open the follow-up window for `ms`: the next utterance that starts in it is
   * captured whole (source `followup`) and transcribed when the speaker pauses.
   * False when it cannot open now (something else is capturing, Herald is
   * talking, voice input unavailable).
   */
  followUp(ms: number = FOLLOW_UP_MS): boolean {
    if (this.disposed || ms <= 0) return false;
    if (!this.cfg.available || this.cfg.speaking) return false;
    if (this.fleetSuppressed()) return false;
    if (this.capturing || this.listenWaiting || this.awaitingCommand) return false;
    if (this.deps.input.state.phase !== 'idle') return false;
    this.armFollowUp(this.now() + ms, ms);
    this.reconcile();
    return true;
  }

  /** Close the window without capturing (push-to-talk took over, user dismissed). */
  cancelFollowUp(): void {
    if (this.followUpWaiting) this.closeFollowUp();
  }

  private armFollowUp(until: number, ms: number): void {
    if (this.followTimer) clearTimeout(this.followTimer);
    this.followUntil = until;
    this.followDeadline = until;
    this.followMs = ms;
    this.followTimer = setTimeout(() => {
      this.followTimer = null;
      // Silence: close quietly (no tone, no message).
      if (this.followUpWaiting) this.closeFollowUp();
    }, Math.max(0, until - this.now()));
    this.deps.onFollowUp?.({ until, ms });
  }

  private closeFollowUp(): void {
    if (this.followTimer) clearTimeout(this.followTimer);
    this.followTimer = null;
    const was = this.followUpWaiting;
    this.followUntil = 0;
    if (was) this.deps.onFollowUp?.(null);
    this.reconcile();
  }

  /** The follow-up window takes this utterance (true) or leaves it to the other layers. */
  private takeFollowUp(): boolean {
    if (!this.followUpWaiting || this.capturing) return false;
    if (this.deps.input.state.phase !== 'idle') {
      // Push-to-talk (or another capture) owns the mic now.
      this.closeFollowUp();
      return false;
    }
    // Herald's last word still ringing in the room: not the user.
    if (this.now() < this.tailUntil) return false;
    // Herald talking on another device: what this mic hears is probably Herald.
    if (this.fleetSuppressed()) {
      this.closeFollowUp();
      return false;
    }
    if (this.followTimer) clearTimeout(this.followTimer);
    this.followTimer = null;
    if (!this.deps.input.beginExternal('followup')) return false;
    // The deadline stays in `followDeadline`: a cough (misfire) re-opens what is left.
    this.followUntil = 0;
    this.deps.onFollowUp?.(null);
    this.capturing = 'followup';
    return true;
  }

  // ---- VAD events -----------------------------------------------------------

  onSpeechStart(): void {
    this.speechStartAt = this.now();
    this.raw = this.deps.raw?.() ?? null;
    this.rawStart = this.raw ? Math.max(0, this.raw.position() - RAW_LEAD_SAMPLES) : 0;
    if (this.listenWaiting && !this.capturing) {
      this.clearListenWait();
      this.capturing = 'listen';
      return;
    }
    // Follow-up window: this utterance is for Herald, no wake word needed.
    if (this.takeFollowUp()) return;
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
    // Not speaking here, but another device is: its voice is not ours to cancel.
    if (!this.cfg.speaking && this.fleetSuppressed()) return;
    // Herald just stopped: what the VAD hears now is its last word in the room.
    if (!this.cfg.speaking && this.now() < this.tailUntil) return;
    this.capturing = 'interrupt';
    const instant = this.cfg.speaking && this.cfg.bargeIn === 'vad';
    this.gate = {
      frames: this.preroll.slice(), sinceCheck: 0, checks: 0, checking: false, confirmed: false, trimmed: false, instant, echoReported: false,
      heardAt: this.speechStartAt || this.now(),
      raw: this.raw, rawStart: this.rawStart, rawWindowFrom: this.rawStart, rawStopAt: -1,
    };
    this.preroll = [];
    // Nothing playing (the grace period after a reply): no echo to rule out.
    // Echo-cancelled well enough (measured): the VAD alone is proof of a person.
    if (!this.cfg.speaking || instant) this.confirmInterrupt(this.gate, 0);
  }

  private noteEcho(g: InterruptGate): void {
    if (g.echoReported) return;
    g.echoReported = true;
    if (g.instant) this.deps.onFalseBargeIn?.();
    else this.deps.onEchoHeard?.();
  }

  /** Is `text` Herald's own voice? Logged (debug) and dropped by the caller when so. */
  private echo(text: string): boolean {
    if (!this.deps.isEcho?.(text)) return false;
    console.debug('Herald voice: ignored likely self-echo:', JSON.stringify(text));
    return true;
  }

  private async quickTranscribe(audio: Float32Array): Promise<string> {
    if (this.deps.transcribe) return (await this.deps.transcribe(audio)).trim();
    const t = this.deps.getTransport?.();
    if (!t || !t.isConnected()) return '';
    const up = new VoiceUplink(t, 'stt');
    for (const f of float32ToInt16Frames(audio)) up.push(f);
    return (await up.finish('transcribe')).text.trim();
  }

  /** Transcribe the latest window of a gated interrupt; not echo -> barge in. */
  private async checkGate(g: InterruptGate): Promise<void> {
    g.checking = true;
    g.sinceCheck = 0;
    g.checks++;
    const start = Math.max(0, g.frames.length - GATE_WINDOW_FRAMES);
    let audio: Float32Array;
    if (g.raw) {
      const to = g.raw.position();
      g.rawWindowFrom = Math.max(g.rawStart, to - GATE_WINDOW_FRAMES * FRAME);
      audio = g.raw.slice(g.rawWindowFrom, to);
    } else {
      audio = concatFrames(g.frames.slice(start));
    }
    let text = '';
    try {
      text = await this.quickTranscribe(audio);
    } catch {
      text = '';
    }
    g.checking = false;
    if (this.gate !== g || g.confirmed || this.capturing !== 'interrupt') return;
    if (!text) return;
    if (this.echo(text)) {
      this.noteEcho(g);
      return;
    }
    if (this.deps.isBargeIn && !this.deps.isBargeIn(text)) {
      console.debug('Herald voice: not sure it is a person yet:', JSON.stringify(text));
      return;
    }
    console.debug('Herald voice: barge-in confirmed by:', JSON.stringify(text));
    this.confirmInterrupt(g, start);
  }

  /** The user really is talking over Herald: stop it and show listening. */
  private confirmInterrupt(g: InterruptGate, start: number): void {
    g.confirmed = true;
    if (g.raw) g.rawStopAt = g.raw.position();
    if (this.cfg.speaking) this.deps.onBargeInLatency?.(Math.max(0, this.now() - g.heardAt), g.instant ? 'vad' : 'gated');
    if (start > 0) {
      g.frames = g.frames.slice(start);
      g.trimmed = true;
      g.rawStart = g.rawWindowFrom;
    }
    this.deps.stopSpeech();
    if (!this.deps.input.beginExternal('interrupt')) {
      // Push-to-talk took the mic meanwhile: it owns this one.
      this.gate = null;
      this.capturing = null;
    }
  }

  /**
   * A confirmed interruption ended: transcribe it and cut out Herald's own
   * words (through speakers they are mixed in), then hand it on.
   */
  private async finishConfirmed(audio: Float32Array, g?: InterruptGate, echoFraction = 1): Promise<void> {
    const input = this.deps.input;
    if (!input.listeningExternally) return;
    input.externalTranscribing('interrupt');
    let text = '';
    try {
      text = await this.quickTranscribe(audio);
    } catch (err) {
      input.deliverExternal(null, 'interrupt', (err as Error)?.message || 'Transcription failed');
      return;
    }
    if (!text) {
      input.deliverExternal(null, 'interrupt', "Didn't catch that");
      return;
    }
    if (g?.instant && this.echo(text)) {
      // The VAD fired on Herald itself: the canceller is not good enough here.
      this.noteEcho(g);
      input.deliverExternal(null, 'interrupt');
      return;
    }
    const strip = this.deps.stripEcho;
    const cleaned = strip ? (echoFraction < 1 ? stripEchoPrefix(text, echoFraction, strip) : strip(text)) : text;
    if (cleaned !== text) console.debug('Herald voice: cut self-echo out of an interruption:', JSON.stringify(text), '->', JSON.stringify(cleaned));
    input.deliverExternal(cleaned || null, 'interrupt');
  }

  /** The utterance ended before any check cleared it: one last look at all of it. */
  private async finishUnconfirmed(audio: Float32Array, g?: InterruptGate): Promise<void> {
    let text = '';
    try {
      text = await this.quickTranscribe(audio);
    } catch {
      return;
    }
    if (!text) return;
    if (this.echo(text)) {
      if (g) this.noteEcho(g);
      return;
    }
    if (this.cfg.speaking) this.deps.stopSpeech();
    if (this.deps.input.state.phase !== 'idle') return;
    const cleaned = this.deps.stripEcho ? this.deps.stripEcho(text) : text;
    if (cleaned) this.deps.input.deliverExternal(cleaned, 'interrupt');
  }

  onMisfire(): void {
    const cap = this.capturing;
    this.capturing = null;
    if (cap === 'interrupt') {
      if (this.gate?.confirmed) this.deps.input.endExternal();
      this.gate = null;
    }
    else if (cap === 'wake') this.dropWakeStream();
    else if (cap === 'command') {
      this.deps.input.endExternal();
      this.startAwait(); // still waiting for the actual command
    } else if (cap === 'listen') {
      this.armListenWait(); // a cough is not the question: keep waiting
    } else if (cap === 'followup') {
      this.deps.input.endExternal();
      // A cough is not the follow-up: re-open what is left of the window.
      if (this.followDeadline - this.now() > 300) this.armFollowUp(this.followDeadline, this.followMs);
    }
    this.reconcile();
  }

  onSpeechEnd(audio: Float32Array): void {
    const cap = this.capturing;
    this.capturing = null;
    if (cap === 'listen') {
      void this.deps.input.transcribeUtterance(float32ToInt16Frames(audio), 'trigger');
    } else if (cap === 'followup') {
      this.followDeadline = 0;
      void this.deps.input.transcribeUtterance(float32ToInt16Frames(audio), 'followup');
    } else if (cap === 'interrupt') {
      const g = this.gate;
      this.gate = null;
      // Raw mic when there is one: the user's words intact (see the top).
      const rawClip = g?.raw ? g.raw.slice(g.rawStart, g.raw.position()) : null;
      if (g?.confirmed) {
        // Trimmed: only what followed the echo (the VAD's audio starts with it).
        const useRaw = !!rawClip && rawClip.length > 0;
        const clip = useRaw ? rawClip! : g.trimmed ? concatFrames(g.frames) : audio;
        // Instant stop: Herald can only be in the clip up to the stop (plus its room tail).
        const fraction = useRaw && g.instant && g.rawStopAt > 0 ? (g.rawStopAt - g.rawStart + 16000 * 0.3) / rawClip!.length : 1;
        void this.finishConfirmed(clip, g, fraction);
      } else if (g) {
        void this.finishUnconfirmed(rawClip && rawClip.length ? rawClip : audio, g);
      }
    } else if (cap === 'command') {
      void this.deps.input.transcribeUtterance(float32ToInt16Frames(audio), 'wake');
    } else if (cap === 'wake') {
      void this.finishWakeStream();
    }
    this.reconcile();
  }

  onFrame(frame: Float32Array, _probability: number): void {
    const w = this.wake;
    const g = this.capturing === 'interrupt' ? this.gate : null;
    if (w && w.recent) {
      w.recent.push(frame);
      if (w.recent.length > FLEET_STOP_WINDOW / FRAME) w.recent.shift();
    }
    if (w && !w.closed) {
      let chunk = frame;
      if (w.raw) {
        const to = w.raw.position();
        chunk = w.raw.slice(w.rawPos, to);
        w.rawPos = to;
      }
      for (const f of w.framer.push(floatToInt16(chunk))) w.uplink.push(f);
    } else if (g) {
      g.frames.push(frame);
      if (!g.confirmed) {
        // Counted while a check is in flight too: a slow STT means the next
        // check goes out as soon as the last one returns.
        g.sinceCheck++;
        if (!g.checking && g.sinceCheck >= (g.checks === 0 ? GATE_FIRST_CHECK_FRAMES : GATE_CHECK_EVERY_FRAMES)) void this.checkGate(g);
      }
    } else {
      this.preroll.push(frame);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
    }
    if ((this.capturing === 'interrupt' && g?.confirmed) || this.capturing === 'command' || this.capturing === 'listen' || this.capturing === 'followup' || (this.capturing === 'wake' && w?.woke)) {
      this.deps.input.setLevel(meterLevel(rms16(floatToInt16(frame))));
    }
  }

  /** Per-client daemon pushes (wake detected, stream errors, hands-free revoked). */
  onVoiceEvent(ev: HeraldVoiceEvent): void {
    const w = this.wake;
    if (ev.kind === 'wake' && w && ev.streamId === w.uplink.streamId && !w.woke) {
      w.woke = true;
      if (!this.cfg.speaking && this.fleetSuppressed()) {
        // Herald's own speech on another device can say "Jarvis": stay quiet
        // and only act on an immediate "stop". Herald keeps talking into this
        // mic, so the utterance may not end until it stops: check early too.
        w.quiet = true;
        this.scheduleFleetStopChecks(w);
        return;
      }
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
    if (this.followTimer) clearTimeout(this.followTimer);
    this.followUntil = 0;
    this.clearListenWait();
    this.clearAwait();
    this.dropWakeStream();
    this.deps.vad.destroy();
  }

  private fleetSuppressed(): boolean {
    return this.deps.fleetSuppressed?.() ?? false;
  }

  private fleetStop(w: WakeStream): void {
    if (w.stopFired) return;
    w.stopFired = true;
    this.deps.onFleetStop?.();
  }

  /** Transcribe the latest few seconds a few times after a quiet wake: "Jarvis, stop" acts at once. */
  private scheduleFleetStopChecks(w: WakeStream): void {
    const start = this.now();
    let i = 0;
    const next = () => {
      if (this.disposed || w.stopFired || i >= FLEET_STOP_CHECKS_MS.length) return;
      const wait = Math.max(0, start + FLEET_STOP_CHECKS_MS[i++] - this.now());
      setTimeout(() => void check(), wait);
    };
    const check = async () => {
      if (this.disposed || w.stopFired) return;
      let audio: Float32Array;
      if (w.raw) {
        const to = w.raw.position();
        audio = w.raw.slice(Math.max(0, to - FLEET_STOP_WINDOW), to);
      } else {
        audio = concatFrames(w.recent ?? []);
      }
      let text = '';
      if (audio.length > 0) {
        try {
          text = await this.quickTranscribe(audio);
        } catch {
          text = '';
        }
      }
      if (stopAfterWake(text)) {
        console.debug('Herald voice: "stop" after the wake word while another device speaks:', JSON.stringify(text));
        this.fleetStop(w);
        return;
      }
      next();
    };
    next();
  }

  // ---- wake stream ------------------------------------------------------------

  private openWakeStream(): void {
    const t = this.deps.getTransport?.();
    if (!t || !t.isConnected()) return;
    const uplink = new VoiceUplink(t, 'wake');
    const raw = this.raw;
    const w: WakeStream = {
      uplink, framer: new Framer(), woke: false, closed: false, raw, rawPos: raw ? raw.position() : 0,
      // Without a raw tap, keep the latest frames for a quiet wake's stop checks.
      recent: raw ? undefined : this.preroll.slice(),
    };
    if (raw) {
      for (const out of w.framer.push(floatToInt16(raw.slice(this.rawStart, w.rawPos)))) uplink.push(out);
    } else {
      for (const f of this.preroll) for (const out of w.framer.push(floatToInt16(f))) uplink.push(out);
    }
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
    if (w.quiet) {
      let text = '';
      try {
        text = (await w.uplink.finish('transcribe')).text.trim();
      } catch {
        return;
      }
      if (w.stopFired) return;
      if (isStopUtterance(text)) this.fleetStop(w);
      else console.debug('Herald voice: ignored a wake word while another device speaks:', JSON.stringify(text));
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
