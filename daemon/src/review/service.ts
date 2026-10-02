/**
 * ReviewService: Code Review 2.0 on the daemon.
 *
 * Ledger (transcript) is the source of truth for turns + per-edit hunks; git
 * (through the bounded GitRunner) only for the net "by file" view, renames,
 * binary, unattributed changes and reverts. No subprocess per
 * conversation_update: watcher events only tail the JSONL.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitError, GitRunner } from './git-runner';
import { RepoInfo, RepoResolver } from './repo';
import { SessionLedger, LedgerEdit, LedgerTurn } from './ledger';
import { listSubagentFiles } from './sources';
import { parseUnifiedDiff, renderPatch } from './diff-parse';
import { ReviewStore, StoredCheckpoint, compactApprovals, toWire } from './store';
import { summarizeTurn } from './summarize';
import { addedLines, removedLines, toReviewHunk } from './analyze';
import { classifyChangedFile, maxRiskLevel } from '../herald/danger';
import { REVIEW_LIMITS } from './protocol';
import { NetViewBuilder } from './net-view';
import { snapshotTree } from './snapshot';
import type {
  ReviewEdit,
  ReviewFileChange,
  ReviewGetEditsResponse,
  ReviewGetFileRequest,
  ReviewGetFileResponse,
  ReviewGetRequest,
  ReviewGetResponse,
  ReviewMarkResponse,
  ReviewRiskFlag,
  ReviewRiskLevel,
  ReviewSummary,
  ReviewTurn,
} from './protocol';
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
  store?: ReviewStore;
  /** GLOBAL broadcast to every subscribed client (never session-scoped). */
  broadcast?: (type: string, payload: unknown) => void;
  /** Push to one connection. */
  sendToClient?: (clientId: string, type: string, payload: unknown) => boolean;
  /** Friendly display name for a session (defaults to its id). */
  sessionName?: (sessionId: string) => string;
  /** The session is working right now (defaults to !isWaitingForInput for live sessions). */
  isWorking?: (sessionId: string) => boolean;
  now?: () => number;
  /** Never reviewed (scratch space). Default: os.tmpdir(), /tmp, /var/tmp. */
  excludeDirs?: string[];
  /** Event debounce / summary throttle (tests shorten them). */
  debounceMs?: number;
  throttleMs?: number;
}

/** A session's ledger + checkpoint, joined (what every view is built from). */
export interface SessionContext {
  sessionId: string;
  session: TmuxSession;
  led: SessionLedger;
  cp: StoredCheckpoint;
  working: boolean;
}

