/**
 * Code Review reverts: preview -> token -> CAS apply -> backup -> undo.
 *
 *   preview  computes the exact bytes the file will have afterwards (hunk:
 *            `git apply -R` on a private copy; file: blob from HEAD or the
 *            checkpoint snapshot), the patch the user sees, a tier from
 *            classifyRevert, and a 128-bit token bound to the connection.
 *   apply    re-checks the token / client / tier, takes a per-repo mutex,
 *            re-checks the session is not editing the file, backs it up, writes
 *            a temp file (same dir, same mode, fsync), verifies the original
 *            still has the previewed sha (CAS), then renames (or unlinks).
 *   undo     only while the file still has the post-revert sha.
 * Every apply / undo is audited.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitRunner } from './git-runner';
import type { RepoInfo } from './repo';
import { readBlob } from './snapshot';
import { parseUnifiedDiff, renderPatch, ParsedHunk } from './diff-parse';
import { REVIEW_LIMITS } from './protocol';
import type {
  ReviewRevertBlockCode,
  ReviewRevertEffect,
  ReviewRevertPreviewResponse,
  ReviewRevertTarget,
  ReviewRiskFlag,
} from './protocol';
import { classifyRevert } from '../herald/danger';

export const MAX_REVERT_BYTES = 2 * 1024 * 1024;
const MAX_TOKENS = 20;
const PATCH_CLIP = 200 * 1024;
const BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BACKUP_MAX_BYTES = 200 * 1024 * 1024;

export class RevertError extends Error {
  constructor(
    readonly code: 'expired' | 'tier_mismatch' | 'blocked' | 'busy' | 'not_found' | 'bad_request',
    message: string
  ) {
    super(message);
  }
}

export interface RevertPlanInput {
  clientId: string;
  sessionId: string;
  target: ReviewRevertTarget;
  /** Resolved absolute path. */
  absPath: string;
  /** Display path. */
  path: string;
  /** Repo containing the file (null = not in a repo). */
  repo: RepoInfo | null;
  /** The hunk to revert (target kind 'hunk'). */
  hunk?: ParsedHunk;
  /** The hunk came from a whole-file create (reverting it empties the file -> delete). */
  hunkIsCreate?: boolean;
  /** Checkpoint snapshot tree for the repo (target to:'checkpoint'). */
  checkpointTree?: string | null;
  /** Risk flags of the file's current change. */
  risks: ReviewRiskFlag[];
  sessionWorking: boolean;
  /** Pre-computed block (sandbox, editing, foreign, ...). */
  blocked?: { code: ReviewRevertBlockCode; message: string } | null;
}

interface Token {
  id: string;
  clientId: string;
  sessionId: string;
  absPath: string;
  path: string;
  repoRoot: string | null;
  kind: 'hunk' | 'file';
  effect: ReviewRevertEffect;
  tier: 'echo' | 'hard_confirm';
  reasons: string[];
  /** sha256 of the current bytes ('' = file absent). */
  expectedSha: string;
  /** Bytes after the revert (null = delete). */
  result: Buffer | null;
  expiresAt: number;
  target: ReviewRevertTarget;
}

export interface BackupMeta {
  backupId: string;
  sessionId: string;
  absPath: string;
  path: string;
  effect: ReviewRevertEffect;
  /** Whether the original existed. */
  existed: boolean;
  mode: number | null;
  /** sha256 after the revert ('' = deleted). */
  postSha: string;
  at: number;
  by: string | null;
  /** Mutex key shared with apply (repo root, else the file's dir). */
  lockKey: string;
  undone?: boolean;
}

export function sha256(buf: Buffer | null): string {
  return buf === null ? '' : crypto.createHash('sha256').update(buf).digest('hex');
}

