/**
 * The net "by file" view: one tree-to-tree diff per repo between a base
 * (checkpoint snapshot / baseline / HEAD) and a temp-index snapshot of now,
 * split into files the session's transcript claims and unattributed changes
 * (Bash edits, other tools). Files git cannot see (gitignored, outside any
 * repo, git disabled) fall back to the transcript's per-edit hunks.
 */

import * as path from 'path';
import { GitError, GitRunner } from './git-runner';
import type { RepoInfo, RepoResolver } from './repo';
import type { LedgerEdit } from './ledger';
import type { StoredCheckpoint, TreeRef } from './store';
import type { ParsedFileDiff } from './diff-parse';
import { headTree, ignoredPaths, netDiff, NetDiff, objectsExist, snapshotTree } from './snapshot';
import {
  addedLines,
  countHunkLines,
  gitHunkId,
  heatScore,
  removedLines,
  toReviewHunk,
  trivialKind,
} from './analyze';
import { classifyChangedFile, maxRiskLevel } from '../herald/danger';
import { REVIEW_LIMITS } from './protocol';
import type { ReviewFileChange, ReviewHunk, ReviewRepo, ReviewScope } from './protocol';

export const MAX_REPOS_PER_SESSION = 4;
const TOO_MANY_UNATTRIBUTED = 2000;
const DIFF_CACHE_MAX = 64;
const DIFF_CACHE_BYTES = 32 * 1024 * 1024;

export interface NetViewHost {
  runner: GitRunner;
  repos: RepoResolver;
  gitEnabled(): boolean;
  now(): number;
  displayPath(absPath: string, projectPath: string): string;
  isOutsideProject(absPath: string, projectPath: string): boolean;
  isExcludedPath(absPath: string, projectPath?: string): boolean;
  /** Other sessions' transcripts that touched the file since `since` (names). */
  alsoChangedBy(sessionId: string, absPath: string, since: number): string[];
}

export interface NetViewInput {
  sessionId: string;
  projectPath: string;
  scope: ReviewScope;
  cp: StoredCheckpoint;
  /** Session edits in scope (countable), oldest first. */
  edits: LedgerEdit[];
  /** Is this edit unreviewed (for `unreviewed` on files). */
  isUnreviewed: (e: LedgerEdit) => boolean;
  /** Inline every hunk of this file (review_get_file). */
  focusAbsPath?: string;
}

export interface NetViewResult {
  files: ReviewFileChange[];
  unattributed: ReviewFileChange[];
  repos: ReviewRepo[];
  omittedFiles?: number;
  /** review_get_file: the focused file had more than maxFileHunkLines. */
  focusTruncated?: boolean;
}

interface RepoPlan {
  info: RepoInfo;
  edits: Map<string, LedgerEdit[]>;
}

function editsByPath(edits: LedgerEdit[]): Map<string, LedgerEdit[]> {
  const m = new Map<string, LedgerEdit[]>();
  for (const e of edits) {
    const l = m.get(e.absPath) || [];
    l.push(e);
    m.set(e.absPath, l);
  }
  return m;
}

export class NetViewBuilder {
  private diffCache = new Map<string, { diff: NetDiff; bytes: number }>();
  private diffCacheBytes = 0;

  constructor(private host: NetViewHost) {}

  /** The session's repos: project repo first, then repos of touched dirs (<= 4). */
  async sessionRepos(projectPath: string, absPaths: string[]): Promise<{ repos: RepoInfo[]; repoOf: Map<string, RepoInfo | null> }> {
    const repos: RepoInfo[] = [];
    const repoOf = new Map<string, RepoInfo | null>();
    if (!this.host.gitEnabled()) return { repos, repoOf };
    const add = (r: RepoInfo | null) => {
      if (r && !repos.some((x) => x.root === r.root) && repos.length < MAX_REPOS_PER_SESSION) repos.push(r);
    };
    if (projectPath) add(await this.host.repos.resolve(projectPath).catch(() => null));
    const dirs = new Map<string, string[]>();
    for (const p of absPaths) {
      const d = path.dirname(p);
      const l = dirs.get(d) || [];
      l.push(p);
      dirs.set(d, l);
    }
    for (const [dir, files] of dirs) {
      const r = await this.host.repos.resolve(dir).catch(() => null);
      add(r);
      const usable = r && repos.some((x) => x.root === r.root) ? r : null;
      for (const f of files) repoOf.set(f, usable);
    }
    return { repos, repoOf };
  }