const MAX_LEDGERS = 24;
const HOME = os.homedir();
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
  readonly store: ReviewStore;
  private ledgers = new Map<string, SessionLedger>();
  private locks = new Map<string, Promise<unknown>>();
  protected disposed = false;
  private ready: Promise<void>;
  /** Summary version per session (monotonic; bumps on any change). */
  private versions = new Map<string, number>();
  /** Last ledger version / checkpoint stamp folded into `versions`. */
  private seenStamp = new Map<string, string>();
  /** Last broadcast summary (sans version) per session: only send on change. */
  private lastSent = new Map<string, string>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private throttleTimers = new Map<string, NodeJS.Timeout>();
  private lastBroadcastAt = new Map<string, number>();
  private debounceMs: number;
  private throttleMs: number;
  readonly net: NetViewBuilder;
  /** Sessions whose baseline snapshot was already attempted. */
  private baselineTried = new Set<string>();
  /** Unattributed changes found at the last scan (turn end with Bash / files view). */
  private unattributedCache = new Map<
    string,
    { count: number; risks: Array<ReviewRiskFlag & { path: string }>; stamp: string; through: number }
  >();
  /** Turn ids already scanned for Bash-made changes. */
  private scannedTurns = new Map<string, string>();
  /** Short memo of files views (recompute at most every 2 s). */
  private filesMemo = new Map<string, { at: number; value: Promise<Awaited<ReturnType<NetViewBuilder['build']>>> }>();

  constructor(deps: ReviewServiceDeps) {
    this.deps = deps;
    this.now = deps.now || Date.now;
    this.runner = deps.runner || new GitRunner({ enabled: deps.gitEnabled });
    this.repos = new RepoResolver(this.runner, this.now);
    this.store = deps.store || new ReviewStore(undefined, 1000, this.now);
    this.debounceMs = deps.debounceMs ?? 300;
    this.throttleMs = deps.throttleMs ?? 1000;
    this.ready = this.store.loaded ? Promise.resolve() : this.store.load().catch(() => undefined);
    this.net = new NetViewBuilder({
      runner: this.runner,
      repos: this.repos,
      gitEnabled: () => this.deps.gitEnabled(),
      now: () => this.now(),
      displayPath: (a, p) => this.displayPath(a, p),
      isOutsideProject: (a, p) => this.isOutsideProject(a, p),
      isExcludedPath: (a) => this.isExcludedPath(a),
      alsoChangedBy: (id, a, since) => this.alsoChangedBy(id, a, since),
    });
  }

  /** Resolves once persisted checkpoints are loaded. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  // ------------------------------------------------------------------ events

  /** Hook watcher events (conversation-update / status-change). */
  attach(emitter: { on(ev: string, fn: (data: { sessionId?: string }) => void): unknown }): void {
    emitter.on('conversation-update', (d) => d?.sessionId && this.onActivity(d.sessionId));
    emitter.on('status-change', (d) => d?.sessionId && this.onActivity(d.sessionId, true));
  }

  /** Watcher activity: tail the transcript (debounced), never a subprocess. */
  onActivity(sessionId: string, statusChange = false): void {
    if (this.disposed) return;
    const t = this.debounceTimers.get(sessionId);
    if (t) clearTimeout(t);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(sessionId);
      void this.refresh(sessionId, statusChange).catch((err) =>
        console.error(`Review: refresh of ${sessionId} failed:`, err)
      );
    }, this.debounceMs);
    timer.unref?.();
    this.debounceTimers.set(sessionId, timer);
  }

  /** Re-read a session and broadcast its summary when it changed. */
  async refresh(sessionId: string, statusChange = false): Promise<ReviewSummary | null> {
    const ctx = await this.context(sessionId);
    if (!ctx) return null;
    this.onLedgerChanges(ctx);
    const summary = this.summaryFor(ctx);
    this.scheduleBroadcast(summary);
    if (statusChange && !ctx.working) this.maybeScanTurnEnd(ctx);
    return summary;
  }

  /**
   * A turn that ran Bash just ended: one bounded net diff per repo to find
   * changes no transcript claims (rm, sed -i, generators). Once per turn.
   */
  private maybeScanTurnEnd(ctx: SessionContext): void {
    const last = ctx.led.turns[ctx.led.turns.length - 1];
    if (!last || !last.usedBash || !this.deps.gitEnabled()) return;
    if (this.scannedTurns.get(ctx.sessionId) === last.id) return;
    this.scannedTurns.set(ctx.sessionId, last.id);
    void this.scanUnattributed(ctx).catch((err) =>
      console.error(`Review: turn-end scan of ${ctx.sessionId} failed:`, err instanceof Error ? err.message : err)
    );
  }

  private async scanUnattributed(ctx: SessionContext): Promise<void> {
    const fv = await this.filesView(ctx, 'since_checkpoint');
    this.noteUnattributed(ctx, fv.unattributed);
    const fresh = await this.context(ctx.sessionId);
    if (fresh) this.scheduleBroadcast(this.summaryFor(fresh));
  }

  private noteUnattributed(ctx: SessionContext, list: ReviewFileChange[]): void {
    const risks: Array<ReviewRiskFlag & { path: string }> = [];
    for (const f of list) for (const r of f.risks) risks.push({ ...r, path: f.path });
    const stamp = `${list.length}:${list.map((f) => `${f.path}+${f.additions}-${f.deletions}`).join(',')}`;
    const prev = this.unattributedCache.get(ctx.sessionId);
    this.unattributedCache.set(ctx.sessionId, { count: list.length, risks, stamp, through: ctx.cp.reviewedThrough });
    if (!prev || prev.stamp !== stamp) {
      this.bump(ctx.sessionId);
      this.onUnattributed(ctx, list);
    }
  }

  /** Hook: risk alerts for Bash-made changes (phase 4). */
  protected onUnattributed(_ctx: SessionContext, _list: ReviewFileChange[]): void {
    /* overridden */
  }

  /** Live edit stream hook (review_live), overridden in later phases. */
  protected onLedgerChanges(ctx: SessionContext): void {
    ctx.led.drainChanges();
  }

  private scheduleBroadcast(summary: ReviewSummary): void {
    if (!this.deps.broadcast) return;
    const { version: _v, ...rest } = summary;
    const key = JSON.stringify(rest);
    if (this.lastSent.get(summary.sessionId) === key) return;
    const id = summary.sessionId;
    const send = () => {
      this.throttleTimers.delete(id);
      const fresh = this.lastPending.get(id);
      if (!fresh) return;
      this.lastPending.delete(id);
      const { version: _v2, ...r2 } = fresh;
      this.lastSent.set(id, JSON.stringify(r2));
      this.lastBroadcastAt.set(id, this.now());
      this.deps.broadcast?.('review_summary', { summary: fresh });
    };
    this.lastPending.set(id, summary);
    if (this.throttleTimers.has(id)) return;
    const since = this.now() - (this.lastBroadcastAt.get(id) || 0);
    if (since >= this.throttleMs) send();
    else {
      const timer = setTimeout(send, this.throttleMs - since);
      timer.unref?.();
      this.throttleTimers.set(id, timer);
    }
  }
  private lastPending = new Map<string, ReviewSummary>();

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

  // ------------------------------------------------------------------ context

  isWorking(session: TmuxSession): boolean {
    if (session.inactive) return false;
    if (this.deps.isWorking) return this.deps.isWorking(session.id);
    return !session.isWaitingForInput;
  }

  sessionName(sessionId: string): string {
    return this.deps.sessionName?.(sessionId) || sessionId;
  }

  async context(sessionId: string): Promise<SessionContext | null> {
    await this.ready;
    const led = await this.getLedger(sessionId);
    const session = this.findSession(sessionId);
    if (!led || !session) return null;
    const cp = this.store.get(sessionId, led.projectPath);
    this.store.touch(sessionId, led.projectPath);
    this.onContext(sessionId, led, cp);
    return { sessionId, session, led, cp, working: this.isWorking(session) };
  }

  /** Hook for baselines (phase 2). */
  protected onContext(sessionId: string, led: SessionLedger, _cp: StoredCheckpoint): void {
    // Baseline: the first time a session is seen before it changed anything,
    // snapshot its project so "everything" can be diffed against it later.
    if (this.baselineTried.has(sessionId) || !this.deps.gitEnabled() || !led.projectPath) return;
    this.baselineTried.add(sessionId);
    if (this.store.has(sessionId, led.projectPath)) return;
    for (const e of led.edits.values()) if (!e.failed && !this.isExcludedPath(e.absPath)) return;
    void (async () => {
      const repo = await this.repos.resolve(led.projectPath).catch(() => null);
      if (!repo) return;
      const tree = await snapshotTree(this.runner, repo);
      await this.withLock(`cp:${sessionId}`, async () => {
        const cur = this.store.get(sessionId, led.projectPath);
        if (cur.baseline?.length) return;
        this.store.put(sessionId, { ...cur, baseline: [{ repoRoot: repo.root, tree }] });
      });
    })().catch((err) =>
      console.error(`Review: baseline for ${sessionId} failed:`, err instanceof Error ? err.message : err)
    );
  }

  /** Summary version: bumps whenever the ledger or checkpoint changed. */
  protected versionFor(ctx: SessionContext, extra = ''): number {
    const stamp = `${ctx.led.version}|${ctx.cp.reviewedThrough}|${ctx.cp.approvedTurnIds.length}|${ctx.cp.updatedAt}|${ctx.working ? 1 : 0}|${extra}`;
    const id = ctx.sessionId;
    let v = this.versions.get(id) || 0;
    if (this.seenStamp.get(id) !== stamp) {
      v = Math.max(v + 1, this.now());
      this.versions.set(id, v);
      this.seenStamp.set(id, stamp);
    }
    return v;
  }

  /** Force a version bump (revert, checkpoint move) and broadcast. */
  bump(sessionId: string): void {
    this.seenStamp.delete(sessionId);
  }

  displayPath(absPath: string, projectPath: string): string {
    if (projectPath) {
      const rel = path.relative(projectPath, absPath);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
    }
    if (absPath === HOME || absPath.startsWith(HOME + path.sep)) return `~${absPath.slice(HOME.length)}`;
    return absPath;
  }

  isOutsideProject(absPath: string, projectPath: string): boolean {
    if (!projectPath) return false;
    const rel = path.relative(projectPath, absPath);
    return rel.startsWith('..') || path.isAbsolute(rel);
  }

  /** Scratchpads and the OS temp dir are never reviewed. */
  isExcludedPath(absPath: string): boolean {
    const dirs = this.deps.excludeDirs ?? [os.tmpdir(), '/tmp', '/var/tmp'];
    return dirs.some((d) => absPath.startsWith(d + path.sep)) || /\/scratchpad(\/|$)/.test(absPath);
  }

  /** Completed, non-failed, not excluded. */
  protected countable(e: LedgerEdit): boolean {
    return !e.pending && !e.failed && !this.isExcludedPath(e.absPath);
  }

  isUnreviewed(e: LedgerEdit, cp: StoredCheckpoint): boolean {
    return e.at > cp.reviewedThrough && !cp.approvedTurnIds.includes(e.turnId);
  }

  turnEndedAt(t: LedgerTurn, ctx: SessionContext, isLast: boolean): number | null {
    if (t.closedAt !== null) return t.closedAt;
    if (isLast && ctx.working) return null;
    return t.lastEntryAt;
  }

  /** Other sessions (cached ledgers) that edited `absPath` after `since`. */
  protected alsoChangedBy(sessionId: string, absPath: string, since: number): string[] {
    const out: string[] = [];
    for (const [id, led] of this.ledgers) {
      if (id === sessionId) continue;
      for (const e of led.edits.values()) {
        if (e.absPath === absPath && !e.failed && !e.pending && e.at > since) {
          out.push(this.sessionName(id));
          break;
        }
      }
    }
    return out;
  }

  /** Risk flags for a file from transcript edits. */
  protected transcriptRisks(
    ctx: SessionContext,
    absPath: string,
    edits: LedgerEdit[],
    since: number
  ): ReviewRiskFlag[] {
    const hunks = edits.flatMap((e) => e.hunks);
    let additions = 0;
    let deletions = 0;
    for (const e of edits) {
      additions += e.additions;
      deletions += e.deletions;
    }
    const created = edits.some((e) => e.kind === 'create');
    return classifyChangedFile(
      absPath,
      this.displayPath(absPath, ctx.led.projectPath).replace(/^~\//, ''),
      {
        status: created ? 'added' : 'modified',
        additions,
        deletions,
        outsideProject: this.isOutsideProject(absPath, ctx.led.projectPath),
        alsoChangedBy: this.alsoChangedBy(ctx.sessionId, absPath, since),
        removedLines: removedLines(hunks),
      },
      addedLines(hunks)
    );
  }

  // ------------------------------------------------------------------ summary

  summaryFor(ctx: SessionContext): ReviewSummary {
    const { led, cp } = ctx;
    const unreviewedByFile = new Map<string, LedgerEdit[]>();
    const unreviewedTurns = new Set<string>();
    const allFiles = new Set<string>();
    const turnsWithEdits = new Set<string>();
    let adds = 0;
    let dels = 0;
    let lastChangeAt: number | null = null;
    for (const e of led.edits.values()) {
      if (!this.countable(e)) continue;
      allFiles.add(e.absPath);
      turnsWithEdits.add(e.turnId);
      if (lastChangeAt === null || e.at > lastChangeAt) lastChangeAt = e.at;
      if (!this.isUnreviewed(e, cp)) continue;
      const list = unreviewedByFile.get(e.absPath) || [];
      list.push(e);
      unreviewedByFile.set(e.absPath, list);
      unreviewedTurns.add(e.turnId);
      adds += e.additions;
      dels += e.deletions;
    }
    const risks: Array<ReviewRiskFlag & { path: string }> = [];
    for (const [abs, edits] of unreviewedByFile) {
      for (const f of this.transcriptRisks(ctx, abs, edits, cp.reviewedThrough)) {
        risks.push({ ...f, path: this.displayPath(abs, led.projectPath) });
      }
    }
    const extra = this.extraSummary(ctx);
    for (const r of extra.risks) risks.push(r);
    const rank = { high: 0, medium: 1, low: 2 } as const;
    risks.sort((a, b) => rank[a.level] - rank[b.level]);
    const last = led.turns[led.turns.length - 1];
    const live =
      !!last &&
      this.turnEndedAt(last, ctx, true) === null &&
      last.editIds.some((id) => !led.edits.get(id)?.failed);
    const repo = this.repos.peek(led.projectPath || '/');
    return {
      sessionId: ctx.sessionId,
      version: this.versionFor(ctx, extra.stamp),
      unreviewedFiles: unreviewedByFile.size + extra.files,
      unreviewedTurns: unreviewedTurns.size,
      unreviewedAdditions: adds,
      unreviewedDeletions: dels,
      totalFiles: allFiles.size,
      totalTurns: turnsWithEdits.size,
      riskLevel: maxRiskLevel(risks.filter((r) => r.level !== 'low')) ?? (risks.length ? 'low' : null),
      topRisks: risks.slice(0, 3),
      lastChangeAt,
      live,
      reviewedThrough: cp.reviewedThrough,
      mode: repo && this.deps.gitEnabled() ? 'git' : 'transcript',
    };
  }

  /** Unattributed (Bash-made) changes folded into the summary (phase 2). */
  protected extraSummary(ctx: SessionContext): {
    files: number;
    risks: Array<ReviewRiskFlag & { path: string }>;
    stamp: string;
  } {
    const u = this.unattributedCache.get(ctx.sessionId);
    // A scan from before the checkpoint last moved is stale.
    if (!u || u.through !== ctx.cp.reviewedThrough) return { files: 0, risks: [], stamp: '' };
    return { files: u.count, risks: u.risks, stamp: u.stamp };
  }

  async summary(sessionId: string): Promise<ReviewSummary | null> {
    const ctx = await this.context(sessionId);
    if (!ctx) return null;
    if (this.deps.gitEnabled() && ctx.led.projectPath && this.repos.peek(ctx.led.projectPath) === undefined) {
      // First look at this project: learn whether it is a repo (cached afterwards).
      await this.repos.resolve(ctx.led.projectPath).catch(() => null);
    }
    return this.summaryFor(ctx);
  }

  /** Every live session's summary (sequential: one ledger build at a time). */
  async summaryList(): Promise<ReviewSummary[]> {
    const out: ReviewSummary[] = [];
    for (const s of this.deps.watcher.getSessions()) {
      if (s.inactive) continue;
      try {
        const sum = await this.summary(s.id);
        if (sum) out.push(sum);
      } catch (err) {
        console.error(`Review: summary for ${s.id} failed:`, err);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ turns

  toReviewEdit(e: LedgerEdit, projectPath: string, risks?: ReviewRiskFlag[]): ReviewEdit {
    return {
      id: e.id,
      turnId: e.turnId,
      tool: e.tool,
      path: this.displayPath(e.absPath, projectPath),
      absPath: e.absPath,
      kind: e.kind,
      at: e.at,
      additions: e.failed ? 0 : e.additions,
      deletions: e.failed ? 0 : e.deletions,
      hunks: e.hunks.map((h, i) => toReviewHunk(`${e.id}#${i}`, h)),
      ...(e.patchUnavailable ? { patchUnavailable: true } : {}),
      risks: risks ?? [],
      ...(e.pending ? { pending: true } : {}),
      ...(e.failed ? { failed: true } : {}),
    };
  }

  /** Edit with its own (single-edit) risk flags. */
  protected reviewEditWithRisks(ctx: SessionContext, e: LedgerEdit): ReviewEdit {
    const risks = e.failed || e.pending ? [] : this.transcriptRisks(ctx, e.absPath, [e], ctx.cp.reviewedThrough);
    return this.toReviewEdit(e, ctx.led.projectPath, risks);
  }

  buildTurn(ctx: SessionContext, t: LedgerTurn, isLast: boolean): ReviewTurn {
    const { led, cp } = ctx;
    const files = new Map<string, LedgerEdit[]>();
    let additions = 0;
    let deletions = 0;
    let unreviewed = false;
    for (const id of t.editIds) {
      const e = led.edits.get(id);
      if (!e || !this.countable(e)) continue;
      const list = files.get(e.absPath) || [];
      list.push(e);
      files.set(e.absPath, list);
      additions += e.additions;
      deletions += e.deletions;
      if (this.isUnreviewed(e, cp)) unreviewed = true;
    }
    const endedAt = this.turnEndedAt(t, ctx, isLast);
    const fileList = Array.from(files.keys()).map((p) => this.displayPath(p, led.projectPath));
    const sum = summarizeTurn({
      reply: t.lastAssistantText,
      prompt: t.prompt,
      files: fileList,
      inProgress: endedAt === null,
      additions,
      deletions,
    });
    let riskLevel: ReviewRiskLevel | null = null;
    for (const [abs, edits] of files) {
      const lvl = maxRiskLevel(this.transcriptRisks(ctx, abs, edits, cp.reviewedThrough));
      if (lvl && (riskLevel === null || ['high', 'medium', 'low'].indexOf(lvl) < ['high', 'medium', 'low'].indexOf(riskLevel)))
        riskLevel = lvl;
    }
    const polished = this.polishedGist(t, sum.gist);
    const gist = polished ?? sum.gist;
    return {
      id: t.id,
      index: t.index,
      startedAt: t.startedAt,
      endedAt,
      prompt: t.prompt,
      gist,
      summary: polished ? `${gist}${sum.summary.slice(sum.gist.length)}` : sum.summary,
      summarySource: polished ? 'llm' : sum.summarySource,
      fileCount: files.size,
      additions,
      deletions,
      riskLevel,
      approved: cp.approvedTurnIds.includes(t.id),
      unreviewed,
      editIds: t.editIds.slice(),
    };
  }

  /** Cached LLM gist for a turn (phase 4). */
  protected polishedGist(_t: LedgerTurn, _freeGist: string): string | null {
    return null;
  }

  /** Turns in scope, oldest first. */
  turnsInScope(ctx: SessionContext, scope: 'since_checkpoint' | 'all', turnId?: string): LedgerTurn[] {
    const { led, cp } = ctx;
    const last = led.turns[led.turns.length - 1];
    return led.turns.filter((t) => {
      if (turnId) return t.id === turnId;
      const edits = t.editIds.map((id) => led.edits.get(id)).filter((e): e is LedgerEdit => !!e);
      if (edits.length === 0) return false;
      if (scope === 'all') return true;
      if (t === last && edits.some((e) => e.pending)) return true;
      return edits.some((e) => this.countable(e) && this.isUnreviewed(e, cp));
    });
  }

  async get(req: ReviewGetRequest): Promise<ReviewGetResponse> {
    const ctx = await this.context(req.sessionId);
    if (!ctx) throw new ReviewServiceError('unknown_session', `Unknown session ${req.sessionId}`);
    const computedAt = this.now();
    const scope = req.scope === 'all' ? 'all' : 'since_checkpoint';
    const view = req.view === 'files' ? 'files' : 'turns';
    if (req.turnId && !ctx.led.getTurn(req.turnId))
      throw new ReviewServiceError('not_found', `Unknown turn ${req.turnId}`);
    const turnsAll = this.turnsInScope(ctx, scope, req.turnId);
    const lastTurn = ctx.led.turns[ctx.led.turns.length - 1];
    const omitted: { turns?: number; edits?: number; files?: number } = {};
    const turns = turnsAll.map((t) => this.buildTurn(ctx, t, t === lastTurn));

    let edits: ReviewEdit[] = [];
    let files: ReviewGetResponse['files'] = [];
    let unattributed: ReviewGetResponse['unattributed'] = [];
    let repos: ReviewGetResponse['repos'] = [];
    if (view === 'turns') {
      const all: LedgerEdit[] = [];
      for (const t of turnsAll) {
        for (const id of t.editIds) {
          const e = ctx.led.edits.get(id);
          if (!e || this.isExcludedPath(e.absPath)) continue;
          if (scope === 'since_checkpoint' && !req.turnId && !e.pending && !this.isUnreviewed(e, ctx.cp))
            continue;
          all.push(e);
        }
      }
      all.sort((a, b) => a.at - b.at);
      let picked = all;
      if (picked.length > REVIEW_LIMITS.maxEditsPerView) {
        omitted.edits = picked.length - REVIEW_LIMITS.maxEditsPerView;
        picked = picked.slice(-REVIEW_LIMITS.maxEditsPerView);
      }
      // Byte budget: keep the newest edits whole, drop the oldest beyond it.
      const budget = REVIEW_LIMITS.maxResponseBytes - 64 * 1024;
      let bytes = JSON.stringify(turns).length;
      const kept: ReviewEdit[] = [];
      for (let i = picked.length - 1; i >= 0; i--) {
        const re = this.reviewEditWithRisks(ctx, picked[i]);
        const size = JSON.stringify(re).length;
        if (bytes + size > budget) {
          omitted.edits = (omitted.edits || 0) + i + 1;
          break;
        }
        bytes += size;
        kept.push(re);
      }
      edits = kept.reverse();
      repos = await this.reposFor(ctx, Array.from(new Set(edits.map((e) => e.absPath))));
    } else {
      const fv = await this.filesView(ctx, scope, req.turnId);
      files = fv.files;
      unattributed = fv.unattributed;
      repos = fv.repos;
      if (fv.omittedFiles) omitted.files = fv.omittedFiles;
    }
    return {
      sessionId: req.sessionId,
      scope,
      view,
      ...(req.turnId ? { turnId: req.turnId } : {}),
      summary: this.summaryFor(ctx),
      checkpoint: toWire(ctx.cp),
      turns,
      edits,
      files,
      unattributed,
      repos,
      ...(Object.keys(omitted).length ? { omitted } : {}),
      computedAt,
    };
  }

  /** Repos for the session's project + touched dirs (<= 4). */
  protected async reposFor(ctx: SessionContext, absPaths: string[]): Promise<ReviewGetResponse['repos']> {
    const { repos } = await this.net.sessionRepos(ctx.led.projectPath, absPaths);
    return repos.map((r) => ({
      root: r.root,
      worktree: r.worktree,
      branch: r.branch,
      head: r.head,
      ...(this.runner.isDegraded(r.root) ? { degraded: 'timeout' as const } : {}),
    }));
  }

  /** In-scope countable edits, oldest first. */
  protected scopeEdits(ctx: SessionContext, scope: 'since_checkpoint' | 'all', turnId?: string): LedgerEdit[] {
    const out: LedgerEdit[] = [];
    for (const e of ctx.led.edits.values()) {
      if (!this.countable(e)) continue;
      if (turnId) {
        if (e.turnId !== turnId) continue;
      } else if (scope === 'since_checkpoint' && !this.isUnreviewed(e, ctx.cp)) continue;
      out.push(e);
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /** Net "by file" view (git where possible, transcript otherwise). */
  protected async filesView(
    ctx: SessionContext,
    scope: 'since_checkpoint' | 'all',
    turnId?: string,
    focusAbsPath?: string
  ): Promise<Awaited<ReturnType<NetViewBuilder['build']>>> {
    const key = `${ctx.sessionId}|${scope}|${turnId || ''}|${focusAbsPath || ''}|${ctx.led.version}|${ctx.cp.reviewedThrough}|${ctx.cp.approvedTurnIds.join(',')}`;
    const hit = this.filesMemo.get(key);
    if (hit && this.now() - hit.at < 2000) return hit.value;
    const value = this.net.build({
      sessionId: ctx.sessionId,
      projectPath: ctx.led.projectPath,
      scope,
      cp: ctx.cp,
      edits: this.scopeEdits(ctx, scope, turnId),
      isUnreviewed: (e) => this.isUnreviewed(e, ctx.cp),
      ...(focusAbsPath ? { focusAbsPath } : {}),
    });
    this.filesMemo.set(key, { at: this.now(), value });
    if (this.filesMemo.size > 64) {
      const k = this.filesMemo.keys().next().value;
      if (k !== undefined) this.filesMemo.delete(k);
    }
    value.catch(() => this.filesMemo.delete(key));
    const out = await value;
    if (scope === 'since_checkpoint' && !turnId && !focusAbsPath) this.noteUnattributed(ctx, out.unattributed);
    return out;
  }

  /** review_get_file: one file with all its hunks (capped at maxFileHunkLines). */
  async getFile(req: ReviewGetFileRequest): Promise<ReviewGetFileResponse> {
    const ctx = await this.context(req.sessionId);
    if (!ctx) throw new ReviewServiceError('unknown_session', `Unknown session ${req.sessionId}`);
    const abs = path.resolve(req.absPath);
    const scope = req.scope === 'all' ? 'all' : 'since_checkpoint';
    if (req.turnId && !ctx.led.getTurn(req.turnId))
      throw new ReviewServiceError('not_found', `Unknown turn ${req.turnId}`);
    const fv = await this.filesView(ctx, scope, req.turnId, abs);
    const file = fv.files.find((f) => f.absPath === abs) || fv.unattributed.find((f) => f.absPath === abs);
    if (!file) throw new ReviewServiceError('not_found', `No changes to ${req.absPath} in scope`);
    return { file, truncated: !!fv.focusTruncated };
  }

  /** review_get_edits: edits by tool_use id (inline chips). */
  async getEdits(sessionId: string, editIds: string[]): Promise<ReviewGetEditsResponse> {
    const ctx = await this.context(sessionId);
    if (!ctx) throw new ReviewServiceError('unknown_session', `Unknown session ${sessionId}`);
    const edits: ReviewEdit[] = [];
    const missing: string[] = [];
    for (const id of editIds.slice(0, REVIEW_LIMITS.maxGetEdits)) {
      const e = ctx.led.edits.get(id);
      if (e && !this.isExcludedPath(e.absPath)) edits.push(this.reviewEditWithRisks(ctx, e));
      else missing.push(id);
    }
    return { edits, missing };
  }

  // ------------------------------------------------------------------ checkpoint

  async markReviewed(sessionId: string, through: number, device?: string): Promise<ReviewMarkResponse> {
    if (!Number.isFinite(through) || through < 0)
      throw new ReviewServiceError('bad_request', 'through must be a timestamp');
    const ctx = await this.context(sessionId);
    if (!ctx) throw new ReviewServiceError('unknown_session', `Unknown session ${sessionId}`);
    return this.withLock(`cp:${sessionId}`, async () => {
      const cur = this.store.get(sessionId, ctx.led.projectPath);
      const next: StoredCheckpoint = {
        ...cur,
        reviewedThrough: Math.max(cur.reviewedThrough, Math.min(through, this.now())),
        updatedAt: this.now(),
        updatedBy: device ? String(device).slice(0, 80) : null,
      };
      const moved = next.reviewedThrough !== cur.reviewedThrough;
      let cp = compactApprovals(next, this.turnEdgeTimes(ctx.led));
      if (moved) cp = { ...cp, snapshots: await this.takeSnapshots(ctx, cp) };
      return this.commitCheckpoint(ctx, cp, moved);
    });
  }

  async approveTurn(sessionId: string, turnId: string, approved: boolean, device?: string): Promise<ReviewMarkResponse> {
    const ctx = await this.context(sessionId);
    if (!ctx) throw new ReviewServiceError('unknown_session', `Unknown session ${sessionId}`);
    if (!ctx.led.getTurn(turnId)) throw new ReviewServiceError('not_found', `Unknown turn ${turnId}`);
    return this.withLock(`cp:${sessionId}`, async () => {
      const cur = this.store.get(sessionId, ctx.led.projectPath);
      const ids = cur.approvedTurnIds.filter((id) => id !== turnId);
      if (approved) ids.push(turnId);
      const next: StoredCheckpoint = {
        ...cur,
        approvedTurnIds: ids,
        updatedAt: this.now(),
        updatedBy: device ? String(device).slice(0, 80) : null,
      };
      let cp = compactApprovals(next, this.turnEdgeTimes(ctx.led));
      const moved = cp.reviewedThrough !== cur.reviewedThrough;
      if (moved) cp = { ...cp, snapshots: await this.takeSnapshots(ctx, cp) };
      return this.commitCheckpoint(ctx, cp, moved);
    });
  }

  private commitCheckpoint(ctx: SessionContext, cp: StoredCheckpoint, moved: boolean): ReviewMarkResponse {
    this.store.put(ctx.sessionId, cp);
    const fresh: SessionContext = { ...ctx, cp: this.store.get(ctx.sessionId, ctx.led.projectPath) };
    this.bump(ctx.sessionId);
    const summary = this.summaryFor(fresh);
    this.scheduleBroadcast(summary);
    this.onCheckpointMoved(fresh, moved);
    return { checkpoint: toWire(fresh.cp), summary };
  }

  /** Hook: resolve Herald review alerts etc. (phase 4). */
  protected onCheckpointMoved(_ctx: SessionContext, _moved: boolean): void {
    /* overridden */
  }

  /** Working-tree snapshot trees for the session's repos (git only). */
  protected async takeSnapshots(ctx: SessionContext, cp: StoredCheckpoint): Promise<StoredCheckpoint['snapshots']> {
    if (!this.deps.gitEnabled()) return cp.snapshots;
    const touched = new Set<string>();
    for (const e of ctx.led.edits.values()) if (this.countable(e)) touched.add(e.absPath);
    try {
      const snaps = await this.net.snapshots(ctx.led.projectPath, Array.from(touched));
      return snaps.length ? snaps : [];
    } catch (err) {
      console.error('Review: snapshot failed:', err instanceof Error ? err.message : err);
      return [];
    }
  }

  /** Per turn (oldest first): last countable edit time. */
  protected turnEdgeTimes(
    led: SessionLedger
  ): Array<{ id: string; lastEditAt: number | null; open?: boolean }> {
    return led.turns.map((t) => {
      let last: number | null = null;
      let open = false;
      for (const id of t.editIds) {
        const e = led.edits.get(id);
        if (!e || e.failed || this.isExcludedPath(e.absPath)) continue;
        if (e.pending) open = true;
        else if (last === null || e.at > last) last = e.at;
      }
      return { id: t.id, lastEditAt: last, ...(open ? { open: true } : {}) };
    });
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
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    for (const t of this.throttleTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
    this.throttleTimers.clear();
    this.store.flushSyncOnShutdown();
  }
}
