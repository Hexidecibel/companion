/**
 * Repo resolution for Code Review: one `git rev-parse` per directory, cached
 * 60 s with in-flight dedupe (through GitRunner). Worktree-correct: the index
 * path comes from `--git-path index`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { GitError, GitRunner } from './git-runner';

export interface RepoInfo {
  root: string;
  gitDir: string;
  commonDir: string;
  indexPath: string;
  worktree: boolean;
  branch: string | null;
  head: string | null;
}

const TTL_MS = 60_000;
const MAX_CACHE = 512;

async function existingDir(dir: string): Promise<string | null> {
  let cur = path.resolve(dir);
  for (let i = 0; i < 64; i++) {
    try {
      const st = await fs.promises.stat(cur);
      if (st.isDirectory()) return cur;
    } catch {
      /* walk up */
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

export class RepoResolver {
  private cache = new Map<string, { at: number; info: RepoInfo | null }>();
  private inflight = new Map<string, Promise<RepoInfo | null>>();
  constructor(
    private runner: GitRunner,
    private now: () => number = Date.now
  ) {}

  /** Cached result without touching git (null = unknown or not a repo). */
  peek(dir: string): RepoInfo | null | undefined {
    const hit = this.cache.get(path.resolve(dir));
    return hit ? hit.info : undefined;
  }

  /** Repo containing `dir` (null = not a repo / git disabled / unavailable). */
  async resolve(dir: string): Promise<RepoInfo | null> {
    const key = path.resolve(dir);
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < TTL_MS) return hit.info;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.doResolve(key)
      .then((info) => {
        if (this.cache.size >= MAX_CACHE) {
          const first = this.cache.keys().next().value;
          if (first !== undefined) this.cache.delete(first);
        }
        this.cache.set(key, { at: this.now(), info });
        return info;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** Drop cached entries (after a commit / branch switch is suspected). */
  invalidate(): void {
    this.cache.clear();
  }

  private async doResolve(dir: string): Promise<RepoInfo | null> {
    if (!this.runner.isEnabled()) return null;
    const cwd = await existingDir(dir);
    if (!cwd) return null;
    let r;
    try {
      r = await this.runner.run({
        cwd,
        kind: 'rev-parse',
        args: [
          'rev-parse',
          '--show-toplevel',
          '--absolute-git-dir',
          '--git-common-dir',
          '--git-path',
          'index',
          'HEAD',
          '--abbrev-ref',
          'HEAD',
        ],
      });
    } catch (err) {
      if (err instanceof GitError) return null;
      throw err;
    }
    const lines = r.stdout.split('\n').filter((l) => l.length > 0);
    if (lines.length < 4 || !path.isAbsolute(lines[0])) return null;
    const [root, gitDir, commonRaw, indexRaw] = lines;
    const commonDir = path.resolve(cwd, commonRaw);
    const unborn = r.code !== 0;
    const head = !unborn && /^[0-9a-f]{40,64}$/.test(lines[4] || '') ? lines[4] : null;
    const branchRaw = !unborn ? lines[5] || null : null;
    return {
      root,
      gitDir,
      commonDir,
      indexPath: path.resolve(cwd, indexRaw),
      worktree: path.resolve(gitDir) !== commonDir,
      branch: branchRaw && branchRaw !== 'HEAD' ? branchRaw : null,
      head,
    };
  }
}
