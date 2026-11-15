/**
 * Recent project folders, kept on the daemon (`<config dir>/recent-dirs.json`)
 * so every device sees the same list and it survives app reinstalls / WebView
 * resets. Recorded when the app starts a session in a folder. Async I/O,
 * writes serialized and atomic (temp + rename); a missing or corrupt file
 * reads as empty.
 */
import * as fs from 'fs';
import * as path from 'path';
import { resolveConfigPath } from '../config';
import { PROJECT_DIRS_LIMITS, RecentProjectDir } from './protocol';

interface RecentsFile {
  version: 1;
  recents: RecentProjectDir[];
}

export function dirName(p: string): string {
  return p.split('/').filter(Boolean).pop() || p;
}

/** Normalize a folder path: absolute, no trailing slash. Null for unusable input. */
export function normalizeDir(p: unknown): string | null {
  if (typeof p !== 'string') return null;
  const t = p.trim();
  if (!t || t.length > 4096 || t.includes('\0') || !path.isAbsolute(t)) return null;
  return path.resolve(t);
}

function sanitize(list: unknown, max: number): RecentProjectDir[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: RecentProjectDir[] = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    const p = normalizeDir(r.path);
    if (!p || seen.has(p)) continue;
    const lastUsed = typeof r.lastUsed === 'number' && isFinite(r.lastUsed) ? r.lastUsed : 0;
    seen.add(p);
    out.push({ path: p, name: dirName(p), lastUsed });
  }
  out.sort((a, b) => b.lastUsed - a.lastUsed);
  return out.slice(0, max);
}

export class RecentDirsStore {
  private cache: RecentProjectDir[] | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly opts: { max?: number; now?: () => number } = {}
  ) {}

  private get max(): number {
    return this.opts.max ?? PROJECT_DIRS_LIMITS.maxRecents;
  }

  private async load(): Promise<RecentProjectDir[]> {
    if (this.cache) return this.cache;
    let list: RecentProjectDir[] = [];
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.file, 'utf-8')) as unknown;
      list = sanitize(
        Array.isArray(parsed) ? parsed : (parsed as { recents?: unknown } | null)?.recents,
        this.max
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`RecentDirs: ignoring unreadable ${this.file}: ${(err as Error).message}`);
      }
    }
    this.cache = list;
    return list;
  }

  private async save(list: RecentProjectDir[]): Promise<void> {
    const body: RecentsFile = { version: 1, recents: list };
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = path.join(
      path.dirname(this.file),
      `.${path.basename(this.file)}.${process.pid}.tmp`
    );
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
      await fs.promises.rename(tmp, this.file);
    } catch (err) {
      await fs.promises.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  /** Most recent first. */
  async list(): Promise<RecentProjectDir[]> {
    await this.chain.catch(() => undefined);
    return [...(await this.load())];
  }

  /** Move (or add) a folder to the top. Invalid paths are ignored. */
  record(dir: string): Promise<void> {
    const p = normalizeDir(dir);
    if (!p) return Promise.resolve();
    const run = this.chain
      .catch(() => undefined)
      .then(async () => {
        const now = (this.opts.now ?? Date.now)();
        const current = await this.load();
        const next = [
          { path: p, name: dirName(p), lastUsed: now },
          ...current.filter((e) => e.path !== p),
        ].slice(0, this.max);
        this.cache = next;
        await this.save(next);
      });
    this.chain = run;
    return run;
  }
}

let shared: RecentDirsStore | null = null;

/** The daemon-wide store, next to the config file (sandboxes have their own HOME). */
export function getRecentDirsStore(): RecentDirsStore {
  if (!shared) {
    shared = new RecentDirsStore(path.join(path.dirname(resolveConfigPath()), 'recent-dirs.json'));
  }
  return shared;
}
