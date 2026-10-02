/**
 * ReviewService: Code Review 2.0 on the daemon.
 *
 * Ledger (transcript) is the source of truth for turns + per-edit hunks; git
 * (through the bounded GitRunner) only for the net "by file" view, renames,
 * binary, unattributed changes and reverts. No subprocess per
 * conversation_update: watcher events only tail the JSONL.
 */

import * as fs from 'fs';
import * as path from 'path';
import { GitError, GitRunner } from './git-runner';
import { RepoInfo, RepoResolver } from './repo';
import { SessionLedger, LedgerEdit } from './ledger';
import { listSubagentFiles } from './sources';
import { parseUnifiedDiff, renderPatch } from './diff-parse';
import type { TmuxSession } from '../types';

export interface ReviewWatcherLike {
  getSessions(): TmuxSession[];
  getConversationChain(sessionId: string): string[];
}

export interface ReviewServiceDeps {
  watcher: ReviewWatcherLike;
  /** config.git */
  gitEnabled: () => boolean;
  runner?: GitRunner;
  now?: () => number;
}

const MAX_LEDGERS = 24;
const LEDGER_SCAN_BUDGET = 64 * 1024 * 1024;

export class ReviewServiceError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/** Legacy get_session_diff file entry (FileChange + optional diff). */
export interface CompatFileChange {
  path: string;
  action: 'write' | 'edit';
  timestamp: number;
  diff?: string;
}

export class ReviewService {
  readonly runner: GitRunner;
  readonly repos: RepoResolver;
  protected deps: ReviewServiceDeps;
  protected now: () => number;
  private ledgers = new Map<string, SessionLedger>();
  private locks = new Map<string, Promise<unknown>>();
  protected disposed = false;

  constructor(deps: ReviewServiceDeps) {
    this.deps = deps;
    this.now = deps.now || Date.now;
    this.runner = deps.runner || new GitRunner({ enabled: deps.gitEnabled });
    this.repos = new RepoResolver(this.runner, this.now);
  }

  // ------------------------------------------------------------------ ledger

  findSession(sessionId: string): TmuxSession | null {
    return this.deps.watcher.getSessions().find((s) => s.id === sessionId) || null;
  }