  /** Base tree for a repo: checkpoint snapshot, else baseline, else HEAD. */
  async baseTree(
    repo: RepoInfo,
    scope: ReviewScope,
    cp: StoredCheckpoint
  ): Promise<{ tree: string | null; fromSnapshot: boolean }> {
    const pick = (list: TreeRef[] | undefined) => list?.find((t) => t.repoRoot === repo.root)?.tree;
    const candidate =
      scope === 'since_checkpoint' && cp.reviewedThrough > 0 ? pick(cp.snapshots) : pick(cp.baseline);
    if (candidate) {
      const ok = await objectsExist(this.host.runner, repo, [candidate]).catch(() => new Set<string>());
      if (ok.has(candidate)) return { tree: candidate, fromSnapshot: true };
      console.log(`Review: checkpoint snapshot ${candidate.slice(0, 8)} expired in ${repo.root}; using HEAD`);
    }
    return { tree: await headTree(this.host.runner, repo), fromSnapshot: false };
  }

  private async cachedDiff(repo: RepoInfo, base: string, now: string): Promise<NetDiff> {
    const key = `${repo.root}\0${base}\0${now}`;
    const hit = this.diffCache.get(key);
    if (hit) {
      this.diffCache.delete(key);
      this.diffCache.set(key, hit);
      return hit.diff;
    }
    const diff = await netDiff(this.host.runner, repo, base, now);
    const bytes = diff.files
      ? diff.files.reduce((n, f) => n + f.raw.length * 2, 0)
      : (diff.numstat?.length || 0) * 200;
    this.diffCache.set(key, { diff, bytes });
    this.diffCacheBytes += bytes;
    while (this.diffCache.size > DIFF_CACHE_MAX || this.diffCacheBytes > DIFF_CACHE_BYTES) {
      const k = this.diffCache.keys().next().value;
      if (k === undefined) break;
      this.diffCacheBytes -= this.diffCache.get(k)!.bytes;
      this.diffCache.delete(k);
    }
    return diff;
  }

