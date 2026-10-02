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
import { clipWords, summarizeTurn } from './summarize';
import { fnv1a, formatAgo } from '../herald/text';
import { addedLines, removedLines, toReviewHunk } from './analyze';
import { classifyChangedFile, maxRiskLevel } from '../herald/danger';
import { REVIEW_LIMITS } from './protocol';
import { NetViewBuilder } from './net-view';
import { objectsExist, snapshotTree } from './snapshot';
import { RevertManager, RevertError, BackupMeta } from './revert';
import { reviewStateDir } from './store';
import { isDeniedPath } from '../herald/knowledge/redact';
import { isSandbox } from '../sandbox';
import type { AuditEntry, AuditOrigin } from '../audit-log';
import type { ParsedHunk } from './diff-parse';
import type {
  ReviewAskRequest,
  ReviewAskResponse,
  ReviewEdit,
  ReviewRevertBlockCode,
  ReviewRevertPreviewRequest,
  ReviewRevertPreviewResponse,
  ReviewRevertRequest,
  ReviewRevertResponse,
  ReviewRevertUndoResponse,
  ReviewRevertedEvent,
  ReviewWatchResponse,
  ReviewFileChange,
  ReviewGetEditsResponse,
  ReviewGetFileRequest,
  ReviewGetFileResponse,
  ReviewGetRequest,
  ReviewGetResponse,
  ReviewMarkResponse,
  ReviewPolishResponse,
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
  /** Audit log sink (revert / undo / ask). */
  audit?: (entry: AuditEntry) => void;
  /** Type text straight into a session (ask-why without Herald, revert notes). */
  sendDirect?: (sessionId: string, text: string) => Promise<boolean>;
  /** A choice prompt is on the session's screen (throws when unreadable). */
  hasLiveChoice?: (sessionId: string) => Promise<boolean>;
  /** Extra writable roots (config.allowedPaths). */
  allowedPaths?: () => string[];
  /** Revert backups (default ~/.companion/review/backups). */
  backupDir?: string;
  /** Risk-alert coalesce window (default 20 s). */
  alertWindowMs?: number;
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

/** Summary identity without its version (broadcast only on real change). */
function summaryKey(s: ReviewSummary): string {
  return JSON.stringify({ ...s, version: 0 });
}

/** What Code Review needs from Herald (late-bound: Herald is built first). */
export interface ReviewHeraldLink {
  readonly featureEnabled: boolean;
  relayAsk(r: {
    sessionId: string;
    sessionName: string;
    prompt: string;
    userText: string;
    clientId?: string;
  }): Promise<{ askId: string }>;
  addReviewAlert?(a: {
    key: string;
    sessionId: string;
    sessionName: string;
    headline: string;
    level: 'high' | 'medium';
    kinds: string[];
    paths: string[];
  }): void;
  resolveReviewAlerts?(sessionId: string): void;
  polishGists?(
    items: Array<{ id: string; prompt: string; reply: string; files: string[]; gist: string }>
  ): Promise<Map<string, string>>;
}

interface AlertItem {
  path: string;
  kind: ReviewRiskFlag['kind'];
  reason: string;
}

const KIND_NOUN: Partial<Record<ReviewRiskFlag['kind'], string>> = {
  migration: 'a database migration',
  ci: 'a CI workflow',
  env: 'an environment file',
  secrets: 'a key or credentials file',
  agent_config: 'agent or git hook config',
  permissions: 'file permissions',
  security: 'auth or security code',
  deleted: 'a file',
};
const KIND_ORDER: ReviewRiskFlag['kind'][] = [
  'secrets', 'env', 'migration', 'ci', 'agent_config', 'permissions', 'security', 'deleted',
];

/** Deterministic risk-alert headline ("Out4 changed a CI workflow: deploy.yml"). PURE. */
export function alertHeadline(name: string, items: AlertItem[]): string {
  const rank = (k: ReviewRiskFlag['kind']) => {
    const i = KIND_ORDER.indexOf(k);
    return i === -1 ? 99 : i;
  };
  const sorted = items.slice().sort((a, b) => rank(a.kind) - rank(b.kind));
  const paths = Array.from(new Set(sorted.map((i) => i.path)));
  // Deleted paths, the riskiest first (a deleted migration outranks a deleted helper).
  const pathRank = (p: string) => Math.min(...sorted.filter((i) => i.path === p && i.kind !== 'deleted').map((i) => rank(i.kind)), 98);
  const deleted = Array.from(new Set(sorted.filter((i) => i.kind === 'deleted').map((i) => i.path))).sort(
    (a, b) => pathRank(a) - pathRank(b)
  );
  if (deleted.length && deleted.length === paths.length) {
    const n = deleted.length;
    return n === 1
      ? `${name} deleted ${path.basename(deleted[0])}`
      : `${name} deleted ${n} files including ${deleted[0]}`;
  }
  if (paths.length === 1) {
    const first = sorted[0];
    const base = path.basename(first.path);
    if (first.kind === 'secrets' && /^adds/.test(first.reason)) return `${name} added what looks like a secret to ${base}`;
    if (first.kind === 'ci' && first.reason === 'deploy script') return `${name} changed the deploy script: ${base}`;
    return `${name} changed ${KIND_NOUN[first.kind] || first.reason}: ${base}`;
  }
  return `${name} made ${paths.length} risky changes including ${paths[0]}`;
}

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
  readonly reverts: RevertManager;
  private herald: ReviewHeraldLink | null = null;
  /** review_watch: connection -> sessions it watches live. */
  private watchers = new Map<string, Set<string>>();
  /** Risk alerts: last time each session|path|kind alerted (30 min dedupe). */
  private alertSeen = new Map<string, number>();
  /** Risk alerts waiting out the coalesce window, per session. */
  private alertPending = new Map<string, { items: AlertItem[]; timer: NodeJS.Timeout }>();
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
    this.reverts = new RevertManager({
      runner: this.runner,
      backupDir: deps.backupDir || path.join(reviewStateDir(), 'backups'),
      now: this.now,
    });
    this.net = new NetViewBuilder({
      runner: this.runner,
      repos: this.repos,
      gitEnabled: () => this.deps.gitEnabled(),
      now: () => this.now(),
      displayPath: (a, p) => this.displayPath(a, p),
      isOutsideProject: (a, p) => this.isOutsideProject(a, p),
      isExcludedPath: (a, p) => this.isExcludedPath(a, p),
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

  /** Bash-made changes with high risk raise alerts too. */
  protected onUnattributed(ctx: SessionContext, list: ReviewFileChange[]): void {
    const alerts: AlertItem[] = [];
    for (const f of list)
      for (const r of f.risks) if (r.level === 'high') alerts.push({ path: f.path, kind: r.kind, reason: r.reason });
    if (alerts.length) this.considerAlerts(ctx.sessionId, alerts);
  }

  /**
   * High-risk changes -> one Herald inbox item per session per coalesce window
   * (20 s), each session|path|kind at most once per 30 minutes.
   */
  private considerAlerts(sessionId: string, items: AlertItem[]): void {
    if (!this.herald?.addReviewAlert) return;
    const now = this.now();
    const fresh: AlertItem[] = [];
    for (const it of items) {
      const k = `${sessionId}|${it.path}|${it.kind}`;
      const last = this.alertSeen.get(k);
      if (last !== undefined && now - last < 30 * 60 * 1000) continue;
      this.alertSeen.set(k, now);
      fresh.push(it);
    }
    if (this.alertSeen.size > 5000) {
      for (const [k, at] of this.alertSeen) if (now - at > 30 * 60 * 1000) this.alertSeen.delete(k);
    }
    if (!fresh.length) return;
    const pending = this.alertPending.get(sessionId);
    if (pending) {
      pending.items.push(...fresh);
      return;
    }
    const timer = setTimeout(() => this.flushAlerts(sessionId), this.deps.alertWindowMs ?? 20_000);
    timer.unref?.();
    this.alertPending.set(sessionId, { items: fresh, timer });
  }

  private flushAlerts(sessionId: string): void {
    const pending = this.alertPending.get(sessionId);
    this.alertPending.delete(sessionId);
    if (!pending || !pending.items.length || this.disposed) return;
    const name = this.sessionName(sessionId);
    const kinds = Array.from(new Set(pending.items.map((i) => i.kind)));
    const paths = Array.from(new Set(pending.items.map((i) => i.path)));
    this.herald?.addReviewAlert?.({
      key: `${sessionId}|${paths.slice().sort().join(',')}|${kinds.slice().sort().join(',')}`,
      sessionId,
      sessionName: name,
      headline: alertHeadline(name, pending.items),
      level: 'high',
      kinds,
      paths,
    });
  }

  /** Live edit stream (review_live) + risk alerts for edits that just landed. */
  protected onLedgerChanges(ctx: SessionContext): void {
    const changes = ctx.led.drainChanges();
    if (!changes.length) return;
    const recent = this.now() - 10 * 60 * 1000;
    const alerts: AlertItem[] = [];
    for (const c of changes) {
      if (c.phase !== 'completed') continue;
      const e = ctx.led.edits.get(c.editId);
      if (!e || !this.countable(e) || e.at < recent || !this.isUnreviewed(e, ctx.cp)) continue;
      const display = this.displayPath(e.absPath, ctx.led.projectPath);
      for (const f of this.transcriptRisks(ctx, e.absPath, [e], ctx.cp.reviewedThrough))
        if (f.level === 'high') alerts.push({ path: display, kind: f.kind, reason: f.reason });
    }
    if (alerts.length) this.considerAlerts(ctx.sessionId, alerts);
    if (!this.deps.sendToClient) return;
    const clients: string[] = [];
    for (const [clientId, set] of this.watchers) if (set.has(ctx.sessionId)) clients.push(clientId);
    if (!clients.length) return;
    for (const c of changes) {
      const e = ctx.led.edits.get(c.editId);
      if (!e || e.excluded) continue;
      const payload = { sessionId: ctx.sessionId, phase: c.phase, edit: this.reviewEditWithRisks(ctx, e) };
      for (const id of clients) {
        if (!this.deps.sendToClient(id, 'review_live', payload)) this.dropClient(id);
      }
    }
  }

  setHerald(h: ReviewHeraldLink | null): void {
    this.herald = h;
  }

  // ------------------------------------------------------------------ live

  async watch(clientId: string, sessionId: string, live: boolean): Promise<ReviewWatchResponse> {
    const ctx = await this.context(sessionId);
    if (!ctx) throw new ReviewServiceError('unknown_session', `Unknown session ${sessionId}`);
    ctx.led.drainChanges();
    const set = this.watchers.get(clientId) || new Set<string>();
    if (live) {
      if (set.size >= 8 && !set.has(sessionId)) throw new ReviewServiceError('busy', 'Watching too many sessions');
      set.add(sessionId);
      this.watchers.set(clientId, set);
    } else {
      set.delete(sessionId);
      if (set.size === 0) this.watchers.delete(clientId);
    }
    return { watching: live, summary: this.summaryFor(ctx) };
  }

  /** Connection closed: forget its live watches and revert tokens. */
  dropClient(clientId: string): void {
    this.watchers.delete(clientId);
  }

  watcherCount(): number {
    return this.watchers.size;
  }

  private scheduleBroadcast(summary: ReviewSummary): void {
    if (!this.deps.broadcast) return;
    const key = summaryKey(summary);
    if (this.lastSent.get(summary.sessionId) === key) return;
    const id = summary.sessionId;
    const send = () => {
      this.throttleTimers.delete(id);
      const fresh = this.lastPending.get(id);
      if (!fresh) return;
      this.lastPending.delete(id);
      this.lastSent.set(id, summaryKey(fresh));
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
        if (!led) {
          led = new SessionLedger(sessionId, projectPath);
          led.excludePath = (a) => this.isExcludedPath(a, projectPath);
        }
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
    for (const e of led.edits.values()) if (!e.failed && !e.excluded) return;
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
  /**
   * Scratch space is never reviewed: Claude Code scratchpads anywhere, and the
   * temp dirs unless the session's own project lives there.
   */
  isExcludedPath(absPath: string, projectPath = ''): boolean {
    if (/\/scratchpad(\/|$)/.test(absPath)) return true;
    if (projectPath && !this.isOutsideProject(absPath, projectPath)) return false;
    const dirs = this.deps.excludeDirs ?? [os.tmpdir(), '/tmp', '/var/tmp'];
    return dirs.some((d) => absPath.startsWith(d + path.sep));
  }

  /** Completed, non-failed, not excluded. */
  protected countable(e: LedgerEdit): boolean {
    return !e.pending && !e.failed && !e.excluded;
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

  private polishKey(t: LedgerTurn): string {
    return `${t.id}:${fnv1a(`${t.prompt}\u0001${t.lastAssistantText}`)}`;
  }

  /** Cached LLM gist for a turn (review_polish_summaries), if any. */
  protected polishedGist(t: LedgerTurn, _freeGist: string): string | null {
    return this.store.getPolish(this.polishKey(t))?.gist ?? null;
  }

  /**
   * review_polish_summaries: one batched Herald call for the uncached turns
   * (<= 20), cached by turn id + text hash. Finished turns only.
   */
  async polish(sessionId: string, turnIds: string[]): Promise<ReviewPolishResponse> {
    const ctx = await this.context(sessionId);
    if (!ctx) throw new ReviewServiceError('unknown_session', `Unknown session ${sessionId}`);
    const last = ctx.led.turns[ctx.led.turns.length - 1];
    const wanted = turnIds
      .slice(0, 20)
      .map((id) => ctx.led.getTurn(id))
      .filter((t): t is LedgerTurn => !!t);
    const todo = wanted.filter(
      (t) => !this.store.getPolish(this.polishKey(t)) && this.turnEndedAt(t, ctx, t === last) !== null
    );
    if (todo.length) {
      if (!this.herald?.featureEnabled || !this.herald.polishGists)
        throw new ReviewServiceError('herald_unavailable', 'Summaries need Herald');
      let gists: Map<string, string>;
      try {
        gists = await this.herald.polishGists(
          todo.map((t) => {
            const turn = this.buildTurn(ctx, t, t === last);
            const files = Array.from(
              new Set(t.editIds.map((id) => ctx.led.edits.get(id)).filter((e): e is LedgerEdit => !!e && this.countable(e)).map((e) => path.basename(e.absPath)))
            );
            return { id: t.id, prompt: t.prompt, reply: t.lastAssistantText, files, gist: turn.gist };
          })
        );
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'herald_unavailable') throw new ReviewServiceError(code, (err as Error).message);
        throw err;
      }
      for (const t of todo) {
        const g = gists.get(t.id);
        if (g) this.store.putPolish(this.polishKey(t), clipWords(g));
      }
      this.bump(sessionId);
      this.scheduleBroadcast(this.summaryFor(ctx));
    }
    return {
      turns: wanted.map((t) => {
        const turn = this.buildTurn(ctx, t, t === last);
        return { id: t.id, gist: turn.gist, summary: turn.summary };
      }),
    };
  }

  // ------------------------------------------------------------------ herald digest

  /** Grounded data for Herald's review_changes tool. */
  async digest(sessionId: string, scope: 'since_last_look' | 'last_turn' | 'all'): Promise<object | null> {
    const ctx = await this.context(sessionId);
    if (!ctx) return null;
    const now = this.now();
    const sc = scope === 'all' ? 'all' : 'since_checkpoint';
    let turnId: string | undefined;
    if (scope === 'last_turn') {
      for (let i = ctx.led.turns.length - 1; i >= 0 && !turnId; i--) {
        const t = ctx.led.turns[i];
        if (t.editIds.some((id) => { const e = ctx.led.edits.get(id); return !!e && this.countable(e); })) turnId = t.id;
      }
    }
    const lastTurn = ctx.led.turns[ctx.led.turns.length - 1];
    const turnsL = scope === 'last_turn' && !turnId ? [] : this.turnsInScope(ctx, sc, turnId);
    const turns = turnsL.slice(-8).map((t) => {
      const rt = this.buildTurn(ctx, t, t === lastTurn);
      return {
        n: rt.index,
        summary: rt.summary,
        ago: rt.endedAt === null ? 'in progress' : `${formatAgo(now - rt.endedAt)} ago`,
        risk: rt.riskLevel,
      };
    });
    let files: Array<{ path: string; plus: number; minus: number; status: string; risks: string[] }> = [];
    let more = 0;
    let unattributed = 0;
    if (turnsL.length) {
      const fv = await this.filesView(ctx, sc, turnId);
      const rank = (f: ReviewFileChange) => {
        const l = maxRiskLevel(f.risks);
        return l === 'high' ? 0 : l === 'medium' ? 1 : 2;
      };
      const sorted = fv.files.slice().sort((a, b) => rank(a) - rank(b) || b.heat - a.heat);
      files = sorted.slice(0, 12).map((f) => ({
        path: f.path,
        plus: f.additions,
        minus: f.deletions,
        status: f.status,
        risks: f.risks.map((r) => r.reason),
      }));
      more = Math.max(0, sorted.length - 12) + (fv.omittedFiles || 0);
      unattributed = scope === 'last_turn' ? 0 : fv.unattributed.length;
    }
    const sum = this.summaryFor(ctx);
    const notes: string[] = [];
    if (!turns.length) notes.push(scope === 'since_last_look' ? 'Nothing new since the user last looked.' : 'No code changes in this scope.');
    if (more) notes.push(`${more} more changed file${more === 1 ? ' is' : 's are'} not listed.`);
    if (unattributed)
      notes.push(`${unattributed} other file${unattributed === 1 ? '' : 's'} changed outside the session's edit tools (shell commands or other programs).`);
    return {
      session: this.sessionName(sessionId),
      scope,
      mode: sum.mode,
      unreviewed: {
        files: sum.unreviewedFiles,
        turns: sum.unreviewedTurns,
        additions: sum.unreviewedAdditions,
        deletions: sum.unreviewedDeletions,
      },
      turns,
      files,
      last_looked_ago: ctx.cp.reviewedThrough > 0 ? `${formatAgo(now - ctx.cp.updatedAt)} ago` : 'never',
      note: notes.join(' ') || undefined,
    };
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
          if (!e || e.excluded) continue;
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
      if (e && !e.excluded) edits.push(this.reviewEditWithRisks(ctx, e));
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
      // Approvals stay individual (never folded into reviewedThrough here) so
      // they can be taken back; only "mark all reviewed" compacts them.
      const ids = cur.approvedTurnIds.filter((id) => id !== turnId);
      if (approved) ids.push(turnId);
      const cp: StoredCheckpoint = {
        ...cur,
        approvedTurnIds: ids,
        updatedAt: this.now(),
        updatedBy: device ? String(device).slice(0, 80) : null,
      };
      const out = this.commitCheckpoint(ctx, cp, false);
      // Everything is now approved: the user looked, resolve their risk alerts.
      if (approved && out.summary.unreviewedTurns === 0 && out.summary.unreviewedFiles === 0)
        this.onCheckpointMoved({ ...ctx, cp: this.store.get(sessionId, ctx.led.projectPath) }, true);
      return out;
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

  /** The user looked: their Herald risk alerts for the session are resolved. */
  protected onCheckpointMoved(ctx: SessionContext, moved: boolean): void {
    if (!moved) return;
    const pending = this.alertPending.get(ctx.sessionId);
    if (pending) {
      clearTimeout(pending.timer);
      this.alertPending.delete(ctx.sessionId);
    }
    this.herald?.resolveReviewAlerts?.(ctx.sessionId);
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
        if (!e || e.failed || e.excluded) continue;
        if (e.pending) open = true;
        else if (last === null || e.at > last) last = e.at;
      }
      return { id: t.id, lastEditAt: last, ...(open ? { open: true } : {}) };
    });
  }

  // ------------------------------------------------------------------ hunks

  /**
   * Find a hunk by id: `<editId>#<n>` (transcript) or a git id from the files
   * view (`g...`). Returns the hunk, its file's edits and the owning edit.
   */
  async findHunk(
    ctx: SessionContext,
    absPath: string,
    hunkId: string,
    editId: string | undefined,
    scope: 'since_checkpoint' | 'all'
  ): Promise<{ hunk: ParsedHunk; edit: LedgerEdit | null; isCreate: boolean; file: ReviewFileChange | null } | null> {
    const m = hunkId.match(/^(.+)#(\d+)$/);
    if (m) {
      const e = ctx.led.edits.get(editId || m[1]);
      if (!e || e.absPath !== absPath || e.failed || e.pending) return null;
      const h = e.hunks[parseInt(m[2], 10)];
      if (!h) return null;
      const isCreate = e.kind === 'create' && h.oldLines === 0 && h.oldStart === 0;
      return { hunk: h, edit: e, isCreate, file: null };
    }
    if (!hunkId.startsWith('g')) return null;
    for (const sc of scope === 'all' ? (['all'] as const) : (['since_checkpoint', 'all'] as const)) {
      const fv = await this.filesView(ctx, sc, undefined, absPath);
      const file = fv.files.find((f) => f.absPath === absPath) || fv.unattributed.find((f) => f.absPath === absPath);
      const h = file?.hunks?.find((x) => x.id === hunkId);
      if (file && h) {
        if (h.clipped) return null;
        const edit = file.turnIds.length
          ? Array.from(ctx.led.edits.values()).find((e) => e.absPath === absPath && file.turnIds.includes(e.turnId)) || null
          : null;
        return {
          hunk: { oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: h.lines },
          edit,
          isCreate: file.status === 'added' && (file.hunks?.length ?? 0) === 1 && h.oldLines === 0,
          file,
        };
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ ask why

  /** The text sent to the session for "Ask why". */
  buildAskText(input: {
    path: string;
    hunk: ParsedHunk;
    turnIndex: number | null;
    gist: string | null;
    question?: string;
  }): string {
    const h = input.hunk;
    const start = h.newLines > 0 ? h.newStart : h.oldStart;
    const end = start + Math.max((h.newLines > 0 ? h.newLines : h.oldLines) - 1, 0);
    const where = `${input.path}:${start}-${end}`;
    const turn = input.turnIndex !== null ? ` (turn ${input.turnIndex}: "${(input.gist || '').replace(/"/g, "'")}")` : '';
    const body = h.lines.slice(0, 40).map((l) => (l.length > 300 ? l.slice(0, 300) : l));
    const fence = body.some((l) => l.includes('```')) ? '~~~~' : '```';
    let text = `Why did you make this change? (from Companion review)\n${where}${turn}\n${fence}diff\n${body.join('\n')}${h.lines.length > 40 ? '\n…' : ''}\n${fence}`;
    const q = (input.question || '').trim().slice(0, REVIEW_LIMITS.maxQuestionChars);
    if (q) text += `\n${q}`;
    return text;
  }

  async ask(req: ReviewAskRequest, clientId?: string): Promise<ReviewAskResponse> {
    const ctx = await this.context(req.sessionId);
    if (!ctx) throw new ReviewServiceError('unknown_session', `Unknown session ${req.sessionId}`);
    if (ctx.session.inactive) throw new ReviewServiceError('unavailable', 'The session is not running');
    const abs = path.resolve(req.absPath);
    const found = await this.findHunk(ctx, abs, req.hunkId, req.editId, 'all');
    if (!found) throw new ReviewServiceError('not_found', 'That change is no longer available');
    const turn = found.edit ? ctx.led.getTurn(found.edit.turnId) : undefined;
    const lastTurn = ctx.led.turns[ctx.led.turns.length - 1];
    const gist = turn ? this.buildTurn(ctx, turn, turn === lastTurn).gist : null;
    const sentText = this.buildAskText({
      path: this.displayPath(abs, ctx.led.projectPath),
      hunk: found.hunk,
      turnIndex: turn ? turn.index : null,
      gist,
      question: req.question,
    });
    const question = (req.question || '').trim().slice(0, REVIEW_LIMITS.maxQuestionChars);
    const herald = this.herald;
    if (herald && herald.featureEnabled) {
      let r: { askId: string };
      try {
        r = await herald.relayAsk({
          sessionId: req.sessionId,
          sessionName: this.sessionName(req.sessionId),
          prompt: sentText,
          userText: question || `Why did ${this.sessionName(req.sessionId)} change ${path.basename(abs)}?`,
          clientId,
        });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'session_waiting' || code === 'herald_unavailable' || code === 'unavailable')
          throw new ReviewServiceError(code, (err as Error).message);
        throw err;
      }
      this.auditAsk(req, 'herald', clientId);
      return { via: 'herald', askId: r.askId, sentText };
    }
    if (!this.deps.sendDirect) throw new ReviewServiceError('herald_unavailable', 'No way to reach the session');
    if (this.deps.hasLiveChoice) {
      let waiting: boolean;
      try {
        waiting = await this.deps.hasLiveChoice(req.sessionId);
      } catch {
        throw new ReviewServiceError('unavailable', "Could not read the session's screen");
      }
      if (waiting) throw new ReviewServiceError('session_waiting', 'The session is waiting on a choice; answer it first');
    }
    const ok = await this.deps.sendDirect(req.sessionId, sentText);
    if (!ok) throw new ReviewServiceError('unavailable', 'Could not send to the session');
    this.auditAsk(req, 'direct', clientId);
    return { via: 'direct', askId: null, sentText };
  }

  private origin(clientId?: string): AuditOrigin {
    return { addr: 'daemon', clientId: clientId || 'review', isLocal: true, tls: false, origin: null };
  }

  private auditAsk(req: ReviewAskRequest, via: string, clientId?: string): void {
    this.deps.audit?.({
      ts: this.now(),
      origin: this.origin(clientId),
      action: 'review_ask',
      payload: { session: req.sessionId, path: req.absPath, hunkId: req.hunkId, via },
      result: { ok: true },
      durationMs: 0,
    });
  }

  // ------------------------------------------------------------------ revert

  /** Allowed to write here: under the project, home or config.allowedPaths; never denied paths. */
  isWritable(absPath: string, projectPath: string): boolean {
    if (isDeniedPath(absPath)) return false;
    const roots = [projectPath, os.homedir(), ...(this.deps.allowedPaths?.() || [])].filter(Boolean);
    return roots.some((r) => {
      const rel = path.relative(path.resolve(r), absPath);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
  }

  /** Pending edit on the path, or one that completed in the last 5 s while working. */
  private editingNow(ctx: SessionContext, absPath: string): boolean {
    const now = this.now();
    for (const e of ctx.led.edits.values()) {
      if (e.absPath !== absPath) continue;
      if (e.pending) return true;
      if (ctx.working && now - e.at < 5000) return true;
    }
    return false;
  }

  async revertPreview(req: ReviewRevertPreviewRequest, clientId: string): Promise<ReviewRevertPreviewResponse> {
    const ctx = await this.context(req.sessionId);
    if (!ctx) throw new ReviewServiceError('unknown_session', `Unknown session ${req.sessionId}`);
    const t = req.target;
    if (!t || (t.kind !== 'hunk' && t.kind !== 'file') || typeof t.absPath !== 'string' || !path.isAbsolute(t.absPath))
      throw new ReviewServiceError('bad_request', 'target must be a hunk or file with an absolute path');
    if (t.kind === 'file' && t.to !== 'head' && t.to !== 'checkpoint')
      throw new ReviewServiceError('bad_request', "file target needs to: 'head' | 'checkpoint'");
    const abs = path.resolve(t.absPath);
    const display = this.displayPath(abs, ctx.led.projectPath);
    const base = {
      clientId,
      sessionId: req.sessionId,
      target: t,
      absPath: abs,
      path: display,
      repo: null as RepoInfo | null,
      risks: [] as ReviewRiskFlag[],
      sessionWorking: ctx.working,
    };
    const block = (code: ReviewRevertBlockCode, message: string) =>
      this.reverts.preview({ ...base, blocked: { code, message } });
    if (isSandbox()) return block('sandbox', 'reverts are disabled in the sandbox');
    if (!this.isWritable(abs, ctx.led.projectPath)) return block('outside_allowed', 'that path is outside the allowed folders');
    if (!this.deps.gitEnabled()) return block('git_disabled', 'git integration is disabled on this server');
    if (this.editingNow(ctx, abs)) return block('session_editing', `${this.sessionName(req.sessionId)} is editing this file right now`);
    const repo = await this.repos.resolve(path.dirname(abs)).catch(() => null);
    base.repo = repo;
    const fileEdits = Array.from(ctx.led.edits.values()).filter((e) => e.absPath === abs && this.countable(e));
    base.risks = fileEdits.length ? this.transcriptRisks(ctx, abs, fileEdits, 0) : [];

    if (t.kind === 'hunk') {
      const found = await this.findHunk(ctx, abs, t.hunkId, t.editId, t.scope === 'all' ? 'all' : 'since_checkpoint');
      if (!found) return block('conflict', 'that change is no longer available');
      if (found.file) base.risks = found.file.risks;
      return this.reverts.preview({ ...base, hunk: found.hunk, hunkIsCreate: found.isCreate });
    }
    if (!repo) return block('not_in_repo', 'the file is not in a git repository');
    const rel = path.relative(repo.root, abs);
    const staged = await this.runner.run({
      cwd: repo.root,
      repoKey: repo.root,
      kind: 'status',
      args: ['diff', '--cached', '--name-only', '-z'],
    });
    if (staged.code === 0 && staged.stdout.split('\0').includes(rel))
      return block('staged_changes', 'the file has staged changes; unstage or commit them first');
    const others = this.alsoChangedBy(req.sessionId, abs, 0);
    if (others.length) return block('foreign_changes', `${others[0]} also changed this file`);
    let checkpointTree: string | null = null;
    if (t.to === 'checkpoint') {
      checkpointTree = ctx.cp.reviewedThrough > 0 ? ctx.cp.snapshots.find((x) => x.repoRoot === repo.root)?.tree || null : null;
      if (checkpointTree) {
        const ok = await objectsExist(this.runner, repo, [checkpointTree]).catch(() => new Set<string>());
        if (!ok.has(checkpointTree)) checkpointTree = null;
      }
    }
    return this.reverts.preview({ ...base, checkpointTree });
  }

  async revert(req: ReviewRevertRequest, clientId: string): Promise<ReviewRevertResponse> {
    if (typeof req.token !== 'string' || (req.confirm !== 'tap' && req.confirm !== 'hold'))
      throw new ReviewServiceError('bad_request', 'token and confirm are required');
    const started = this.now();
    const device = typeof req.device === 'string' ? req.device.slice(0, 80) : null;
    let tokenInfo: ReturnType<RevertManager['peek']> | null = null;
    try {
      tokenInfo = this.reverts.peek(req.token, clientId, req.confirm);
      const out = await this.reverts.apply(req.token, clientId, req.confirm, device, (t) => {
        const led = this.peekLedger(t.sessionId);
        const session = this.findSession(t.sessionId);
        if (led && session) {
          const ctx = { sessionId: t.sessionId, session, led, cp: this.store.get(t.sessionId, led.projectPath), working: this.isWorking(session) };
          if (this.editingNow(ctx, t.absPath)) throw new RevertError('blocked', 'session_editing: the session is editing this file right now');
        }
      });
      this.auditRevert('review_revert', clientId, req, tokenInfo, out.meta, true, started);
      this.afterRevert(out.meta, false, device);
      if (req.notifySession !== false && this.deps.sendDirect) {
        const what = out.token.kind === 'hunk' ? 'a change' : 'the file';
        void this.deps
          .sendDirect(out.meta.sessionId, `[Companion] I reverted ${what} in ${out.meta.path}; re-read it before editing.`)
          .catch(() => undefined);
      }
      const summary = await this.summary(out.meta.sessionId);
      return {
        backupId: out.meta.backupId,
        absPath: out.meta.absPath,
        effect: out.meta.effect,
        undoUntil: out.meta.at + REVIEW_LIMITS.undoWindowMs,
        summary: summary!,
      };
    } catch (err) {
      if (tokenInfo) this.auditRevert('review_revert', clientId, req, tokenInfo, null, false, started, err);
      if (err instanceof RevertError) throw new ReviewServiceError(err.code, err.message);
      throw err;
    }
  }

  async revertUndo(backupId: string, clientId: string): Promise<ReviewRevertUndoResponse> {
    if (typeof backupId !== 'string') throw new ReviewServiceError('bad_request', 'backupId is required');
    const started = this.now();
    try {
      const meta = await this.reverts.undo(backupId);
      this.deps.audit?.({
        ts: this.now(),
        origin: this.origin(clientId),
        action: 'review_revert_undo',
        payload: { session: meta.sessionId, path: meta.absPath, backupId },
        result: { ok: true },
        durationMs: this.now() - started,
      });
      this.afterRevert(meta, true, null);
      const summary = await this.summary(meta.sessionId);
      return { absPath: meta.absPath, summary: summary! };
    } catch (err) {
      this.deps.audit?.({
        ts: this.now(),
        origin: this.origin(clientId),
        action: 'review_revert_undo',
        payload: { backupId },
        result: { ok: false, error: err instanceof Error ? err.message : String(err) },
        durationMs: this.now() - started,
      });
      if (err instanceof RevertError) throw new ReviewServiceError(err.code, err.message);
      throw err;
    }
  }

  private afterRevert(meta: BackupMeta, undone: boolean, by: string | null): void {
    this.bump(meta.sessionId);
    this.filesMemo.clear();
    const ev: ReviewRevertedEvent = {
      sessionId: meta.sessionId,
      absPath: meta.absPath,
      effect: meta.effect,
      backupId: meta.backupId,
      by: undone ? by : meta.by,
      undone,
      at: this.now(),
    };
    this.deps.broadcast?.('review_reverted', ev);
    void this.refresh(meta.sessionId).catch(() => undefined);
  }

  private auditRevert(
    action: string,
    clientId: string,
    req: ReviewRevertRequest,
    t: ReturnType<RevertManager['peek']>,
    meta: BackupMeta | null,
    ok: boolean,
    started: number,
    err?: unknown
  ): void {
    this.deps.audit?.({
      ts: this.now(),
      origin: this.origin(clientId),
      action,
      payload: {
        session: t.sessionId,
        path: t.absPath,
        target: t.target,
        tier: t.tier,
        reasons: t.reasons,
        confirm: req.confirm,
        device: req.device ?? null,
        backupId: meta?.backupId ?? null,
      },
      result: ok ? { ok: true, effect: meta?.effect } : { ok: false, error: err instanceof Error ? err.message : String(err) },
      durationMs: this.now() - started,
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
    for (const p of this.alertPending.values()) clearTimeout(p.timer);
    this.alertPending.clear();
    this.debounceTimers.clear();
    this.throttleTimers.clear();
    this.store.flushSyncOnShutdown();
  }
}