  /** Serialize per-session work (ledger updates must not interleave). */
  protected withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) || Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    const tail = next.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return next;
  }

  /** Up-to-date ledger for a session (null = unknown session). */
  async getLedger(sessionId: string): Promise<SessionLedger | null> {
    const session = this.findSession(sessionId);
    if (!session) return null;
    return this.withLock(`ledger:${sessionId}`, async () => {
      let chain = this.deps.watcher.getConversationChain(sessionId);
      if (chain.length === 0 && session.conversationPath) chain = [session.conversationPath];
      const projectPath = session.projectPath || '';
      let led = this.ledgers.get(sessionId);
      if (led && led.projectPath !== projectPath) led = undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!led) led = new SessionLedger(sessionId, projectPath);
        const subs = await listSubagentFiles(chain);
        led.setChain(chain, subs);
        if (!led.stale) await led.update(LEDGER_SCAN_BUDGET);
        if (!led.stale) break;
        led = undefined;
      }
      if (!led) return null;
      this.ledgers.delete(sessionId);
      this.ledgers.set(sessionId, led);
      while (this.ledgers.size > MAX_LEDGERS) {
        const oldest = this.ledgers.keys().next().value;
        if (oldest === undefined) break;
        this.ledgers.delete(oldest);
      }
      return led;
    });
  }

  /** Cached ledger without reading anything. */
  peekLedger(sessionId: string): SessionLedger | undefined {
    return this.ledgers.get(sessionId);
  }

  // ------------------------------------------------------------------ compat

  /**
   * get_session_diff (legacy clients): files the session's transcript touched,
   * each with its `git diff HEAD` hunk text. One bounded diff per repo (not one
   * shell per file); untracked files are kept (and get a patch from the ledger).
   */
  async compatSessionDiff(sessionId: string): Promise<CompatFileChange[]> {
    const led = await this.getLedger(sessionId);
    if (!led) return [];
    const byPath = new Map<string, CompatFileChange & { edits: LedgerEdit[] }>();
    for (const e of led.edits.values()) {
      if (e.pending || e.failed) continue;
      const action: 'write' | 'edit' = e.tool === 'Write' ? 'write' : 'edit';
      const cur = byPath.get(e.absPath);
      if (cur) {
        if (e.at > cur.timestamp) cur.timestamp = e.at;
        if (action === 'write') cur.action = 'write';
        cur.edits.push(e);
      } else {
        byPath.set(e.absPath, { path: e.absPath, action, timestamp: e.at, edits: [e] });
      }
    }
    const strip = (c: CompatFileChange & { edits: LedgerEdit[] }): CompatFileChange => ({
      path: c.path,
      action: c.action,
      timestamp: c.timestamp,
      ...(c.diff ? { diff: c.diff } : {}),
    });
    const all = Array.from(byPath.values());
    if (!this.deps.gitEnabled() || !led.projectPath) return all.map(strip);

    let repo: RepoInfo | null = null;
    try {
      repo = await this.repos.resolve(led.projectPath);
    } catch {
      repo = null;
    }
    if (!repo) return all.map(strip);
    const root = repo.root;

    let diffText = '';
    try {
      const args = ['diff', 'HEAD', '-M', '--src-prefix=a/', '--dst-prefix=b/'];
      let r = await this.runner.run({ cwd: root, repoKey: root, kind: 'diff', args });
      if (r.code !== 0) {
        r = await this.runner.run({
          cwd: root,
          repoKey: root,
          kind: 'diff',
          args: ['diff', '-M', '--src-prefix=a/', '--dst-prefix=b/'],
        });
      }
      diffText = r.code === 0 ? r.stdout : '';
    } catch (err) {
      if (err instanceof GitError) return all.map(strip);
      throw err;
    }
    const rawByRel = new Map<string, string>();
    for (const f of parseUnifiedDiff(diffText)) {
      const rel = f.newPath ?? f.oldPath;
      if (rel) rawByRel.set(rel, f.raw);
    }

    const inRepo = all.filter((c) => !path.relative(root, c.path).startsWith('..'));
    const missing: string[] = [];
    for (const c of inRepo) {
      const rel = path.relative(root, c.path);
      const raw = rawByRel.get(rel);
      if (raw) c.diff = raw;
      else missing.push(rel);
    }
    // Not in the diff: new (untracked / added) files are not in HEAD.
    const notInHead = await this.notInHead(root, missing);
    const out: CompatFileChange[] = [];
    for (const c of inRepo) {
      const rel = path.relative(root, c.path);
      if (c.diff) {
        out.push(strip(c));
        continue;
      }
      if (!notInHead.has(rel)) continue; // unchanged vs HEAD (e.g. committed since)
      const exists = await fs.promises
        .stat(c.path)
        .then(() => true)
        .catch(() => false);
      if (!exists) continue;
      const hunks = c.edits.flatMap((e) => e.hunks);
      const create = c.edits.find((e) => e.kind === 'create' && e.hunks.length > 0);
      const patchHunks = create ? create.hunks : hunks;
      if (patchHunks.length) {
        c.diff = `diff --git a/${rel} b/${rel}\nnew file mode 100644\n${renderPatch(null, rel, patchHunks)}`;
      }
      out.push(strip(c));
    }
    return out;
  }

  /** Which repo-relative paths are absent from HEAD (one `cat-file --batch-check`). */
  protected async notInHead(root: string, rels: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (rels.length === 0) return out;
    try {
      const r = await this.runner.run({
        cwd: root,
        repoKey: root,
        kind: 'read',
        args: ['cat-file', '--batch-check'],
        stdin: rels.map((p) => `HEAD:${p}`).join('\n') + '\n',
      });
      const lines = r.stdout.split('\n');
      rels.forEach((rel, i) => {
        if (/ missing$/.test(lines[i] || '')) out.add(rel);
      });
    } catch {
      /* treat as unknown: keep none */
    }
    return out;
  }

  shutdown(): void {
    this.disposed = true;
  }
}
