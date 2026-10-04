/**
 * Stuck-detection settings, persisted in ~/.companion/stuck/settings.json
 * (override COMPANION_STUCK_STATE_DIR; a sandbox daemon has its own HOME).
 * Loaded once at start (tiny file), written atomically on change.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { STUCK_DEFAULTS, STUCK_SETTING_RANGES, StuckSettings } from './protocol';

export function stuckStateDir(): string {
  return process.env.COMPANION_STUCK_STATE_DIR || path.join(os.homedir(), '.companion', 'stuck');
}

/** Clamp a partial patch onto a base; unknown keys and wrong types are ignored. */
export function sanitizeSettings(
  raw: unknown,
  base: StuckSettings = STUCK_DEFAULTS
): StuckSettings {
  const out: StuckSettings = { ...base };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
  for (const [key, [min, max]] of Object.entries(STUCK_SETTING_RANGES) as Array<
    [keyof typeof STUCK_SETTING_RANGES, [number, number]]
  >) {
    const v = r[key];
    if (typeof v === 'number' && Number.isFinite(v))
      out[key] = Math.min(max, Math.max(min, Math.round(v)));
  }
  return out;
}

export class StuckSettingsStore {
  private settings: StuckSettings = { ...STUCK_DEFAULTS };
  private readonly file: string;

  constructor(dir: string = stuckStateDir()) {
    this.file = path.join(dir, 'settings.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      this.settings = sanitizeSettings(raw);
    } catch {
      // Missing or corrupt: defaults.
    }
  }

  get(): StuckSettings {
    return { ...this.settings };
  }

  /** Apply a partial patch; returns the new settings. */
  update(patch: unknown): StuckSettings {
    const next = sanitizeSettings(patch, this.settings);
    if (JSON.stringify(next) === JSON.stringify(this.settings)) return this.get();
    this.settings = next;
    this.save();
    return this.get();
  }

  /** Saves run one after another (the newest settings always land last). */
  private saving: Promise<void> = Promise.resolve();

  private save(): void {
    const data = JSON.stringify(this.settings, null, 2);
    const dir = path.dirname(this.file);
    const tmp = `${this.file}.${process.pid}.tmp`;
    this.saving = this.saving
      .then(() => fs.promises.mkdir(dir, { recursive: true, mode: 0o700 }))
      .then(() => fs.promises.writeFile(tmp, data, { mode: 0o600 }))
      .then(() => fs.promises.rename(tmp, this.file))
      .catch((err) =>
        console.error('Stuck: saving settings failed:', err instanceof Error ? err.message : err)
      );
  }

  /** Resolves when pending writes are done (tests). */
  flushed(): Promise<void> {
    return this.saving;
  }
}

/** "22:00".."08:00" style window (overnight allowed). */
export function inQuietHours(
  q: { enabled: boolean; start: string; end: string } | null | undefined,
  date: Date
): boolean {
  if (!q || !q.enabled) return false;
  const parse = (s: string) => {
    const [h, m] = String(s || '')
      .split(':')
      .map(Number);
    return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : NaN;
  };
  const start = parse(q.start);
  const end = parse(q.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  const cur = date.getHours() * 60 + date.getMinutes();
  return start > end ? cur >= start || cur < end : cur >= start && cur < end;
}
