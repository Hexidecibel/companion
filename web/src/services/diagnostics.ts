/**
 * Herald diagnostics: a small, non-React store the voice pipeline writes to
 * from its hot paths (cheap field updates, no allocations per audio frame
 * beyond a number), plus named providers that hooks register to expose live
 * state they own (hands-free, devices, fleet speaking, shortcuts). The
 * Diagnostics view (Help > Diagnostics, or say "diagnostics") polls
 * `collectDiagnostics()` a few times a second; "Copy diagnostics" copies the
 * same snapshot as JSON.
 *
 * Never put secrets or user content here: no tokens, no transcripts, no audio.
 * `redactSnapshot` is a last line of defence for the copied JSON.
 */

export type AssetStatus = 'idle' | 'loading' | 'ok' | 'error';

export interface VoiceDiag {
  vad: {
    running: boolean;
    speech: boolean;
    lastSpeechStartAt: number | null;
    lastSpeechEndAt: number | null;
    misfires: number;
  };
  /** RMS level of the mic the VAD hears, 0..1 (only while the VAD runs). */
  level: number;
  levelAt: number | null;
  wake: {
    streaming: boolean;
    streamId: string | null;
    openedAt: number | null;
    streams: number;
    detections: number;
    lastScore: number | null;
    lastScoreAt: number | null;
    /** How the last wake stream ended: transcribed / discarded (no wake word) / quiet (another device spoke) / dropped (hands-free off). */
    lastOutcome: string | null;
    lastOutcomeAt: number | null;
  };
  assets: {
    vad: AssetStatus;
    vadError: string | null;
    vadBase: string | null;
    worklet: AssetStatus;
    workletError: string | null;
  };
  handsFree: {
    lastStandDown: { reason: string; at: number } | null;
  };
  speech: {
    /** The `speakOn` of the last Herald line this device saw, and whether it was this device. */
    lastSpeakOn: string | null;
    lastSpeakOnSelf: boolean | null;
    lastSpeakOnAt: number | null;
  };
}

function fresh(): VoiceDiag {
  return {
    vad: { running: false, speech: false, lastSpeechStartAt: null, lastSpeechEndAt: null, misfires: 0 },
    level: 0,
    levelAt: null,
    wake: {
      streaming: false, streamId: null, openedAt: null, streams: 0, detections: 0,
      lastScore: null, lastScoreAt: null, lastOutcome: null, lastOutcomeAt: null,
    },
    assets: { vad: 'idle', vadError: null, vadBase: null, worklet: 'idle', workletError: null },
    handsFree: { lastStandDown: null },
    speech: { lastSpeakOn: null, lastSpeakOnSelf: null, lastSpeakOnAt: null },
  };
}

/** Mutable on purpose: written from audio callbacks, read by the polling view. */
export const voiceDiag: VoiceDiag = fresh();

const now = () => Date.now();

export const diag = {
  vadRunning(running: boolean): void {
    voiceDiag.vad.running = running;
    if (!running) voiceDiag.vad.speech = false;
  },
  speechStart(): void {
    voiceDiag.vad.speech = true;
    voiceDiag.vad.lastSpeechStartAt = now();
  },
  speechEnd(misfire = false): void {
    voiceDiag.vad.speech = false;
    voiceDiag.vad.lastSpeechEndAt = now();
    if (misfire) voiceDiag.vad.misfires++;
  },
  level(rms: number): void {
    voiceDiag.level = rms;
    voiceDiag.levelAt = now();
  },
  wakeOpened(streamId: string): void {
    const w = voiceDiag.wake;
    w.streaming = true;
    w.streamId = streamId;
    w.openedAt = now();
    w.streams++;
  },
  wakeDetected(score: number): void {
    const w = voiceDiag.wake;
    w.detections++;
    w.lastScore = score;
    w.lastScoreAt = now();
  },
  wakeClosed(outcome: string): void {
    const w = voiceDiag.wake;
    w.streaming = false;
    w.streamId = null;
    w.lastOutcome = outcome;
    w.lastOutcomeAt = now();
  },
  asset(kind: 'vad' | 'worklet', status: AssetStatus, error?: string | null, base?: string): void {
    const a = voiceDiag.assets;
    if (kind === 'vad') {
      a.vad = status;
      a.vadError = error ?? null;
      if (base) a.vadBase = base;
    } else {
      a.worklet = status;
      a.workletError = error ?? null;
    }
  },
  standDown(reason: string): void {
    voiceDiag.handsFree.lastStandDown = { reason, at: now() };
  },
  speakOn(speakOn: string | null | undefined, self: boolean): void {
    voiceDiag.speech.lastSpeakOn = speakOn ?? null;
    voiceDiag.speech.lastSpeakOnSelf = self;
    voiceDiag.speech.lastSpeakOnAt = now();
  },
  /** Tests only. */
  reset(): void {
    Object.assign(voiceDiag, fresh());
  },
};

type Provider = () => Record<string, unknown> | null;
const providers = new Map<string, Provider>();

/** Expose live state under `name` in every snapshot (returns an unregister function). */
export function registerDiagnostics(name: string, fn: Provider): () => void {
  providers.set(name, fn);
  return () => {
    if (providers.get(name) === fn) providers.delete(name);
  };
}

export interface DiagnosticsSnapshot {
  at: string;
  app: { version: string; platform: string; userAgent: string; visibility: string; focused: boolean };
  voice: VoiceDiag;
  [name: string]: unknown;
}

export function collectDiagnostics(extra: { version?: string; platform?: string } = {}): DiagnosticsSnapshot {
  const snap: DiagnosticsSnapshot = {
    at: new Date().toISOString(),
    app: {
      version: extra.version ?? '',
      platform: extra.platform ?? '',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      visibility: typeof document !== 'undefined' ? document.visibilityState : 'unknown',
      focused: typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : false,
    },
    voice: JSON.parse(JSON.stringify(voiceDiag)) as VoiceDiag,
  };
  for (const [name, fn] of providers) {
    try {
      const v = fn();
      if (v) snap[name] = v;
    } catch (err) {
      snap[name] = { error: (err as Error)?.message ?? String(err) };
    }
  }
  return snap;
}

const SECRET_KEY = /token|secret|password|authorization|cookie|apikey|api_key|pcm|transcript/i;
const SECRET_VALUE = /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|[A-Fa-f0-9]{32,}|[A-Za-z0-9_-]{40,})/g;

/** JSON-safe copy with anything that looks like a credential removed. */
export function redactSnapshot(v: unknown, depth = 0): unknown {
  if (depth > 8) return '[deep]';
  if (typeof v === 'string') return v.replace(SECRET_VALUE, '[redacted]');
  if (Array.isArray(v)) return v.map((x) => redactSnapshot(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redactSnapshot(x, depth + 1);
    }
    return out;
  }
  return v;
}

/** The snapshot as pretty JSON, redacted (what "Copy diagnostics" copies). */
export function diagnosticsJson(snapshot: DiagnosticsSnapshot): string {
  return JSON.stringify(redactSnapshot(snapshot), null, 2);
}
