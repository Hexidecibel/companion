/**
 * Microphone ownership for Herald voice input. One MediaStream (echo
 * cancellation, noise suppression and AGC on) is shared by push-to-talk
 * capture and the VAD; it is released after a short idle so the browser's
 * "mic in use" indicator does not stay lit when nothing is listening.
 */
import captureWorkletUrl from './captureWorklet?worker&url';
import { voiceCopy } from './platformCopy';

export type MicPermission = 'unknown' | 'granted' | 'denied' | 'unavailable';

export interface MicFrame {
  pcm: Int16Array;
  level: number;
}

const IDLE_RELEASE_MS = 20_000;

export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
  video: false,
};

/** Why voice input can't work on this page, or null if it can. */
export function micUnavailableReason(): string | null {
  if (typeof window === 'undefined') return 'No browser';
  if (!window.isSecureContext) return voiceCopy().micInsecure;
  if (!navigator.mediaDevices?.getUserMedia) return voiceCopy().micMissing;
  if (typeof AudioWorkletNode === 'undefined') return 'This browser lacks AudioWorklet.';
  return null;
}

export class MicError extends Error {
  constructor(message: string, readonly permission: MicPermission) {
    super(message);
    this.name = 'MicError';
  }
}

export class MicCapture {
  private stream: MediaStream | null = null;
  private streamPromise: Promise<MediaStream> | null = null;
  private ctx: AudioContext | null = null;
  private workletReady: Promise<void> | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private users = 0;
  permission: MicPermission = 'unknown';

  /** Get (or reuse) the shared stream. Throws MicError. */
  async acquire(): Promise<MediaStream> {
    this.cancelIdle();
    if (this.stream && this.stream.getAudioTracks().some((t) => t.readyState === 'live')) return this.stream;
    if (this.streamPromise) return this.streamPromise;
    const reason = micUnavailableReason();
    if (reason) {
      this.permission = 'unavailable';
      throw new MicError(reason, 'unavailable');
    }
    this.streamPromise = navigator.mediaDevices
      .getUserMedia(MIC_CONSTRAINTS)
      .then((s) => {
        this.stream = s;
        this.permission = 'granted';
        return s;
      })
      .catch((err: unknown) => {
        const name = (err as { name?: string })?.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          this.permission = 'denied';
          throw new MicError(voiceCopy().micDenied, 'denied');
        }
        if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          this.permission = 'unavailable';
          throw new MicError('No microphone found.', 'unavailable');
        }
        throw new MicError('Could not open the microphone.', 'unavailable');
      })
      .finally(() => {
        this.streamPromise = null;
      });
    return this.streamPromise;
  }

  /** Register a long-lived user (VAD) so the stream is not idle-released. */
  retain(): void {
    this.users++;
    this.cancelIdle();
  }

  releaseUser(): void {
    this.users = Math.max(0, this.users - 1);
    this.scheduleIdle();
  }

  /** Start streaming 16 kHz PCM16 frames to `onFrame` until stop(). */
  async start(onFrame: (f: MicFrame) => void): Promise<void> {
    const stream = await this.acquire();
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.workletReady = this.ctx.audioWorklet.addModule(captureWorkletUrl);
    }
    await this.workletReady;
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
    this.stopNode();
    this.source = this.ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(this.ctx, 'herald-capture', { numberOfInputs: 1, numberOfOutputs: 0 });
    node.port.onmessage = (e: MessageEvent<MicFrame>) => {
      if (this.node === node) onFrame(e.data);
    };
    this.source.connect(node);
    this.node = node;
  }

  /** Stop frames (the worklet flushes its last partial frame first). */
  stop(): void {
    const node = this.node;
    if (node) {
      node.port.postMessage('stop');
      // Let the flushed partial frame arrive, then detach.
      setTimeout(() => {
        if (this.node === node) this.stopNode();
      }, 30);
    }
    this.scheduleIdle();
  }

  get stream_(): MediaStream | null {
    return this.stream;
  }

  /** Close everything now. */
  release(): void {
    this.cancelIdle();
    this.stopNode();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.ctx && this.ctx.state !== 'closed') void this.ctx.close().catch(() => {});
    this.ctx = null;
    this.workletReady = null;
  }

  private stopNode(): void {
    try {
      this.source?.disconnect();
      this.node?.disconnect();
    } catch {
      // already disconnected
    }
    if (this.node) this.node.port.onmessage = null;
    this.node = null;
    this.source = null;
  }

  private cancelIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdle(): void {
    this.cancelIdle();
    if (this.users > 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.users === 0 && !this.node) this.release();
    }, IDLE_RELEASE_MS);
  }
}

let shared: MicCapture | null = null;
export function getMicCapture(): MicCapture {
  if (!shared) shared = new MicCapture();
  return shared;
}