  async build(input: NetViewInput): Promise<NetViewResult> {
    const { projectPath } = input;
    const now = this.host.now();
    const touched = editsByPath(input.edits.filter((e) => !e.excluded));
    const files: ReviewFileChange[] = [];
    const unattributed: ReviewFileChange[] = [];
    const repoOut: ReviewRepo[] = [];
    let focusTruncated = false;

    const { repos, repoOf } = await this.sessionRepos(projectPath, Array.from(touched.keys()));
    const plans: RepoPlan[] = repos.map((info) => ({ info, edits: new Map() }));
    const transcriptOnly = new Map<string, LedgerEdit[]>();
    for (const [abs, edits] of touched) {
      const r = repoOf.get(abs);
      const plan = r ? plans.find((p) => p.info.root === r.root) : undefined;
      if (plan) plan.edits.set(abs, edits);
      else transcriptOnly.set(abs, edits);
    }

    for (const plan of plans) {
      const repo = plan.info;
      const wire: ReviewRepo = { root: repo.root, worktree: repo.worktree, branch: repo.branch, head: repo.head };
      repoOut.push(wire);
      if (this.host.runner.isDegraded(repo.root)) {
        wire.degraded = 'timeout';
        for (const [abs, edits] of plan.edits) transcriptOnly.set(abs, edits);
        continue;
      }
      try {
        const base = await this.baseTree(repo, input.scope, input.cp);
        let nowTree: string;
        let limited = false;
        try {
          nowTree = await snapshotTree(this.host.runner, repo);
        } catch (err) {
          if (!(err instanceof GitError) || err.code !== 'timeout') throw err;
          limited = true;
          wire.degraded = 'timeout';
          nowTree = await snapshotTree(this.host.runner, repo, {
            limitTo: Array.from(plan.edits.keys()).map((a) => path.relative(repo.root, a)),
          });
        }
        const diff = base.tree ? await this.cachedDiff(repo, base.tree, nowTree) : { files: [], numstat: null };
        const seen = new Set<string>();
        const entries: Array<{ parsed: ParsedFileDiff | null; rel: string; oldRel?: string; numstat?: { a: number | null; d: number | null; binary: boolean } }> = [];
        if (diff.files) {
          for (const f of diff.files) entries.push({ parsed: f, rel: (f.newPath ?? f.oldPath)!, oldRel: f.oldPath && f.newPath && f.oldPath !== f.newPath ? f.oldPath : undefined });
        } else if (diff.numstat) {
          for (const n of diff.numstat)
            entries.push({ parsed: null, rel: n.path, oldRel: n.oldPath, numstat: { a: n.additions, d: n.deletions, binary: n.binary } });
        }
        let unclaimed = 0;
        for (const ent of entries) {
          const abs = path.join(repo.root, ent.rel);
          const oldAbs = ent.oldRel ? path.join(repo.root, ent.oldRel) : undefined;
          const claimed = plan.edits.get(abs) || (oldAbs ? plan.edits.get(oldAbs) : undefined);
          seen.add(abs);
          if (oldAbs) seen.add(oldAbs);
          if (!claimed) {
            if (this.host.isExcludedPath(abs, input.projectPath)) continue;
            if (this.host.alsoChangedBy(input.sessionId, abs, 0).length) continue;
            unclaimed++;
            if (unclaimed > TOO_MANY_UNATTRIBUTED) {
              wire.degraded = 'too_many_untracked';
              continue;
            }
          }
          const fc = this.gitFileChange(input, repo, ent, claimed || [], now);
          if (claimed) files.push(fc);
          else unattributed.push(fc);
        }
        if (limited && !wire.degraded) wire.degraded = 'timeout';
        // Claimed files git does not show: gitignored -> transcript; net zero -> omitted
        // (unless the base is HEAD only, where committed work would vanish).
        const missing = Array.from(plan.edits.keys()).filter((a) => !seen.has(a));
        if (missing.length) {
          const rels = missing.map((a) => path.relative(repo.root, a));
          const ignored = await ignoredPaths(this.host.runner, repo, rels).catch(() => new Set<string>());
          for (const abs of missing) {
            const rel = path.relative(repo.root, abs);
            if (ignored.has(rel) || !base.fromSnapshot) transcriptOnly.set(abs, plan.edits.get(abs)!);
          }
        }
      } catch (err) {
        if (!(err instanceof GitError)) throw err;
        wire.degraded = err.code === 'git_disabled' ? 'git_disabled' : 'timeout';
        for (const [abs, edits] of plan.edits) transcriptOnly.set(abs, edits);
      }
    }

    for (const [abs, edits] of transcriptOnly) files.push(this.transcriptFileChange(input, abs, edits, now));

    const byHeat = (a: ReviewFileChange, b: ReviewFileChange) => b.heat - a.heat || a.path.localeCompare(b.path);
    files.sort(byHeat);
    unattributed.sort(byHeat);
    let omittedFiles = 0;
    if (files.length > REVIEW_LIMITS.maxFilesPerView) {
      omittedFiles += files.length - REVIEW_LIMITS.maxFilesPerView;
      files.length = REVIEW_LIMITS.maxFilesPerView;
    }
    if (unattributed.length > REVIEW_LIMITS.maxFilesPerView) {
      omittedFiles += unattributed.length - REVIEW_LIMITS.maxFilesPerView;
      unattributed.length = REVIEW_LIMITS.maxFilesPerView;
    }
    // Response budget: inline hunks in heat order, the rest lazy.
    let bytes = 0;
    const budget = REVIEW_LIMITS.maxResponseBytes - 128 * 1024;
    for (const f of [...files, ...unattributed]) {
      if (f.hunks) {
        const size = JSON.stringify(f.hunks).length;
        if (bytes + size > budget && f.absPath !== input.focusAbsPath) {
          f.hunks = null;
          f.hunksOmitted = 'lazy';
        } else bytes += size;
      }
      if (f.absPath === input.focusAbsPath && f.hunks) {
        const total = countHunkLines(f.hunks);
        if (total > REVIEW_LIMITS.maxFileHunkLines) {
          focusTruncated = true;
          let left = REVIEW_LIMITS.maxFileHunkLines;
          const kept: ReviewHunk[] = [];
          for (const h of f.hunks) {
            if (left <= 0) break;
            kept.push(h.lines.length <= left ? h : { ...h, lines: h.lines.slice(0, left) });
            left -= h.lines.length;
          }
          f.hunks = kept;
        }
      }
    }
    return {
      files,
      unattributed,
      repos: repoOut,
      ...(omittedFiles ? { omittedFiles } : {}),
      ...(focusTruncated ? { focusTruncated } : {}),
    };
  }

