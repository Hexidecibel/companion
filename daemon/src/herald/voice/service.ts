/**
 * Herald voice orchestration in the daemon: proxies TTS / STT / wake word to the
 * local voice service on behalf of authenticated WebSocket clients.
 *
 * Safety bounds (this code runs per audio chunk, so everything is capped):
 *   - health: cached, one probe in flight at a time
 *   - TTS: per-client FIFO, at most MAX_TTS_PENDING queued, one in flight per
 *     client; cancel aborts the in-flight fetch and rejects the queue
 *   - streams: per-client and global caps, byte cap per stream, idle sweep
 *   - wake: one request in flight per stream; chunks that arrive meanwhile are
 *     coalesced into the next request (bounded)
 * Audio lives only in memory and is dropped as soon as a stream ends.
 */

import type {
  HeraldActiveDevice,
  HeraldDeviceInfo,
  HeraldDevicesSnapshot,
  HeraldPresenceResult,
  HeraldSttResult,
  HeraldTtsRequest,
  HeraldTtsResult,
  HeraldVoiceEvent,
  HeraldVoiceStatus,
  HeraldVoiceStreamPurpose,
} from '../protocol';
import {
  VoiceRequestError,
  VoiceServiceClient,
  VoiceUnavailableError,
  type SttHints,
  type VoiceHealth,
} from './client';
import { stripWakePhrase } from './wake-phrase';
import { normalizeSpokenVersions } from './versions';
import type { SpokenEvidence, VoiceTranscriptEvidence } from '../voice-confirm';

/** Voice-confirm evidence is kept this long, at most this many transcripts per client. */
const EVIDENCE_TTL_MS = 60_000;
const EVIDENCE_MAX = 6;

export class VoiceError extends Error {
  constructor(
    message: string,
    readonly code: 'unavailable' | 'bad_request' | 'cancelled' | 'busy' | 'failed'
  ) {
    super(message);
    this.name = 'VoiceError';
  }
}

export const VOICE_LIMITS = {
  healthTtlMs: 5000,
  healthDownTtlMs: 3000,
  maxTtsChars: 600,
  maxTtsPending: 8,
  maxStreamsPerClient: 3,
  maxStreamsTotal: 12,
  /** 60 s of 16 kHz PCM16. */
  maxSttBytes: 60 * 16000 * 2,
  /** Wake streams give up after 20 s without the wake word. */
  maxWakeBytes: 20 * 16000 * 2,
  /** Max decoded bytes per chunk (2 s). */
  maxChunkBytes: 2 * 16000 * 2,
  /** Pending wake audio held while a wake request is in flight. */
  maxWakePendingBytes: 2 * 16000 * 2,
  streamIdleMs: 20_000,
  sweepIntervalMs: 5000,
  /** A pinned device that drops off keeps its pin this long for a reconnect. */
  pinGraceMs: 60_000,
  maxLabelChars: 60,
};

const DEVICE_KEY = /^[A-Za-z0-9_-]{8,64}$/;
const DEFAULT_LABEL = 'Unnamed device';

interface Presence {
  seenAt: number;
  interactedAt: number;
  label: string;
  deviceKey: string | null;
}

/** Friendly device label: printable, collapsed whitespace, capped. */
export function cleanDeviceLabel(raw: unknown, max = VOICE_LIMITS.maxLabelChars): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, max) : null;
}

const STREAM_ID = /^[A-Za-z0-9_-]{1,64}$/;

interface TtsJob {
  req: { text: string; voice: string | null; speed: number };
  resolve: (r: HeraldTtsResult) => void;
  reject: (e: Error) => void;
}

interface ClientTts {
  queue: TtsJob[];
  running: boolean;
  inflight: AbortController | null;
}

interface VoiceStream {
  id: string;
  clientId: string;
  purpose: HeraldVoiceStreamPurpose;
  startedAt: number;
  chunks: Buffer[];
  bytes: number;
  lastAt: number;
  woke: boolean;
  wakeBusy: boolean;
  wakePending: Buffer[];
  wakePendingBytes: number;
  closed: boolean;
}

