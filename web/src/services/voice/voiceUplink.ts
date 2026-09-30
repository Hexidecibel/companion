/**
 * One utterance's trip to the daemon: stream start, PCM16 chunks as
 * fire-and-forget WS messages, then end -> transcript. The daemon processes a
 * socket's messages in order and opens the stream synchronously, so chunks can
 * follow the start request without waiting for its reply.
 */
import type { HeraldSttResult, HeraldVoiceStreamPurpose } from '../../types/herald';
import type { HeraldTransport } from '../heraldTransport';
import { int16ToBase64 } from './pcm';

const START_TIMEOUT = 5000;
const END_TIMEOUT = 30000;

export class VoiceUplinkError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'VoiceUplinkError';
  }
}

let counter = 0;
export function newStreamId(prefix = 'v'): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export class VoiceUplink {
  readonly streamId: string;
  private seq = 0;
  private started: Promise<void>;
  private failed: VoiceUplinkError | null = null;
  private done = false;
  /** Samples sent so far. */
  samples = 0;

  constructor(private transport: HeraldTransport, readonly purpose: HeraldVoiceStreamPurpose) {
    this.streamId = newStreamId(purpose === 'wake' ? 'w' : 's');
    if (!transport.fire || !transport.isConnected()) {
      this.failed = new VoiceUplinkError('Not connected to the Herald host', 'unavailable');
      this.started = Promise.resolve();
      return;
    }
    this.started = transport
      .request('herald_voice_stream_start', { streamId: this.streamId, purpose, sampleRate: 16000 }, START_TIMEOUT)
      .then((res) => {
        if (!res.success) {
          const code = (res.payload as { code?: string } | undefined)?.code ?? 'failed';
          this.failed = new VoiceUplinkError(res.error || 'Voice input unavailable', code);
        }
      })
      .catch(() => {
        this.failed = new VoiceUplinkError('Voice input timed out', 'timeout');
      });
  }

  get error(): VoiceUplinkError | null {
    return this.failed;
  }

  push(pcm: Int16Array): void {
    if (this.done || this.failed || pcm.length === 0) return;
    this.samples += pcm.length;
    this.transport.fire!('herald_voice_audio', { streamId: this.streamId, seq: this.seq++, pcm: int16ToBase64(pcm) });
  }

  async finish(action: 'transcribe' | 'discard'): Promise<HeraldSttResult> {
    this.done = true;
    await this.started;
    if (this.failed) throw this.failed;
    let res;
    try {
      res = await this.transport.request('herald_voice_stream_end', { streamId: this.streamId, action }, END_TIMEOUT);
    } catch {
      throw new VoiceUplinkError('Transcription timed out', 'timeout');
    }
    if (!res.success) {
      const code = (res.payload as { code?: string } | undefined)?.code ?? 'failed';
      throw new VoiceUplinkError(res.error || 'Transcription failed', code);
    }
    return res.payload as HeraldSttResult;
  }

  /** Drop without waiting. */
  discard(): void {
    if (this.done) return;
    void this.finish('discard').catch(() => {});
  }
}
