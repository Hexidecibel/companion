/**
 * HTTP client for the local Herald voice service (bin/herald-voice). Every call
 * has a hard timeout; connection failures surface as VoiceUnavailableError so
 * callers can degrade (web falls back to Web Speech, voice input greys out).
 */

export class VoiceUnavailableError extends Error {
  constructor(message = 'Voice service unavailable') {
    super(message);
    this.name = 'VoiceUnavailableError';
  }
}

export class VoiceRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'VoiceRequestError';
  }
}

export interface VoiceHealth {
  ok: boolean;
  tts: {
    ready: boolean;
    voices?: Array<{ id: string; name: string; lang: string; gender: string }>;
    defaultVoice?: string;
    sampleRate?: number;
  };
  stt: { ready: boolean; model?: string };
  wake: { ready: boolean; models?: string[]; threshold?: number };
}

export interface TtsAudio {
  pcm: Buffer;
  sampleRate: number;
  synthMs: number;
  audioMs: number;
}

export interface SttText {
  text: string;
  audioMs: number;
  sttMs: number;
}

export interface WakeScore {
  detected: boolean;
  score: number;
  model: string;
}

export const VOICE_TIMEOUTS = {
  health: 1500,
  tts: 20_000,
  stt: 20_000,
  wake: 3000,
};

type FetchLike = typeof fetch;

function isAbort(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

export class VoiceServiceClient {
  constructor(
    readonly baseUrl: string,
    private fetchImpl: FetchLike = fetch,
    private timeouts = VOICE_TIMEOUTS
  ) {}

  private async request(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onOuterAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      const res = await this.fetchImpl(this.baseUrl + path, { ...init, signal: ctrl.signal });
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 200);
        if (res.status === 503) throw new VoiceUnavailableError(body || 'Voice engine not ready');
        throw new VoiceRequestError(body || `HTTP ${res.status}`, res.status);
      }
      return res;
    } catch (err) {
      if (err instanceof VoiceUnavailableError || err instanceof VoiceRequestError) throw err;
      if (signal?.aborted) throw new VoiceRequestError('cancelled', 499);
      if (isAbort(err)) throw new VoiceUnavailableError('Voice service timed out');
      throw new VoiceUnavailableError();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  async health(): Promise<VoiceHealth> {
    const res = await this.request('/health', { method: 'GET' }, this.timeouts.health);
    return (await res.json()) as VoiceHealth;
  }

  async tts(
    text: string,
    voice: string | null,
    speed: number,
    signal?: AbortSignal
  ): Promise<TtsAudio> {
    const res = await this.request(
      '/tts',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, voice: voice || '', speed }),
      },
      this.timeouts.tts,
      signal
    );
    const pcm = Buffer.from(await res.arrayBuffer());
    return {
      pcm,
      sampleRate: Number(res.headers.get('x-sample-rate')) || 24000,
      synthMs: Number(res.headers.get('x-synth-ms')) || 0,
      audioMs: Number(res.headers.get('x-audio-ms')) || 0,
    };
  }

  async stt(pcm: Buffer, signal?: AbortSignal): Promise<SttText> {
    const res = await this.request(
      '/stt',
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm },
      this.timeouts.stt,
      signal
    );
    return (await res.json()) as SttText;
  }

  async wake(streamId: string, pcm: Buffer): Promise<WakeScore> {
    const res = await this.request(
      `/wake/${encodeURIComponent(streamId)}`,
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm },
      this.timeouts.wake
    );
    return (await res.json()) as WakeScore;
  }

  async dropWake(streamId: string): Promise<void> {
    await this.request(
      `/wake/${encodeURIComponent(streamId)}`,
      { method: 'DELETE' },
      this.timeouts.wake
    ).catch(() => undefined);
  }
}