async function readMaybe(p: string): Promise<{ data: Buffer; mode: number } | null> {
  try {
    const st = await fs.promises.lstat(p);
    if (!st.isFile()) return null;
    return { data: await fs.promises.readFile(p), mode: st.mode & 0o7777 };
  } catch {
    return null;
  }
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Atomic replace: temp file in the same dir, same mode, fsync, rename. */
async function writeAtomic(target: string, data: Buffer, mode: number | null): Promise<void> {
  const dir = path.dirname(target);
  const tmp = path.join(
    dir,
    `.${path.basename(target)}.companion-revert-${process.pid}-${Date.now()}`
  );
  const fh = await fs.promises.open(tmp, 'wx', mode ?? 0o644);
  try {
    await fh.writeFile(data);
    if (mode !== null) await fh.chmod(mode);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.promises.rename(tmp, target);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export interface RevertManagerDeps {
  runner: GitRunner;
  backupDir: string;
  now?: () => number;
}

export class RevertManager {
  private tokens = new Map<string, Token>();
  private mutexes = new Map<string, Promise<unknown>>();
  private now: () => number;

  constructor(private deps: RevertManagerDeps) {
    this.now = deps.now || Date.now;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, t] of this.tokens) if (t.expiresAt <= now) this.tokens.delete(id);
    while (this.tokens.size >= MAX_TOKENS) {
      const first = this.tokens.keys().next().value;
      if (first === undefined) break;
      this.tokens.delete(first);
    }
  }

  private withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.mutexes.get(key) || Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    const tail = next.catch(() => undefined);
    this.mutexes.set(key, tail);
    void tail.then(() => {
      if (this.mutexes.get(key) === tail) this.mutexes.delete(key);
    });
    return next;
  }

  /** Apply a single hunk in reverse to `current` (private copy, works outside repos). */
  async reverseHunk(current: Buffer, hunk: ParsedHunk): Promise<Buffer | null> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'companion-revert-'));
    try {
      const f = path.join(dir, 'f');
      await fs.promises.writeFile(f, current);
      const patch = renderPatch('f', 'f', [hunk]);
      const noContext = !hunk.lines.some((l) => l.startsWith(' '));
      const args = ['apply', '-R', '--whitespace=nowarn', ...(noContext ? ['--unidiff-zero'] : [])];
      const check = await this.deps.runner.run({
        cwd: dir,
        kind: 'apply',
        args: [...args, '--check'],
        stdin: patch,
      });
      if (check.code !== 0) return null;
      const r = await this.deps.runner.run({ cwd: dir, kind: 'apply', args, stdin: patch });
      if (r.code !== 0) return null;
      return await fs.promises.readFile(f);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Unified diff current -> after (git diff --no-index on private copies). */
  async renderChange(
    current: Buffer | null,
    after: Buffer | null,
    display: string
  ): Promise<{ patch: string; additions: number; deletions: number }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'companion-revert-diff-'));
    try {
      const a = path.join(dir, 'a');
      const b = path.join(dir, 'b');
      await fs.promises.writeFile(a, current ?? Buffer.alloc(0));
      await fs.promises.writeFile(b, after ?? Buffer.alloc(0));
      const r = await this.deps.runner.run({
        cwd: dir,
        kind: 'diff',
        args: ['diff', '--no-index', '--no-color', '--src-prefix=x/', '--dst-prefix=y/', 'a', 'b'],
      });
      let patch = r.stdout
        .replace(/^diff --git x\/a y\/b$/m, `diff --git a/${display} b/${display}`)
        .replace(/^--- x\/a$/m, current === null ? '--- /dev/null' : `--- a/${display}`)
        .replace(/^\+\+\+ y\/b$/m, after === null ? '+++ /dev/null' : `+++ b/${display}`);
      const parsed = parseUnifiedDiff(patch);
      const additions = parsed.reduce((n, f) => n + f.additions, 0);
      const deletions = parsed.reduce((n, f) => n + f.deletions, 0);
      if (patch.length > PATCH_CLIP) patch = patch.slice(0, PATCH_CLIP) + '\n… (clipped)\n';
      return { patch, additions, deletions };
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async preview(input: RevertPlanInput): Promise<ReviewRevertPreviewResponse> {
    this.sweep();
    const now = this.now();
    const blockedResp = (
      code: ReviewRevertBlockCode,
      message: string,
      effect: ReviewRevertEffect = input.target.kind === 'hunk' ? 'patch' : 'restore'
    ): ReviewRevertPreviewResponse => ({
      token: null,
      tier: 'hard_confirm',
      reasons: [],
      blocked: { code, message },
      effect,
      patch: '',
      additions: 0,
      deletions: 0,
      expiresAt: now,
    });
    if (input.blocked) return blockedResp(input.blocked.code, input.blocked.message);

    const cur = await readMaybe(input.absPath);
    if (cur && cur.data.length > MAX_REVERT_BYTES)
      return blockedResp('too_large', 'the file is larger than 2 MB');
    if (cur && isBinary(cur.data))
      return blockedResp('binary', 'binary files cannot be reverted here');

    let result: Buffer | null;
    let effect: ReviewRevertEffect;
    if (input.target.kind === 'hunk') {
      if (!input.hunk) return blockedResp('conflict', 'that change is no longer available');
      if (!cur) return blockedResp('conflict', 'the file no longer exists');
      const out = await this.reverseHunk(cur.data, input.hunk);
      if (out === null) return blockedResp('conflict', 'the file changed after this edit');
      if (input.hunkIsCreate && out.length === 0) {
        result = null;
        effect = 'delete';
      } else {
        result = out;
        effect = 'patch';
      }
    } else {
      if (!input.repo) return blockedResp('not_in_repo', 'the file is not in a git repository');
      const rel = path.relative(input.repo.root, input.absPath);
      const rev = input.target.to === 'head' ? 'HEAD' : input.checkpointTree;
      if (!rev)
        return blockedResp('no_checkpoint', 'there is no checkpoint snapshot for this repo');
      if (rev === 'HEAD' && !input.repo.head) {
        result = null;
      } else {
        const blob = await readBlob(this.deps.runner, input.repo, rev, rel);
        result = blob ? blob.data : null;
      }
      if (result && result.length > MAX_REVERT_BYTES)
        return blockedResp('too_large', 'the target version is larger than 2 MB');
      if (result && isBinary(result))
        return blockedResp('binary', 'binary files cannot be reverted here');
      effect = result === null ? 'delete' : 'restore';
      if (result === null && !cur)
        return blockedResp('conflict', 'nothing to revert: the file does not exist');
    }
    if (cur && result && cur.data.equals(result))
      return blockedResp('conflict', 'nothing to revert: the file already matches', effect);

    const change = await this.renderChange(cur ? cur.data : null, result, input.path);
    const cls = classifyRevert({
      effect,
      wholeFile: input.target.kind === 'file',
      risks: input.risks,
      changedLines: change.additions + change.deletions,
      sessionWorking: input.sessionWorking,
      path: input.path,
    });
    const id = crypto.randomBytes(16).toString('hex');
    const expiresAt = now + REVIEW_LIMITS.revertTokenTtlMs;
    this.tokens.set(id, {
      id,
      clientId: input.clientId,
      sessionId: input.sessionId,
      absPath: input.absPath,
      path: input.path,
      repoRoot: input.repo?.root ?? null,
      kind: input.target.kind,
      effect,
      tier: cls.tier,
      reasons: cls.reasons,
      expectedSha: sha256(cur ? cur.data : null),
      result,
      expiresAt,
      target: input.target,
    });
    return {
      token: id,
      tier: cls.tier,
      reasons: cls.reasons,
      blocked: null,
      effect,
      patch: change.patch,
      additions: change.additions,
      deletions: change.deletions,
      expiresAt,
    };
  }

  /** Validate a token for this client + confirm gesture (does not consume it). */
  peek(tokenId: string, clientId: string, confirm: 'tap' | 'hold'): Token {
    this.sweep();
    const t = this.tokens.get(tokenId);
    if (!t || t.clientId !== clientId || t.expiresAt <= this.now())
      throw new RevertError('expired', 'This revert preview expired; preview it again');
    if (t.tier === 'hard_confirm' && confirm !== 'hold')
      throw new RevertError('tier_mismatch', 'This revert needs a hold to confirm');
    return t;
  }

  /**
   * Apply a previewed revert. `stillSafe` re-checks that the session is not
   * editing the file right now (throws RevertError('blocked') when it is).
   */
  async apply(
    tokenId: string,
    clientId: string,
    confirm: 'tap' | 'hold',
    device: string | null,
    stillSafe: (t: { sessionId: string; absPath: string }) => void
  ): Promise<{ token: Omit<Token, 'result'>; meta: BackupMeta }> {
    const t = this.peek(tokenId, clientId, confirm);
    this.tokens.delete(tokenId);
    const lockKey = t.repoRoot || path.dirname(t.absPath);
    return this.withMutex(lockKey, async () => {
      stillSafe(t);
      const cur = await readMaybe(t.absPath);
      if (sha256(cur ? cur.data : null) !== t.expectedSha)
        throw new RevertError('blocked', 'conflict: the file changed after the preview');
      const backupId = crypto.randomBytes(12).toString('hex');
      const bdir = path.join(this.deps.backupDir, backupId);
      await fs.promises.mkdir(bdir, { recursive: true, mode: 0o700 });
      if (cur) await fs.promises.writeFile(path.join(bdir, 'original'), cur.data, { mode: 0o600 });
      const meta: BackupMeta = {
        backupId,
        sessionId: t.sessionId,
        absPath: t.absPath,
        path: t.path,
        effect: t.effect,
        existed: !!cur,
        mode: cur ? cur.mode : null,
        postSha: sha256(t.result),
        at: this.now(),
        by: device,
        lockKey,
      };
      await fs.promises.writeFile(path.join(bdir, 'meta.json'), JSON.stringify(meta), {
        mode: 0o600,
      });
      if (t.result === null) {
        // CAS right before the unlink.
        const again = await readMaybe(t.absPath);
        if (sha256(again ? again.data : null) !== t.expectedSha)
          throw new RevertError('blocked', 'conflict: the file changed after the preview');
        await fs.promises.unlink(t.absPath);
      } else {
        await fs.promises.mkdir(path.dirname(t.absPath), { recursive: true });
        const again = await readMaybe(t.absPath);
        if (sha256(again ? again.data : null) !== t.expectedSha)
          throw new RevertError('blocked', 'conflict: the file changed after the preview');
        await writeAtomic(t.absPath, t.result, cur ? cur.mode : null);
      }
      void this.pruneBackups().catch(() => undefined);
      const { result: _r, ...rest } = t;
      void _r;
      return { token: rest, meta };
    });
  }

  async readBackup(backupId: string): Promise<BackupMeta | null> {
    if (!/^[0-9a-f]{24}$/.test(backupId)) return null;
    try {
      const raw = await fs.promises.readFile(
        path.join(this.deps.backupDir, backupId, 'meta.json'),
        'utf-8'
      );
      return JSON.parse(raw) as BackupMeta;
    } catch {
      return null;
    }
  }

  async undo(backupId: string): Promise<BackupMeta> {
    const meta = await this.readBackup(backupId);
    if (!meta || meta.undone) throw new RevertError('not_found', 'Nothing to undo');
    if (this.now() - meta.at > REVIEW_LIMITS.undoWindowMs)
      throw new RevertError('expired', 'The undo window has passed');
    return this.withMutex(meta.lockKey || path.dirname(meta.absPath), async () => {
      const cur = await readMaybe(meta.absPath);
      if (sha256(cur ? cur.data : null) !== meta.postSha)
        throw new RevertError('blocked', 'conflict: the file changed after the revert');
      if (meta.existed) {
        const data = await fs.promises.readFile(
          path.join(this.deps.backupDir, backupId, 'original')
        );
        await fs.promises.mkdir(path.dirname(meta.absPath), { recursive: true });
        await writeAtomic(meta.absPath, data, meta.mode);
      } else {
        await fs.promises.unlink(meta.absPath).catch(() => undefined);
      }
      const done = { ...meta, undone: true };
      await fs.promises.writeFile(
        path.join(this.deps.backupDir, backupId, 'meta.json'),
        JSON.stringify(done),
        { mode: 0o600 }
      );
      return done;
    });
  }

  /** Drop backups older than 24 h, then oldest first while over 200 MB. */
  async pruneBackups(): Promise<void> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.deps.backupDir);
    } catch {
      return;
    }
    const entries: Array<{ dir: string; at: number; bytes: number }> = [];
    for (const n of names) {
      const dir = path.join(this.deps.backupDir, n);
      try {
        const st = await fs.promises.stat(dir);
        let bytes = 0;
        for (const f of await fs.promises.readdir(dir))
          bytes += (await fs.promises.stat(path.join(dir, f))).size;
        entries.push({ dir, at: st.mtimeMs, bytes });
      } catch {
        /* skip */
      }
    }
    entries.sort((a, b) => a.at - b.at);
    let total = entries.reduce((n, e) => n + e.bytes, 0);
    const now = this.now();
    for (const e of entries) {
      if (now - e.at > BACKUP_MAX_AGE_MS || total > BACKUP_MAX_BYTES) {
        await fs.promises.rm(e.dir, { recursive: true, force: true }).catch(() => undefined);
        total -= e.bytes;
      }
    }
  }
}