export interface HeraldVoiceServiceOptions {
  client: VoiceServiceClient;
  /** Push a voice event to one client (no-op if gone). */
  sendEvent: (clientId: string, event: HeraldVoiceEvent) => void;
  /** Log transcripts (user data) only when set. */
  debugTranscripts?: boolean;
  /** Vocabulary hints for each transcription (current session names etc.). */
  sttHints?: () => SttHints | null;
  /** The active device or the device list changed (broadcast it). */
  onDevices?: (snapshot: HeraldDevicesSnapshot) => void;
  now?: () => number;
  limits?: Partial<typeof VOICE_LIMITS>;
}

export class HeraldVoiceService {
  private health: VoiceHealth | null = null;
  private healthAt = 0;
  private healthProbe: Promise<VoiceHealth | null> | null = null;
  private tts = new Map<string, ClientTts>();
  private streams = new Map<string, VoiceStream>();
  private handsFreeOwner: string | null = null;
  /** Clients that registered presence: when they were last seen / last used, and their name. */
  private presence = new Map<string, Presence>();
  /** The one active client: plays inbox tones, gets triggers (see electAnnouncer). */
  private announcer: string | null = null;
  /** A device claimed by hand. Unpinned: until another device is used. */
  private claim: { clientId: string; pinned: boolean } | null = null;
  /** A pinned device that disconnected: its pin comes back if it reconnects in time. */
  private orphanPin: { deviceKey: string; until: number } | null = null;
  private lastDevices = '';
  private transcripts = new Map<string, VoiceTranscriptEvidence[]>();
  private speech = new Map<string, { entries: SpokenEvidence[]; endAt: number }>();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private readonly limits: typeof VOICE_LIMITS;
  private readonly now: () => number;

  constructor(private opts: HeraldVoiceServiceOptions) {
    this.limits = { ...VOICE_LIMITS, ...(opts.limits || {}) };
    this.now = opts.now || Date.now;
  }

