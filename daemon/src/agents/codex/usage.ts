/**
 * Codex plan usage for the usage alerts. Codex has no local usage API, but
 * every `event_msg token_count` record in a rollout carries the account's
 * rate-limit windows (checked on 0.165):
 *
 *   rate_limits: { primary:   { used_percent, window_minutes: 300,   resets_at },
 *                  secondary: { used_percent, window_minutes: 10080, resets_at }, ... }
 *
 * So the newest rollout of a Codex home tells where that login stands. Read
 * with async fs only: the date dirs of today and yesterday, the newest file by
 * mtime, its last 256 KB. No subprocess, bounded, cached per home by mtime.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface CodexRateWindow {
  usedPercent: number;
  windowMinutes: number;
  /** Seconds since the epoch (as Codex writes it). */
  resetsAt: number;
}

export interface CodexRateLimits {
  primary: CodexRateWindow | null;
  secondary: CodexRateWindow | null;
  /** Record time (ms). */
  at: number;
}

const TAIL_BYTES = 256 * 1024;
const MAX_FILES_PER_DIR = 2000;

function windowOf(v: unknown): CodexRateWindow | null {
  if (!v || typeof v !== 'object') return null;
  const w = v as Record<string, unknown>;
  if (typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent)) return null;
  return {
    usedPercent: w.used_percent,
    windowMinutes: typeof w.window_minutes === 'number' ? w.window_minutes : 0,
    resetsAt: typeof w.resets_at === 'number' ? w.resets_at : 0,
  };
}

/** Rate limits of one rollout record, or null when it carries none. */
export function rateLimitsOfRecord(rec: unknown): CodexRateLimits | null {
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as { type?: unknown; timestamp?: unknown; payload?: Record<string, unknown> };
  if (r.type !== 'event_msg' || r.payload?.type !== 'token_count') return null;
  const rl = r.payload.rate_limits as Record<string, unknown> | undefined;
  if (!rl || typeof rl !== 'object') return null;
  const primary = windowOf(rl.primary);
  const secondary = windowOf(rl.secondary);
  if (!primary && !secondary) return null;
  const at = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
  return { primary, secondary, at: Number.isFinite(at) ? at : 0 };
}

/** The newest rate limits in a chunk of rollout text (last record wins). */
export function lastRateLimits(text: string): CodexRateLimits | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes('"token_count"') || !l.includes('rate_limits')) continue;
    try {
      const got = rateLimitsOfRecord(JSON.parse(l));
      if (got) return got;
    } catch {
      // a cut first line of the tail
    }
  }
  return null;
}

/** "5-hour" / "7-day" / "90-minute" for a window length. */
export function windowLabel(minutes: number): string {
  if (minutes > 0 && minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes > 0 && minutes % 60 === 0) return `${minutes / 60}-hour`;
  return minutes > 0 ? `${minutes}-minute` : 'usage';
}

const pad = (n: number) => String(n).padStart(2, '0');

async function newestRollout(codexHome: string, now: number): Promise<string | null> {
  let best: { file: string; mtime: number } | null = null;
  for (const ago of [0, 1]) {
    const d = new Date(now - ago * 86_400_000);
    const dir = path.join(
      codexHome,
      'sessions',
      String(d.getFullYear()),
      pad(d.getMonth() + 1),
      pad(d.getDate())
    );
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const n of names.slice(-MAX_FILES_PER_DIR)) {
      if (!n.startsWith('rollout-') || !n.endsWith('.jsonl')) continue;
      const file = path.join(dir, n);
      try {
        const st = await fs.promises.stat(file);
        if (!best || st.mtimeMs > best.mtime) best = { file, mtime: st.mtimeMs };
      } catch {
        // gone meanwhile
      }
    }
    if (best) break;
  }
  return best?.file ?? null;
}

const cache = new Map<string, { file: string; mtime: number; value: CodexRateLimits | null }>();

/** The newest rate limits a Codex home's rollouts report (null = none seen). */
export async function readCodexRateLimits(
  codexHome: string,
  now = Date.now()
): Promise<CodexRateLimits | null> {
  const file = await newestRollout(codexHome, now);
  if (!file) return null;
  let fh: fs.promises.FileHandle | null = null;
  try {
    const st = await fs.promises.stat(file);
    const hit = cache.get(codexHome);
    if (hit && hit.file === file && hit.mtime === st.mtimeMs) return hit.value;
    fh = await fs.promises.open(file, 'r');
    const len = Math.min(st.size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, st.size - len);
    // A fresh thread with no token_count yet keeps the last value seen.
    const value = lastRateLimits(buf.toString('utf8')) ?? hit?.value ?? null;
    cache.set(codexHome, { file, mtime: st.mtimeMs, value });
    return value;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}
