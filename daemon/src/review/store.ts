/**
 * Code Review persistence: per-session checkpoints, baselines and the LLM
 * polish cache in `~/.companion/review/state.json` (0600, debounced atomic
 * write, sanitized on load, corrupt file moved aside, sessions unseen for 30
 * days pruned). `COMPANION_REVIEW_STATE_DIR` overrides the directory.
 *
 * A checkpoint is keyed by the app session id (tmux name) AND its project
 * path: a reused tmux name in another project starts fresh.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ReviewCheckpoint } from './protocol';

export interface TreeRef {
  repoRoot: string;
  tree: string;
}

export interface StoredCheckpoint {
  projectPath: string;
  reviewedThrough: number;
  approvedTurnIds: string[];
  snapshots: TreeRef[];
  /** Working tree when the session was first seen with an empty ledger. */
  baseline?: TreeRef[];
  updatedAt: number;
  updatedBy: string | null;
  seenAt: number;
}

export interface PolishEntry {
  gist: string;
  at: number;
}

export interface PersistedReviewState {
  version: 1;
  sessions: Record<string, StoredCheckpoint>;
  polish: Record<string, PolishEntry>;
}

const PRUNE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_APPROVED = 500;
const MAX_TREES = 8;
const MAX_POLISH = 2000;
const MAX_SESSIONS = 500;

export function reviewStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.COMPANION_REVIEW_STATE_DIR || path.join(os.homedir(), '.companion', 'review');
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function sanitizeTrees(raw: unknown): TreeRef[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (t): t is TreeRef =>
        !!t &&
        typeof t === 'object' &&
        isStr((t as TreeRef).repoRoot) &&
        isStr((t as TreeRef).tree) &&
        /^[0-9a-f]{40,64}$/.test((t as TreeRef).tree)
    )
    .slice(0, MAX_TREES)
    .map((t) => ({ repoRoot: t.repoRoot, tree: t.tree }));
}

function sanitizeCheckpoint(raw: unknown): StoredCheckpoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (!isStr(c.projectPath) || !isNum(c.reviewedThrough) || c.reviewedThrough < 0) return null;
  const baseline = sanitizeTrees(c.baseline);
  return {
    projectPath: c.projectPath,
    reviewedThrough: c.reviewedThrough,
    approvedTurnIds: (Array.isArray(c.approvedTurnIds) ? c.approvedTurnIds : [])
      .filter(isStr)
      .slice(-MAX_APPROVED),
    snapshots: sanitizeTrees(c.snapshots),
    ...(baseline.length ? { baseline } : {}),
    updatedAt: isNum(c.updatedAt) ? c.updatedAt : 0,
    updatedBy: isStr(c.updatedBy) ? c.updatedBy.slice(0, 80) : null,
    seenAt: isNum(c.seenAt) ? c.seenAt : 0,
  };
}

export function sanitizeReviewState(raw: unknown, now: number): PersistedReviewState {
  if (!raw || typeof raw !== 'object') throw new Error('state is not an object');
  const r = raw as Record<string, unknown>;
  const sessions: Record<string, StoredCheckpoint> = {};
  const rs = r.sessions && typeof r.sessions === 'object' ? (r.sessions as Record<string, unknown>) : {};
  for (const [id, v] of Object.entries(rs).slice(0, MAX_SESSIONS)) {
    const c = sanitizeCheckpoint(v);
    if (!c) continue;
    if (now - Math.max(c.seenAt, c.updatedAt) > PRUNE_MS) continue;
    sessions[id] = c;
  }
  const polish: Record<string, PolishEntry> = {};
  const rp = r.polish && typeof r.polish === 'object' ? (r.polish as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(rp).slice(-MAX_POLISH)) {
    const e = v as Record<string, unknown>;
    if (e && isStr(e.gist) && isNum(e.at) && now - e.at < PRUNE_MS)
      polish[k] = { gist: e.gist.slice(0, 120), at: e.at };
  }
  return { version: 1, sessions, polish };
}

export function emptyCheckpoint(projectPath: string, now: number): StoredCheckpoint {
  return {
    projectPath,
    reviewedThrough: 0,
    approvedTurnIds: [],
    snapshots: [],
    updatedAt: 0,
    updatedBy: null,
    seenAt: now,
  };
}

export function toWire(c: StoredCheckpoint): ReviewCheckpoint {
  return {
    reviewedThrough: c.reviewedThrough,
    approvedTurnIds: c.approvedTurnIds.slice(),
    snapshots: c.snapshots.map((s) => ({ ...s })),
    updatedAt: c.updatedAt,
    updatedBy: c.updatedBy,
  };
}