  start(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), this.limits.sweepIntervalMs);
    this.sweeper.unref?.();
    void this.probeHealth();
  }

  shutdown(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const id of [...this.tts.keys()]) this.cancelTts(id);
    for (const s of [...this.streams.values()]) this.closeStream(s);
  }

  // ---- status -------------------------------------------------------------

  /** Cached health; at most one probe in flight. */
  async probeHealth(force = false): Promise<VoiceHealth | null> {
    const age = this.now() - this.healthAt;
    const ttl = this.health ? this.limits.healthTtlMs : this.limits.healthDownTtlMs;
    if (!force && this.healthAt > 0 && age < ttl) return this.health;
    if (this.healthProbe) return this.healthProbe;
    this.healthProbe = (async () => {
      const wasUp = !!this.health;
      try {
        this.health = await this.opts.client.health();
      } catch {
        this.health = null;
      }
      this.healthAt = this.now();
      if (wasUp !== !!this.health) {
        console.log(
          `Herald voice: service ${this.health ? 'reachable' : 'unreachable'} at ${this.opts.client.baseUrl}`
        );
      }
      return this.health;
    })().finally(() => {
      this.healthProbe = null;
    });
    return this.healthProbe;
  }

  async status(clientId: string): Promise<HeraldVoiceStatus> {
    const h = await this.probeHealth();
    return {
      available: !!h,
      tts: {
        ready: !!h?.tts.ready,
        voices: h?.tts.voices ?? [],
        defaultVoice: h?.tts.defaultVoice ?? null,
        sampleRate: h?.tts.sampleRate ?? 24000,
      },
      stt: { ready: !!h?.stt.ready, model: h?.stt.model ?? null },
      wake: { ready: !!h?.wake.ready, models: h?.wake.models ?? [] },
      handsFreeOwner: this.handsFreeOwner === clientId,
    };
  }

  private markDown(err: unknown): void {
    if (err instanceof VoiceUnavailableError) {
      // Next status call re-probes instead of trusting a stale "up".
      this.healthAt = 0;
    }
  }

  // ---- TTS ----------------------------------------------------------------

  synthesize(clientId: string, raw: unknown): Promise<HeraldTtsResult> {
    const req = raw as Partial<HeraldTtsRequest> | undefined;
    const text = typeof req?.text === 'string' ? req.text.trim() : '';
    if (!text) return Promise.reject(new VoiceError('text is required', 'bad_request'));
    if (text.length > this.limits.maxTtsChars) {
      return Promise.reject(new VoiceError('text too long', 'bad_request'));
    }
    const voice =
      typeof req?.voice === 'string' && /^[a-z]{2}_[a-z]{1,20}$/.test(req.voice) ? req.voice : null;
    const speed =
      typeof req?.speed === 'number' && Number.isFinite(req.speed)
        ? Math.min(2, Math.max(0.5, req.speed))
        : 1;
    if (
      this.health === null &&
      this.healthAt > 0 &&
      this.now() - this.healthAt < this.limits.healthDownTtlMs
    ) {
      return Promise.reject(new VoiceError('Voice service unavailable', 'unavailable'));
    }

    let ct = this.tts.get(clientId);
    if (!ct) {
      ct = { queue: [], running: false, inflight: null };
      this.tts.set(clientId, ct);
    }
    if (ct.queue.length >= this.limits.maxTtsPending) {
      return Promise.reject(new VoiceError('Too many pending sentences', 'busy'));
    }
    return new Promise<HeraldTtsResult>((resolve, reject) => {
      ct!.queue.push({ req: { text, voice, speed }, resolve, reject });
      void this.pumpTts(clientId, ct!);
    });
  }

  private async pumpTts(clientId: string, ct: ClientTts): Promise<void> {
    if (ct.running) return;
    ct.running = true;
    try {
      while (ct.queue.length > 0) {
        const job = ct.queue.shift()!;
        const ctrl = new AbortController();
        ct.inflight = ctrl;
        try {
          const a = await this.opts.client.tts(
            job.req.text,
            job.req.voice,
            job.req.speed,
            ctrl.signal
          );
          this.recordSpeech(clientId, job.req.text, a.audioMs);
          job.resolve({
            audio: a.pcm.toString('base64'),
            sampleRate: a.sampleRate,
            audioMs: a.audioMs,
            synthMs: a.synthMs,
          });
        } catch (err) {
          this.markDown(err);
          job.reject(toVoiceError(err));
        } finally {
          ct.inflight = null;
        }
      }
    } finally {
      ct.running = false;
      if (ct.queue.length === 0 && this.tts.get(clientId) === ct) this.tts.delete(clientId);
    }
  }

  /** Barge-in: drop this client's queued and in-flight synthesis. */
  cancelTts(clientId: string): number {
    this.speechStopped(clientId);
    const ct = this.tts.get(clientId);
    if (!ct) return 0;
    const dropped = ct.queue.splice(0);
    for (const job of dropped) job.reject(new VoiceError('cancelled', 'cancelled'));
    const hadInflight = !!ct.inflight;
    ct.inflight?.abort();
    return dropped.length + (hadInflight ? 1 : 0);
  }

  // ---- streams ------------------------------------------------------------

  startStream(clientId: string, raw: unknown): { ok: true } {
    const p = (raw || {}) as { streamId?: unknown; purpose?: unknown; sampleRate?: unknown };
    const id = typeof p.streamId === 'string' ? p.streamId : '';
    if (!STREAM_ID.test(id)) throw new VoiceError('bad streamId', 'bad_request');
    if (p.purpose !== 'stt' && p.purpose !== 'wake')
      throw new VoiceError('bad purpose', 'bad_request');
    if (p.sampleRate !== 16000) throw new VoiceError('sampleRate must be 16000', 'bad_request');
    const existing = this.streams.get(id);
    if (existing) {
      if (existing.clientId !== clientId) throw new VoiceError('streamId in use', 'bad_request');
      this.closeStream(existing);
    }
    let mine = 0;
    for (const s of this.streams.values()) if (s.clientId === clientId) mine++;
    if (
      mine >= this.limits.maxStreamsPerClient ||
      this.streams.size >= this.limits.maxStreamsTotal
    ) {
      throw new VoiceError('Too many open voice streams', 'busy');
    }
    this.streams.set(id, {
      id,
      clientId,
      purpose: p.purpose,
      startedAt: this.now(),
      chunks: [],
      bytes: 0,
      lastAt: this.now(),
      woke: false,
      wakeBusy: false,
      wakePending: [],
      wakePendingBytes: 0,
      closed: false,
    });
    return { ok: true };
  }

  /** Fire-and-forget audio chunk. Problems are reported as stream_error events. */
  pushAudio(clientId: string, raw: unknown): void {
    const p = (raw || {}) as { streamId?: unknown; pcm?: unknown };
    const s = typeof p.streamId === 'string' ? this.streams.get(p.streamId) : undefined;
    if (!s || s.clientId !== clientId || s.closed) return;
    if (typeof p.pcm !== 'string') return;
    // base64 -> bytes is 3/4; reject oversize chunks before decoding.
    if (p.pcm.length > Math.ceil((this.limits.maxChunkBytes * 4) / 3) + 4) {
      this.failStream(s, 'audio chunk too large');
      return;
    }
    const buf = Buffer.from(p.pcm, 'base64');
    if (buf.length % 2 !== 0) {
      this.failStream(s, 'audio chunk must be PCM16');
      return;
    }
    const cap =
      s.purpose === 'wake' && !s.woke ? this.limits.maxWakeBytes : this.limits.maxSttBytes;
    if (s.bytes + buf.length > cap) {
      this.failStream(
        s,
        s.purpose === 'wake' && !s.woke ? 'no wake word heard' : 'utterance too long'
      );
      return;
    }
    s.chunks.push(buf);
    s.bytes += buf.length;
    s.lastAt = this.now();
    if (s.purpose === 'wake' && !s.woke) this.feedWake(s, buf);
  }

  private feedWake(s: VoiceStream, buf: Buffer): void {
    if (s.wakeBusy) {
      // Coalesce while a request is in flight; keep only the newest audio.
      s.wakePending.push(buf);
      s.wakePendingBytes += buf.length;
      while (s.wakePendingBytes > this.limits.maxWakePendingBytes && s.wakePending.length > 1) {
        s.wakePendingBytes -= s.wakePending.shift()!.length;
      }
      return;
    }
    s.wakeBusy = true;
    this.opts.client
      .wake(s.id, buf)
      .then((r) => {
        if (s.closed || s.woke) return;
        if (r.detected) {
          s.woke = true;
          s.wakePending = [];
          s.wakePendingBytes = 0;
          this.opts.sendEvent(s.clientId, {
            kind: 'wake',
            streamId: s.id,
            score: r.score,
            model: r.model,
          });
        }
      })
      .catch((err) => {
        this.markDown(err);
        if (!s.closed) this.failStream(s, 'wake word check failed');
      })
      .finally(() => {
        s.wakeBusy = false;
        if (s.closed || s.woke || s.wakePending.length === 0) return;
        const next = Buffer.concat(s.wakePending);
        s.wakePending = [];
        s.wakePendingBytes = 0;
        this.feedWake(s, next);
      });
  }

  async endStream(clientId: string, raw: unknown): Promise<HeraldSttResult> {
    const p = (raw || {}) as { streamId?: unknown; action?: unknown };
    const s = typeof p.streamId === 'string' ? this.streams.get(p.streamId) : undefined;
    if (!s || s.clientId !== clientId) throw new VoiceError('unknown stream', 'bad_request');
    const audio = Buffer.concat(s.chunks);
    const woke = s.woke;
    const purpose = s.purpose;
    this.closeStream(s);
    const audioMs = Math.round(audio.length / 32);
    if (p.action !== 'transcribe' || (purpose === 'wake' && !woke)) {
      return { text: '', audioMs, sttMs: 0, woke };
    }
    try {
      let hints: SttHints | null = null;
      try {
        hints = this.opts.sttHints?.() ?? null;
      } catch {
        hints = null; // hints are an accuracy aid, never a reason to fail
      }
      const r = await this.opts.client.stt(audio, undefined, hints);
      const heard = purpose === 'wake' ? stripWakePhrase(r.text) : r.text.trim();
      // "two or seven" -> "2.0.7" when that version is in recent session text.
      const text = normalizeSpokenVersions(heard, hints?.versions ?? []);
      const endedAt = this.now();
      this.recordTranscript(clientId, {
        streamId: s.id,
        text,
        // Earliest audio it can hold: pre-roll can predate the stream start.
        captureStartAt: Math.min(s.startedAt, endedAt - audioMs),
        endedAt,
        consumed: false,
      });
      if (this.opts.debugTranscripts) {
        console.log(
          `Herald voice: stt ${audioMs}ms audio -> ${r.sttMs}ms: ${JSON.stringify(text)}`
        );
      }
      return { text, audioMs, sttMs: r.sttMs, woke };
    } catch (err) {
      this.markDown(err);
      throw toVoiceError(err);
    }
  }

  private failStream(s: VoiceStream, error: string): void {
    this.closeStream(s);
    this.opts.sendEvent(s.clientId, { kind: 'stream_error', streamId: s.id, error });
  }

  private closeStream(s: VoiceStream): void {
    if (s.closed) return;
    s.closed = true;
    s.chunks = [];
    s.wakePending = [];
    this.streams.delete(s.id);
    if (s.purpose === 'wake') void this.opts.client.dropWake(s.id);
  }

  // ---- voice-confirm evidence --------------------------------------------
  // What this client's mic was transcribed as (by the daemon itself) and what
  // Herald said to it, with estimated playback times. Text only, in memory,
  // short-lived; used to verify a spoken "confirm <keyword>".

  private recordTranscript(clientId: string, rec: VoiceTranscriptEvidence): void {
    const list = (this.transcripts.get(clientId) || []).filter(
      (t) => rec.endedAt - t.endedAt < EVIDENCE_TTL_MS
    );
    list.push(rec);
    this.transcripts.set(clientId, list.slice(-EVIDENCE_MAX));
  }

  /**
   * Synthesized audio is played in order: this sentence starts when the previous
   * one ends (or now) and lasts its audio length. An estimate of when the user
   * actually HEARS it, erring late.
   */
  private recordSpeech(clientId: string, text: string, audioMs: number): void {
    const now = this.now();
    const prev = this.speech.get(clientId);
    const entries = (prev?.entries || []).filter((e) => now - e.endAt < EVIDENCE_TTL_MS);
    const startAt = Math.max(now, prev?.endAt ?? 0);
    const endAt = startAt + Math.max(0, audioMs);
    entries.push({ text, startAt, endAt });
    this.speech.set(clientId, { entries: entries.slice(-EVIDENCE_MAX * 4), endAt });
  }

  /** Playback was cut (barge-in / stop): nothing more is heard after now. */
  private speechStopped(clientId: string): void {
    const sp = this.speech.get(clientId);
    if (!sp) return;
    const now = this.now();
    if (sp.endAt > now) sp.endAt = now;
    for (const e of sp.entries) if (e.endAt > now) e.endAt = Math.max(e.startAt, now);
    sp.entries = sp.entries.filter((e) => e.startAt <= now);
  }

  /** Transcript (by stream id, else the newest) + Herald's recent speech for one client. */
  voiceEvidence(
    clientId: string,
    streamId?: string | null
  ): {
    transcript: VoiceTranscriptEvidence | null;
    spoken: SpokenEvidence[];
    speechEndAt: number;
  } {
    const list = this.transcripts.get(clientId) || [];
    const transcript =
      (streamId ? list.find((t) => t.streamId === streamId) : list[list.length - 1]) || null;
    const sp = this.speech.get(clientId);
    return {
      transcript: transcript ? { ...transcript } : null,
      spoken: (sp?.entries || []).map((e) => ({ ...e })),
      speechEndAt: sp?.endAt ?? 0,
    };
  }

  /** A transcript confirms at most one thing. */
  consumeTranscript(clientId: string, streamId: string): void {
    const t = (this.transcripts.get(clientId) || []).find((x) => x.streamId === streamId);
    if (t) t.consumed = true;
  }

  sweep(): void {
    const now = this.now();
    for (const s of [...this.streams.values()]) {
      if (now - s.lastAt > this.limits.streamIdleMs) this.failStream(s, 'stream idle');
    }
  }

  /** Test/diagnostic: open stream count. */
  get openStreams(): number {
    return this.streams.size;
  }

  // ---- active device arbitration ------------------------------------------

  /** Only one client may run hands-free (always listening) at a time. */
  setHandsFree(clientId: string, on: boolean): { owner: boolean } {
    if (on) {
      const prev = this.handsFreeOwner;
      this.handsFreeOwner = clientId;
      if (prev && prev !== clientId) this.opts.sendEvent(prev, { kind: 'handsfree_revoked' });
      this.electAnnouncer();
      return { owner: true };
    }
    if (this.handsFreeOwner === clientId) this.handsFreeOwner = null;
    this.electAnnouncer();
    return { owner: false };
  }

  /**
   * A client reports that it is here (and whether the user just used it), with
   * its friendly label. Using a device takes over from an UNPINNED claim held
   * elsewhere; a pinned claim is untouched.
   */
  setPresence(clientId: string, raw: unknown): HeraldPresenceResult {
    const p0 = (raw || {}) as { interacted?: unknown; label?: unknown; deviceKey?: unknown };
    const interacted = p0.interacted === true;
    const now = this.now();
    const prev = this.presence.get(clientId);
    const p: Presence = prev ?? {
      seenAt: 0,
      interactedAt: 0,
      label: DEFAULT_LABEL,
      deviceKey: null,
    };
    p.seenAt = now;
    if (interacted) p.interactedAt = now;
    const label = cleanDeviceLabel(p0.label, this.limits.maxLabelChars);
    if (label) p.label = label;
    if (typeof p0.deviceKey === 'string' && DEVICE_KEY.test(p0.deviceKey))
      p.deviceKey = p0.deviceKey;
    this.presence.set(clientId, p);

    // The pinned device came back after a dropped connection: restore its pin.
    const orphan = this.orphanPin;
    if (orphan && p.deviceKey === orphan.deviceKey) {
      this.orphanPin = null;
      if (now < orphan.until && !this.claim) this.claim = { clientId, pinned: true };
    }
    if (interacted && this.claim && !this.claim.pinned && this.claim.clientId !== clientId) {
      this.claim = null;
    }
    this.electAnnouncer(clientId);
    return { announcer: this.announcer === clientId, clientId };
  }

  /**
   * Make a device active by hand (`deviceId` absent: the requester). Pinned, it
   * stays active until another device claims or it disconnects.
   */
  claimDevice(requesterId: string, raw: unknown): HeraldDevicesSnapshot {
    const p = (raw || {}) as { pin?: unknown; deviceId?: unknown };
    const target = typeof p.deviceId === 'string' && p.deviceId ? p.deviceId : requesterId;
    if (!this.presence.has(target)) {
      throw new VoiceError(
        target === requesterId ? 'Report presence first' : 'No such device',
        'bad_request'
      );
    }
    this.setClaim(target, p.pin === true);
    return this.devicesSnapshot();
  }

  /** Claim by label (case-insensitive) or id, for remote triggers. Null: no such device. */
  claimByName(nameOrId: string, pin: boolean): string | null {
    const target = this.findDevice(nameOrId);
    if (!target) return null;
    this.setClaim(target, pin);
    return target;
  }

  /** A device by exact id, else by label (case-insensitive; the most recently seen wins). */
  findDevice(nameOrId: string): string | null {
    if (this.presence.has(nameOrId)) return nameOrId;
    const want = nameOrId.trim().toLowerCase();
    if (!want) return null;
    let best: { id: string; seenAt: number } | null = null;
    for (const [id, p] of this.presence) {
      if (p.label.toLowerCase() === want && (!best || p.seenAt > best.seenAt)) {
        best = { id, seenAt: p.seenAt };
      }
    }
    return best?.id ?? null;
  }

  private setClaim(clientId: string, pinned: boolean): void {
    this.claim = { clientId, pinned };
    this.orphanPin = null;
    this.electAnnouncer();
    // A pin flip on the same device changes no announcer, but is news.
    this.notifyDevices();
  }

  get announcerClient(): string | null {
    return this.announcer;
  }

  devicesSnapshot(): HeraldDevicesSnapshot {
    const devices: HeraldDeviceInfo[] = [...this.presence.entries()]
      .map(([id, p]) => ({ id, label: p.label, handsFree: this.handsFreeOwner === id }))
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    const id = this.announcer;
    const p = id ? this.presence.get(id) : undefined;
    let activeDevice: HeraldActiveDevice | null = null;
    if (id && p) {
      const claimed = this.claim?.clientId === id;
      activeDevice = {
        id,
        label: p.label,
        pinned: claimed && !!this.claim?.pinned,
        reason: claimed ? 'claimed' : this.handsFreeOwner === id ? 'handsfree' : 'recent',
      };
    }
    return { activeDevice, devices };
  }

  /**
   * Elect the active device: a claimed one; else the hands-free device; else
   * the one the user touched most recently; else the one seen most recently.
   * Announcer changes are pushed to the two clients involved (`quiet`: the
   * requester gets its answer in the reply instead); structural changes to the
   * device list are broadcast via onDevices.
   */
  private electAnnouncer(quiet?: string): void {
    let next: string | null = null;
    if (this.claim && !this.presence.has(this.claim.clientId)) this.claim = null;
    if (this.claim) {
      next = this.claim.clientId;
    } else if (this.handsFreeOwner && this.presence.has(this.handsFreeOwner)) {
      next = this.handsFreeOwner;
    } else {
      let best: { id: string; interactedAt: number; seenAt: number } | null = null;
      for (const [id, p] of this.presence) {
        if (
          !best ||
          p.interactedAt > best.interactedAt ||
          (p.interactedAt === best.interactedAt && p.seenAt > best.seenAt)
        ) {
          best = { id, interactedAt: p.interactedAt, seenAt: p.seenAt };
        }
      }
      next = best?.id ?? null;
    }
    const prev = this.announcer;
    if (next !== prev) {
      this.announcer = next;
      if (prev && prev !== quiet) this.opts.sendEvent(prev, { kind: 'announcer', owner: false });
      if (next && next !== quiet) this.opts.sendEvent(next, { kind: 'announcer', owner: true });
    }
    this.notifyDevices();
  }

  private notifyDevices(): void {
    const snap = this.devicesSnapshot();
    const key = JSON.stringify(snap);
    if (key === this.lastDevices) return;
    this.lastDevices = key;
    try {
      this.opts.onDevices?.(snap);
    } catch (err) {
      console.error('Herald voice: device broadcast failed:', err);
    }
  }

  get handsFreeClient(): string | null {
    return this.handsFreeOwner;
  }

  /** Client disconnected: drop everything it owned. A pin waits briefly for a reconnect. */
  clientGone(clientId: string): void {
    this.cancelTts(clientId);
    this.transcripts.delete(clientId);
    this.speech.delete(clientId);
    for (const s of [...this.streams.values()]) if (s.clientId === clientId) this.closeStream(s);
    if (this.handsFreeOwner === clientId) this.handsFreeOwner = null;
    if (this.claim?.clientId === clientId) {
      const key = this.presence.get(clientId)?.deviceKey;
      if (this.claim.pinned && key) {
        this.orphanPin = { deviceKey: key, until: this.now() + this.limits.pinGraceMs };
      }
      this.claim = null;
    }
    this.presence.delete(clientId);
    if (this.announcer === clientId) this.announcer = null;
    this.electAnnouncer();
  }
}

function toVoiceError(err: unknown): VoiceError {
  if (err instanceof VoiceError) return err;
  if (err instanceof VoiceUnavailableError) return new VoiceError(err.message, 'unavailable');
  if (err instanceof VoiceRequestError) {
    if (err.status === 499) return new VoiceError('cancelled', 'cancelled');
    if (err.status === 413 || err.status === 400) return new VoiceError(err.message, 'bad_request');
    return new VoiceError(err.message, 'failed');
  }
  return new VoiceError('Voice request failed', 'failed');
}