  private fileFacts(input: NetViewInput, abs: string, claimed: LedgerEdit[], now: number) {
    const turnIds: string[] = [];
    for (const e of claimed) if (!turnIds.includes(e.turnId)) turnIds.push(e.turnId);
    const lastChangeAt = claimed.length ? Math.max(...claimed.map((e) => e.at)) : null;
    const since = input.scope === 'since_checkpoint' ? input.cp.reviewedThrough : 0;
    const alsoChangedBy = claimed.length ? this.host.alsoChangedBy(input.sessionId, abs, since) : [];
    const unreviewed = claimed.length ? claimed.some((e) => input.isUnreviewed(e)) : input.scope === 'since_checkpoint';
    return { turnIds, lastChangeAt: lastChangeAt ?? (claimed.length ? null : now), alsoChangedBy, unreviewed };
  }

  private gitFileChange(
    input: NetViewInput,
    repo: RepoInfo,
    ent: { parsed: ParsedFileDiff | null; rel: string; oldRel?: string; numstat?: { a: number | null; d: number | null; binary: boolean } },
    claimed: LedgerEdit[],
    now: number
  ): ReviewFileChange {
    const abs = path.join(repo.root, ent.rel);
    const p = ent.parsed;
    const binary = p ? p.binary : !!ent.numstat?.binary;
    const additions = p ? p.additions : ent.numstat?.a ?? 0;
    const deletions = p ? p.deletions : ent.numstat?.d ?? 0;
    const status = p ? (p.status === 'copied' ? 'added' : p.status) : ent.oldRel ? 'renamed' : 'modified';
    const display = this.host.displayPath(abs, input.projectPath);
    const facts = this.fileFacts(input, abs, claimed, now);
    const hunksRaw = p ? p.hunks : [];
    const modeChanged = !!(p?.oldMode && p.newMode && p.oldMode !== p.newMode && status !== 'added' && status !== 'deleted');
    const risks = classifyChangedFile(
      abs,
      ent.rel,
      {
        status: status === 'mode_changed' ? 'modified' : status,
        additions,
        deletions,
        binary,
        modeChanged,
        newMode: p?.newMode,
        outsideProject: this.host.isOutsideProject(abs, input.projectPath),
        alsoChangedBy: facts.alsoChangedBy,
        removedLines: removedLines(hunksRaw),
      },
      addedLines(hunksRaw)
    );
    const trivial = trivialKind(ent.rel, p ? hunksRaw : null);
    let hunks: ReviewHunk[] | null = null;
    let hunksOmitted: ReviewFileChange['hunksOmitted'];
    const focused = abs === input.focusAbsPath;
    if (binary) hunksOmitted = 'binary';
    else if (!p) hunksOmitted = 'too_large';
    else if (!focused && (trivial === 'lockfile' || trivial === 'generated')) hunksOmitted = 'lazy';
    else if (!focused && countHunkLines(hunksRaw) > REVIEW_LIMITS.maxInlineHunkLinesPerFile) hunksOmitted = 'lazy';
    else hunks = hunksRaw.map((h) => toReviewHunk(gitHunkId(abs, h), h));
    return {
      path: display,
      absPath: abs,
      ...(ent.oldRel ? { oldPath: this.host.displayPath(path.join(repo.root, ent.oldRel), input.projectPath) } : {}),
      status,
      ...(binary ? { binary: true } : {}),
      additions,
      deletions,
      risks,
      heat: heatScore(additions + deletions, Math.max(claimed.length, 1), maxRiskLevel(risks), facts.lastChangeAt, now),
      ...(trivial ? { trivial } : {}),
      source: 'git',
      turnIds: facts.turnIds,
      ...(facts.alsoChangedBy.length ? { alsoChangedBy: facts.alsoChangedBy } : {}),
      unreviewed: facts.unreviewed,
      hunks,
      ...(hunksOmitted ? { hunksOmitted } : {}),
    };
  }

