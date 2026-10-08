/**
 * Working-tree snapshots without touching the user's index or refs:
 * copy the repo's index (worktree-correct path) to a private temp file,
 * `GIT_INDEX_FILE=tmp git add -A`, `git write-tree`. Only dangling objects are
 * written (no refs), so `git gc` may eventually prune old snapshots; callers
 * check `treeExists` and fall back to HEAD.
 *
 * netDiff(base, now) is a tree-to-tree `git diff -M` (no pathspecs in argv):
 * callers split the result into session-claimed and unattributed files.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitError, GitRunner, pathspecStdin } from './git-runner';
import type { RepoInfo } from './repo';
import { parseNumstatZ, parseUnifiedDiff, NumstatEntry, ParsedFileDiff } from './diff-parse';

const SHA_RE = /^[0-9a-f]{40,64}$/;

export interface SnapshotOptions {
  /** Only these repo-relative paths (plus tracked changes via `add -u`). */
  limitTo?: string[];
}

/** Snapshot the working tree of `repo` as a tree object. */
export async function snapshotTree(
  runner: GitRunner,
  repo: RepoInfo,
  opts: SnapshotOptions = {}
): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'companion-review-idx-'));
  const tmpIndex = path.join(dir, 'index');
  try {
    try {
      await fs.promises.copyFile(repo.indexPath, tmpIndex);
    } catch {
      /* no index yet (fresh repo): git starts an empty one */
    }
    const env = { GIT_INDEX_FILE: tmpIndex };
    const base = { cwd: repo.root, repoKey: repo.root, env, kind: 'write' as const };
    if (opts.limitTo) {
      const u = await runner.run({ ...base, args: ['add', '-u'] });
      if (u.code !== 0) throw new GitError('spawn_failed', `git add -u failed: ${u.stderr.trim()}`);
      // Deleted tracked files are covered by `add -u`; a pathspec that matches
      // nothing would make `git add` fail, so only existing paths go in.
      const present: string[] = [];
      for (const rel of opts.limitTo) {
        if (
          await fs.promises.lstat(path.join(repo.root, rel)).then(
            () => true,
            () => false
          )
        )
          present.push(rel);
      }
      if (present.length) {
        const ps = pathspecStdin(present);
        const a = await runner.run({
          ...base,
          args: ['add', '-A', '--ignore-errors', ...ps.args],
          stdin: ps.stdin,
        });
        if (a.code !== 0 && a.code !== 1)
          throw new GitError('spawn_failed', `git add failed: ${a.stderr.trim()}`);
      }
    } else {
      const a = await runner.run({ ...base, args: ['add', '-A'] });
      if (a.code !== 0) throw new GitError('spawn_failed', `git add -A failed: ${a.stderr.trim()}`);
    }
    const w = await runner.run({ ...base, args: ['write-tree'] });
    const tree = w.stdout.trim();
    if (w.code !== 0 || !SHA_RE.test(tree))
      throw new GitError('spawn_failed', `git write-tree failed: ${w.stderr.trim()}`);
    return tree;
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** HEAD's tree (null on an unborn branch). */
export async function headTree(runner: GitRunner, repo: RepoInfo): Promise<string | null> {
  if (!repo.head) return emptyTree(runner, repo);
  const r = await runner.run({
    cwd: repo.root,
    repoKey: repo.root,
    kind: 'rev-parse',
    args: ['rev-parse', `${repo.head}^{tree}`],
  });
  const t = r.stdout.trim();
  return r.code === 0 && SHA_RE.test(t) ? t : null;
}

/** The empty tree's id in this repo's hash format. */
export async function emptyTree(runner: GitRunner, repo: RepoInfo): Promise<string> {
  const r = await runner.run({
    cwd: repo.root,
    repoKey: repo.root,
    kind: 'write',
    args: ['hash-object', '-t', 'tree', '--stdin'],
    stdin: '',
  });
  const t = r.stdout.trim();
  return SHA_RE.test(t) ? t : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
}

/** Which of these objects still exist (gc may prune dangling snapshot trees). */
export async function objectsExist(
  runner: GitRunner,
  repo: RepoInfo,
  ids: string[]
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!ids.length) return out;
  const r = await runner.run({
    cwd: repo.root,
    repoKey: repo.root,
    kind: 'read',
    args: ['cat-file', '--batch-check'],
    stdin: ids.join('\n') + '\n',
  });
  const lines = r.stdout.split('\n');
  ids.forEach((id, i) => {
    if (lines[i] && !/ missing$/.test(lines[i])) out.add(id);
  });
  return out;
}

export interface NetDiff {
  files: ParsedFileDiff[] | null;
  /** Set when the patch was too large: numstat only. */
  numstat: NumstatEntry[] | null;
}

/** Tree-to-tree diff with rename detection; falls back to numstat when huge. */
export async function netDiff(
  runner: GitRunner,
  repo: RepoInfo,
  base: string,
  now: string
): Promise<NetDiff> {
  if (base === now) return { files: [], numstat: null };
  const common = { cwd: repo.root, repoKey: repo.root, kind: 'diff' as const };
  try {
    const r = await runner.run({
      ...common,
      args: ['diff', '-M', '--src-prefix=a/', '--dst-prefix=b/', base, now],
    });
    if (r.code !== 0) throw new GitError('spawn_failed', `git diff failed: ${r.stderr.trim()}`);
    return { files: parseUnifiedDiff(r.stdout), numstat: null };
  } catch (err) {
    if (!(err instanceof GitError) || err.code !== 'too_large') throw err;
  }
  const n = await runner.run({ ...common, args: ['diff', '-M', '--numstat', '-z', base, now] });
  if (n.code !== 0)
    throw new GitError('spawn_failed', `git diff --numstat failed: ${n.stderr.trim()}`);
  return { files: null, numstat: parseNumstatZ(n.stdout) };
}

/** Repo-relative paths that are gitignored (`check-ignore --stdin`). */
export async function ignoredPaths(
  runner: GitRunner,
  repo: RepoInfo,
  rels: string[]
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!rels.length) return out;
  const r = await runner.run({
    cwd: repo.root,
    repoKey: repo.root,
    kind: 'read',
    args: ['check-ignore', '--stdin', '-z', '--no-index'],
    stdin: rels.join('\0') + '\0',
  });
  for (const p of r.stdout.split('\0')) if (p) out.add(p);
  return out;
}

/** Exact bytes of `<rev>:<rel>` (null when absent). */
export async function readBlob(
  runner: GitRunner,
  repo: RepoInfo,
  rev: string,
  rel: string
): Promise<{ data: Buffer; mode: string | null } | null> {
  const ls = await runner.run({
    cwd: repo.root,
    repoKey: repo.root,
    kind: 'read',
    args: ['cat-file', '--batch'],
    stdin: `${rev}:${rel}\n`,
  });
  const buf = ls.stdoutBuf;
  const nl = buf.indexOf(0x0a);
  if (nl < 0) return null;
  const header = buf.subarray(0, nl).toString('utf8');
  const m = header.match(/^([0-9a-f]+) (\w+) (\d+)$/);
  if (!m || m[2] !== 'blob') return null;
  const size = parseInt(m[3], 10);
  return { data: Buffer.from(buf.subarray(nl + 1, nl + 1 + size)), mode: null };
}