/**
 * Fold approvals into reviewedThrough: walking turns oldest first, every turn
 * whose edits are all at or before reviewedThrough is skipped; a run of
 * approved turns right after it moves reviewedThrough to their last edit. Stops
 * at the first turn with unreviewed, unapproved edits. PURE (returns a copy).
 */
export function compactApprovals(
  c: StoredCheckpoint,
  turns: Array<{ id: string; lastEditAt: number | null; open?: boolean }>
): StoredCheckpoint {
  let through = c.reviewedThrough;
  const approved = new Set(c.approvedTurnIds);
  for (const t of turns) {
    // An edit still in flight: nothing at or after it can be folded yet.
    if (t.open) break;
    if (t.lastEditAt === null || t.lastEditAt <= through) {
      approved.delete(t.id);
      continue;
    }
    if (!approved.has(t.id)) break;
    through = t.lastEditAt;
    approved.delete(t.id);
  }
  // Approvals of turns that no longer exist in the ledger are kept (a rebuild may bring them back).
  return { ...c, reviewedThrough: through, approvedTurnIds: c.approvedTurnIds.filter((id) => approved.has(id)) };
}

export class ReviewStore {
  readonly filePath: string;
  private state: PersistedReviewState = { version: 1, sessions: {}, polish: {} };
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;
  private closed = false;
  loaded = false;

  constructor(
    dir: string = reviewStateDir(),
    private debounceMs = 1000,
    private now: () => number = Date.now
  ) {
    this.filePath = path.join(dir, 'state.json');
  }

  async load(): Promise<void> {
    let content: string;
    try {
      content = await fs.promises.readFile(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT')
        console.error('Review: failed to read state file, starting fresh:', err);
      this.loaded = true;
      return;
    }
    try {
      this.state = sanitizeReviewState(JSON.parse(content), this.now());
    } catch (err) {
      const aside = `${this.filePath}.corrupt-${this.now()}`;
      console.error(`Review: state file is corrupt (${String(err)}); moving it to ${aside}`);
      await fs.promises.rename(this.filePath, aside).catch(() => undefined);
      this.state = { version: 1, sessions: {}, polish: {} };
    }
    this.loaded = true;
  }

  /** Checkpoint for (session, project); a project mismatch resets it. */
  get(sessionId: string, projectPath: string): StoredCheckpoint {
    const c = this.state.sessions[sessionId];
    if (c && c.projectPath === projectPath) return c;
    return emptyCheckpoint(projectPath, this.now());
  }

  has(sessionId: string, projectPath: string): boolean {
    const c = this.state.sessions[sessionId];
    return !!c && c.projectPath === projectPath;
  }

  put(sessionId: string, c: StoredCheckpoint): void {
    this.state.sessions[sessionId] = { ...c, seenAt: this.now() };
    this.schedule();
  }

  /** Note the session is alive (prune clock) without other changes. */
  touch(sessionId: string, projectPath: string): void {
    const c = this.state.sessions[sessionId];
    if (!c || c.projectPath !== projectPath) return;
    if (this.now() - c.seenAt > 60 * 60 * 1000) {
      c.seenAt = this.now();
      this.schedule();
    }
  }

  getPolish(key: string): PolishEntry | undefined {
    return this.state.polish[key];
  }

  putPolish(key: string, gist: string): void {
    this.state.polish[key] = { gist, at: this.now() };
    const keys = Object.keys(this.state.polish);
    if (keys.length > MAX_POLISH) {
      for (const k of keys.slice(0, keys.length - MAX_POLISH)) delete this.state.polish[k];
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.closed) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return this.writing;
    this.dirty = false;
    const data = JSON.stringify(this.state);
    this.writing = this.writing
      .then(() => this.writeAtomic(data))
      .catch((err) => console.error('Review: failed to persist state:', err));
    return this.writing;
  }

  private async writeAtomic(data: string): Promise<void> {
    if (this.closed) return;
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.state.json.${process.pid}.${Date.now()}.tmp`);
    try {
      await fs.promises.writeFile(tmp, data, { encoding: 'utf-8', mode: 0o600 });
      await fs.promises.rename(tmp, this.filePath);
    } catch (err) {
      await fs.promises.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  /** Synchronous last-chance write for process shutdown (not a hot path). */
  flushSyncOnShutdown(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const wasDirty = this.dirty;
    this.closed = true;
    if (!wasDirty) return;
    this.dirty = false;
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = path.join(dir, `.state.json.${process.pid}.shutdown.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(this.state), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('Review: failed to persist state on shutdown:', err);
    }
  }
}