  /** Per edit, not merged: the transcript's own hunks in order. */
  transcriptFileChange(input: NetViewInput, abs: string, edits: LedgerEdit[], now: number): ReviewFileChange {
    const sorted = edits.slice().sort((a, b) => a.at - b.at);
    let additions = 0;
    let deletions = 0;
    const hunks: ReviewHunk[] = [];
    const raw = sorted.flatMap((e) => e.hunks);
    for (const e of sorted) {
      additions += e.additions;
      deletions += e.deletions;
      e.hunks.forEach((h, i) => hunks.push(toReviewHunk(`${e.id}#${i}`, h)));
    }
    const display = this.host.displayPath(abs, input.projectPath);
    const rel = display.replace(/^~\//, '');
    const facts = this.fileFacts(input, abs, sorted, now);
    const created = sorted[0]?.kind === 'create';
    const risks = classifyChangedFile(
      abs,
      rel,
      {
        status: created ? 'added' : 'modified',
        additions,
        deletions,
        outsideProject: this.host.isOutsideProject(abs, input.projectPath),
        alsoChangedBy: facts.alsoChangedBy,
        removedLines: removedLines(raw),
      },
      addedLines(raw)
    );
    const trivial = trivialKind(rel, raw);
    const focused = abs === input.focusAbsPath;
    const unavailable = sorted.every((e) => e.patchUnavailable);
    let out: ReviewHunk[] | null = hunks;
    let hunksOmitted: ReviewFileChange['hunksOmitted'];
    if (unavailable) {
      out = null;
      hunksOmitted = 'unavailable';
    } else if (!focused && (trivial === 'lockfile' || trivial === 'generated' || countHunkLines(hunks) > REVIEW_LIMITS.maxInlineHunkLinesPerFile)) {
      out = null;
      hunksOmitted = 'lazy';
    }
    return {
      path: display,
      absPath: abs,
      status: created ? 'added' : 'modified',
      additions,
      deletions,
      risks,
      heat: heatScore(additions + deletions, sorted.length, maxRiskLevel(risks), facts.lastChangeAt, now),
      ...(trivial ? { trivial } : {}),
      source: 'transcript',
      turnIds: facts.turnIds,
      ...(facts.alsoChangedBy.length ? { alsoChangedBy: facts.alsoChangedBy } : {}),
      unreviewed: facts.unreviewed,
      hunks: out,
      ...(hunksOmitted ? { hunksOmitted } : {}),
    };
  }

  /** Snapshot every session repo (checkpoint move). */
  async snapshots(projectPath: string, absPaths: string[]): Promise<TreeRef[]> {
    const { repos } = await this.sessionRepos(projectPath, absPaths);
    const out: TreeRef[] = [];
    for (const r of repos) {
      try {
        out.push({ repoRoot: r.root, tree: await snapshotTree(this.host.runner, r) });
      } catch (err) {
        console.error(`Review: snapshot of ${r.root} failed:`, err instanceof Error ? err.message : err);
      }
    }
    return out;
  }
}
