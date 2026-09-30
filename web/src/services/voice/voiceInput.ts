/**
 * Voice input state machine (no React): push-to-talk capture -> daemon STT ->
 * transcript callback. Later layers (VAD barge-in, hands-free wake word) feed
 * whole utterances through `transcribeUtterance`.
 *
 *   idle --start--> starting --mic open--> listening --stop--> transcribing --> idle
 *                        \--stop before open: runs as soon as the mic opens
 */
import type { HeraldTransport } from '../heraldTransport';
import { MicError, type MicFrame, type MicPermission } from './micCapture';
import { meterLevel } from './pcm';
import { VoiceUplink, VoiceUplinkError } from './voiceUplink';

export type VoiceInputPhase = 'idle' | 'starting' | 'listening' | 'transcribing';
/** `trigger`: a remote trigger (hotkey on another machine) opened the mic; ends on VAD. */
export type VoiceInputSource = 'button' | 'space' | 'chord' | 'interrupt' | 'wake' | 'trigger';

export interface VoiceInputState {
  phase: VoiceInputPhase;
  source: VoiceInputSource | null;
  /** 0..1 meter value while listening. */
  level: number;
  error: string | null;
  permission: MicPermission;
}

export interface MicLike {
  permission: MicPermission;
  start(onFrame: (f: MicFrame) => void): Promise<void>;
  stop(): void;
}

export interface VoiceInputDeps {
  mic: MicLike;
  getTransport: () => HeraldTransport | null;
  onTranscript: (text: string, source: VoiceInputSource) => void;
  /** User started talking: silence Herald (barge-in). */
  onBargeIn: () => void;
  now?: () => number;
}

/** Holds shorter than this are treated as accidental taps. */
export const MIN_HOLD_MS = 250;
/** Push-to-talk auto-stops after this (the daemon caps utterances at 60 s). */
export const MAX_HOLD_MS = 55_000;

export class VoiceInputController {
  private st: VoiceInputState = { phase: 'idle', source: null, level: 0, error: null, permission: 'unknown' };
  private listeners = new Set<(s: VoiceInputState) => void>();
  private uplink: VoiceUplink | null = null;
  private startedAt = 0;
  private stopRequested: 'commit' | 'cancel' | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private errorTimer: ReturnType<typeof setTimeout> | null = null;
  private gen = 0;
  /** Listening driven by the VAD (no mic/uplink owned here). */
  private external = false;
  private readonly now: () => number;

  constructor(private deps: VoiceInputDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  get state(): VoiceInputState {
    return this.st;
  }

  subscribe(l: (s: VoiceInputState) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Begin push-to-talk. No-op unless idle. */
  async start(source: VoiceInputSource): Promise<void> {
    if (this.st.phase !== 'idle') return;
    const t = this.deps.getTransport();
    if (!t || !t.isConnected()) {
      this.fail('Not connected to the Herald host');
      return;
    }
    const gen = ++this.gen;
    this.stopRequested = null;
    // Hold time counts from the press, not from when the mic finished opening.
    this.startedAt = this.now();
    this.set({ phase: 'starting', source, level: 0, error: null });
    this.deps.onBargeIn();
    const uplink = new VoiceUplink(t, 'stt');
    this.uplink = uplink;
    try {
      await this.deps.mic.start((f) => {
        if (gen !== this.gen || this.uplink !== uplink) return;
        uplink.push(f.pcm);
        if (this.st.phase === 'listening') this.set({ level: meterLevel(f.level) });
      });
    } catch (err) {
      if (gen !== this.gen) return;
      this.uplink = null;
      uplink.discard();
      this.set({ phase: 'idle', source: null, permission: this.deps.mic.permission });
      this.fail(err instanceof MicError ? err.message : 'Could not open the microphone');
      return;
    }
    if (gen !== this.gen) return;
    this.set({ phase: 'listening', permission: this.deps.mic.permission });
    this.maxTimer = setTimeout(() => void this.stop(), MAX_HOLD_MS);
    const pending = this.stopRequested;
    if (pending === 'cancel') this.cancel();
    else if (pending === 'commit') void this.stop();
  }

  /** Release: transcribe what was said. */
  async stop(): Promise<void> {
    if (this.st.phase === 'starting') {
      this.stopRequested = 'commit';
      return;
    }
    if (this.st.phase !== 'listening') return;
    const uplink = this.uplink!;
    const source = this.st.source!;
    const held = this.now() - this.startedAt;
    this.clearMax();
    this.deps.mic.stop();
    if (held < MIN_HOLD_MS) {
      this.uplink = null;
      uplink.discard();
      this.set({ phase: 'idle', source: null, level: 0 });
      this.fail('Hold to talk, release to send');
      return;
    }
    this.set({ phase: 'transcribing', level: 0 });
    // Let the worklet's final partial frame land before closing the stream.
    await new Promise((r) => setTimeout(r, 60));
    await this.finishUplink(uplink, source, this.gen);
  }

  /** Abort without transcribing. */
  cancel(): void {
    if (this.st.phase === 'starting') {
      this.stopRequested = 'cancel';
      return;
    }
    if (this.st.phase === 'idle') return;
    this.gen++;
    this.external = false;
    this.clearMax();
    this.deps.mic.stop();
    this.uplink?.discard();
    this.uplink = null;
    this.set({ phase: 'idle', source: null, level: 0 });
  }

  /** The VAD heard real speech: show "listening" without owning the mic. */
  beginExternal(source: VoiceInputSource): boolean {
    if (this.st.phase !== 'idle') return false;
    this.external = true;
    this.set({ phase: 'listening', source, level: 0, error: null });
    return true;
  }

  /** VAD-driven level updates while listening externally. */
  setLevel(level: number): void {
    if (this.external && this.st.phase === 'listening') this.set({ level });
  }

  /** The VAD utterance was dropped (misfire / no wake word). */
  endExternal(): void {
    if (!this.external) return;
    this.external = false;
    if (this.st.phase === 'listening') this.set({ phase: 'idle', source: null, level: 0 });
  }

  /** External capture handed to transcription elsewhere (wake stream). */
  externalTranscribing(source: VoiceInputSource): void {
    this.external = false;
    this.set({ phase: 'transcribing', source, level: 0 });
  }

  /** Result of an externally transcribed utterance. */
  deliverExternal(text: string | null, source: VoiceInputSource, error?: string): void {
    this.external = false;
    this.set({ phase: 'idle', source: null, level: 0 });
    if (text) this.deps.onTranscript(text, source);
    else if (error) this.fail(error);
  }

  get listeningExternally(): boolean {
    return this.external && this.st.phase === 'listening';
  }

  /**
   * Transcribe a complete utterance captured elsewhere (VAD). Frames are
   * 16 kHz PCM16. Allowed when idle or listening externally.
   */
  async transcribeUtterance(frames: Int16Array[], source: VoiceInputSource): Promise<void> {
    const externalListening = this.external && this.st.phase === 'listening';
    this.external = false;
    if (this.st.phase !== 'idle' && !externalListening) return;
    const t = this.deps.getTransport();
    if (!t || !t.isConnected()) return;
    const gen = ++this.gen;
    const uplink = new VoiceUplink(t, 'stt');
    this.uplink = uplink;
    for (const f of frames) uplink.push(f);
    this.set({ phase: 'transcribing', source, level: 0, error: null });
    await this.finishUplink(uplink, source, gen);
  }

  /** Show a transient error (e.g. from the VAD / wake layers). */
  fail(message: string): void {
    this.set({ error: message });
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.errorTimer = setTimeout(() => this.set({ error: null }), 5000);
  }

  clearError(): void {
    this.set({ error: null });
  }

  dispose(): void {
    this.cancel();
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.listeners.clear();
  }

  // ---- internals ----------------------------------------------------------

  private async finishUplink(uplink: VoiceUplink, source: VoiceInputSource, gen: number): Promise<void> {
    try {
      const res = await uplink.finish('transcribe');
      if (gen !== this.gen) return;
      this.uplink = null;
      this.set({ phase: 'idle', source: null });
      const text = res.text.trim();
      if (text) this.deps.onTranscript(text, source);
      else this.fail("Didn't catch that");
    } catch (err) {
      if (gen !== this.gen) return;
      this.uplink = null;
      this.set({ phase: 'idle', source: null });
      const code = err instanceof VoiceUplinkError ? err.code : 'failed';
      this.fail(code === 'unavailable' ? 'Voice input is unavailable (voice service down)' : (err as Error).message || 'Transcription failed');
    }
  }

  private clearMax(): void {
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.maxTimer = null;
  }

  private set(patch: Partial<VoiceInputState>): void {
    this.st = { ...this.st, ...patch };
    for (const l of [...this.listeners]) {
      try {
        l(this.st);
      } catch {
        // ignore
      }
    }
  }
}
