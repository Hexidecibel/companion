/**
 * SubagentTracker: one incremental reader per subagent transcript, one needle
 * scan per parent transcript, a completion state machine driven by the parent's
 * task-notifications, nesting via .meta.json toolUseId, stuck signals from the
 * pure stuck/signals analysis (no pane, no subprocess).
 *
 * Performance rules (see plan.md "Subagent visibility"):
 * - async fs only; each byte is read once (byte-offset tails), never a full re-read
 * - per pass: <= PASS_BUDGET bytes overall, <= FILE_BUDGET per file, and a
 *   setImmediate yield after ~SLICE_MS of synchronous fold work
 * - a never-seen transcript larger than LARGE_FILE is read from its last
 *   TAIL_START bytes only (`partial`)
 * - the backstop stats only files of ACTIVE agents (and their parents) every tick
 * - bounded memory: fixed-size records, LRU MAX_AGENTS, finished agents evicted
 *   after 24 h, rings and caps everywhere
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { JsonlTail } from '../review/jsonl-tail';
import { analyze, type StuckDigest, type PaneTrack } from '../stuck/signals';
import type { StuckSettings } from '../stuck/protocol';
import { STUCK_DEFAULTS } from '../stuck/protocol';
import { clip } from '../herald/text';
import { AgentRecord, parseMeta } from './state';
import { NeedleScanner } from './parent-scan';
import { NOTIFICATION_NEEDLE, notificationsInEntry, TaskNotification } from './notify';
import { deriveStatus, isActive, isFinished } from './completion';
import type { SubagentState, SubagentSummary } from './protocol';
import { SUBAGENT_LIMITS } from './protocol';

export const PASS_BUDGET = 16 * 1024 * 1024;
export const FILE_BUDGET = 4 * 1024 * 1024;
export const LARGE_FILE = 8 * 1024 * 1024;
export const TAIL_START = 2 * 1024 * 1024;
/** Parents larger than this are scanned from their last PARENT_BACK bytes. */
export const PARENT_BACK = 32 * 1024 * 1024;
export const SLICE_MS = 20;
const STUCK_EVERY_MS = 30_000;
const MAX_OWNERS = 5000;
const MAX_ORPHANS = 500;

export interface TrackerDeps {
  now?: () => number;
  stuckSettings?: () => StuckSettings;
  /** Read/fold scheduling delay after a change (ms). */
  passDelayMs?: number;
  log?: (msg: string) => void;
}

export interface RegisterOpts {
  /** File mtime (ms) at discovery. */
  mtimeMs?: number;
  birthtimeMs?: number;
  size?: number;
  /** Old file: meta + parent notification only, read lazily on demand. */
  history?: boolean;
}

export interface TrackerStats {
  agents: number;
  active: number;
  parents: number;
  bytesRead: number;
  parentBytes: number;
  linesFolded: number;
  passes: number;
  maxSliceMs: number;
  approxBytes: number;
}

function agentIdOf(file: string): string | null {
  const m = path.basename(file).match(/^agent-([\w-]+)\.jsonl$/);
  return m ? m[1] : null;
}

/** <proj>/<conv>/subagents/agent-x.jsonl -> <conv> and <proj>/<conv>.jsonl */
export function convOfAgentFile(file: string): { convId: string; convPath: string } {
  const subDir = path.dirname(file);
  const convDir = path.dirname(subDir);
  const convId = path.basename(convDir);
  return { convId, convPath: path.join(path.dirname(convDir), `${convId}.jsonl`) };
}

const nextTick = () => new Promise<void>((r) => setImmediate(r));

export class SubagentTracker extends EventEmitter {
  readonly agents = new Map<string, AgentRecord>();
  /** Agent/Task tool_use id -> agent whose file started it (nesting). */
  private owners = new Map<string, string>();
  /** Notifications for agents not registered yet (bounded). */
  private orphans = new Map<string, TaskNotification[]>();
  private parents = new Map<string, NeedleScanner>();
  /** convPath -> agent ids in it. */
  private byParent = new Map<string, Set<string>>();
  private dirty = new Set<string>();
  private parentDirty = new Set<string>();
  private changed = new Set<string>();
  private removed = new Set<string>();
  private passTimer: NodeJS.Timeout | null = null;
  private passing: Promise<void> | null = null;
  private again = false;
  private lastStuckAt = 0;
  private stopped = false;
  private readonly now: () => number;
  private readonly passDelayMs: number;
  readonly stats: TrackerStats = {
    agents: 0,
    active: 0,
    parents: 0,
    bytesRead: 0,
    parentBytes: 0,
    linesFolded: 0,
    passes: 0,
    maxSliceMs: 0,
    approxBytes: 0,
  };

  constructor(private deps: TrackerDeps = {}) {
    super();
    this.now = deps.now ?? Date.now;
    this.passDelayMs = deps.passDelayMs ?? 250;
  }

  /** Late-bound stuck settings (the StuckDetector is created after the tracker). */
  setStuckSettings(fn: () => StuckSettings): void {
    this.deps.stuckSettings = fn;
  }

  // ------------------------------------------------------------- registration

  /** A subagent transcript was found. Idempotent. */
  register(file: string, opts: RegisterOpts = {}): AgentRecord | null {
    const agentId = agentIdOf(file);
    if (!agentId) return null;
    const now = this.now();
    let rec = this.agents.get(agentId);
    if (rec) {
      if (opts.mtimeMs && opts.mtimeMs > rec.lastBytesAt) rec.lastBytesAt = opts.mtimeMs;
      if (rec.history && !opts.history) this.wake(rec);
      return rec;
    }
    const { convId, convPath } = convOfAgentFile(file);
    rec = new AgentRecord(agentId, convId, file);
    rec.touchedAt = now;
    rec.lastBytesAt = opts.mtimeMs ?? now;
    const born = opts.birthtimeMs && opts.birthtimeMs > 0 ? opts.birthtimeMs : 0;
    rec.startedAt = born || Math.min(opts.mtimeMs ?? now, now);
    rec.knownSize = opts.size ?? 0;
    rec.history = !!opts.history;
    this.agents.set(agentId, rec);
    let set = this.byParent.get(convPath);
    if (!set) this.byParent.set(convPath, (set = new Set()));
    set.add(agentId);
    this.ensureParent(convPath);
    const orphans = this.orphans.get(agentId);
    if (orphans) {
      this.orphans.delete(agentId);
      for (const n of orphans) rec.applyNotification(n);
    }
    void this.loadMeta(rec);
    if (!rec.history) this.markDirty(agentId);
    this.evaluate(rec, now);
    this.noteChange(rec);
    this.enforceCap();
    return rec;
  }

  private wake(rec: AgentRecord): void {
    rec.history = false;
    this.markDirty(rec.agentId);
  }

  async loadMeta(rec: AgentRecord): Promise<void> {
    const metaPath = rec.filePath.replace(/\.jsonl$/, '.meta.json');
    try {
      const raw = await fs.promises.readFile(metaPath, 'utf-8');
      if (raw.length > 64 * 1024) return;
      const meta = parseMeta(raw);
      const before = JSON.stringify(rec.meta);
      rec.meta = meta;
      rec.metaLoaded = true;
      if (JSON.stringify(meta) !== before) {
        this.evaluate(rec, this.now());
        rec.bump(this.now());
        this.noteChange(rec);
      }
    } catch {
      // Not written yet: retried on the next directory event.
    }
  }

  private ensureParent(convPath: string): void {
    if (this.parents.has(convPath)) return;
    this.parents.set(convPath, new NeedleScanner(convPath, NOTIFICATION_NEEDLE));
    this.parentDirty.add(convPath);
    this.schedule();
  }

  // ------------------------------------------------------------- change input

  markDirty(agentId: string, written = false): void {
    const rec = this.agents.get(agentId);
    if (!rec) return;
    if (written) rec.lastBytesAt = Math.max(rec.lastBytesAt, this.now());
    if (rec.history) rec.history = false;
    this.dirty.add(agentId);
    this.schedule();
  }

  markDirtyFile(file: string, written = false): boolean {
    const id = agentIdOf(file);
    if (!id || !this.agents.has(id)) return false;
    this.markDirty(id, written);
    return true;
  }

  /** The parent conversation file changed. No-op unless it has agents. */
  markParentDirty(convPath: string): void {
    if (!this.parents.has(convPath)) return;
    this.parentDirty.add(convPath);
    this.schedule();
  }

  hasParent(convPath: string): boolean {
    return this.parents.has(convPath);
  }

  private schedule(delay = this.passDelayMs): void {
    if (this.stopped) return;
    if (this.passing) {
      this.again = true;
      return;
    }
    if (this.passTimer) return;
    this.passTimer = setTimeout(() => {
      this.passTimer = null;
      void this.pass();
    }, delay);
    this.passTimer.unref?.();
  }

  // ------------------------------------------------------------- the pass

  /** Read what is dirty within budget. Resolves when this pass is done. */
  pass(): Promise<void> {
    if (this.passing) {
      this.again = true;
      return this.passing;
    }
    this.passing = this.doPass().finally(() => {
      this.passing = null;
      const more = this.again || this.dirty.size > 0 || this.parentDirty.size > 0;
      this.again = false;
      if (more) this.schedule(this.dirty.size || this.parentDirty.size ? 50 : this.passDelayMs);
      this.flush();
    });
    return this.passing;
  }

  private async doPass(): Promise<void> {
    this.stats.passes++;
    let budget = PASS_BUDGET;
    let sliceStart = performance.now();
    const maybeYield = async () => {
      const spent = performance.now() - sliceStart;
      if (spent > this.stats.maxSliceMs) this.stats.maxSliceMs = spent;
      if (spent >= SLICE_MS) {
        await nextTick();
        sliceStart = performance.now();
      }
    };

    // Parents first: their notifications decide completion.
    for (const p of [...this.parentDirty]) {
      if (budget <= 0 || this.stopped) break;
      this.parentDirty.delete(p);
      const scan = this.parents.get(p);
      if (!scan) continue;
      if (scan.offset === 0 && !scan.seen) {
        try {
          const st = await fs.promises.stat(p);
          scan.startNear(st.size, PARENT_BACK);
        } catch {
          continue;
        }
      }
      const r = await scan.read(Math.min(FILE_BUDGET * 2, budget));
      sliceStart = performance.now();
      budget -= r.bytes;
      this.stats.parentBytes += r.bytes;
      for (const line of r.lines) {
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        for (const n of notificationsInEntry(entry as never)) this.route(n);
        if (performance.now() - sliceStart >= SLICE_MS) await maybeYield();
      }
      if (r.more) this.parentDirty.add(p);
      await maybeYield();
    }

    // Agents: newest activity first.
    const order = [...this.dirty]
      .map((id) => this.agents.get(id))
      .filter((r): r is AgentRecord => !!r)
      .sort((a, b) => b.lastBytesAt - a.lastBytesAt);
    for (const rec of order) {
      if (budget <= 0 || this.stopped) break;
      this.dirty.delete(rec.agentId);
      if (!rec.tail) {
        rec.tail = new JsonlTail(rec.filePath);
        try {
          const st = await fs.promises.stat(rec.filePath);
          rec.knownSize = st.size;
          if (st.mtimeMs > rec.lastBytesAt) rec.lastBytesAt = st.mtimeMs;
          if (st.size > LARGE_FILE) {
            rec.tail.offset = st.size - TAIL_START;
            rec.partial = true;
          }
        } catch {
          continue;
        }
      }
      const before = rec.tail.offset;
      const r = await rec.tail.read(Math.min(FILE_BUDGET, budget));
      // Measure fold work only (the read above awaited I/O).
      sliceStart = performance.now();
      if (r.reset) {
        rec.resetDerived();
        rec.partial = false;
      }
      const read = rec.tail.offset - (r.reset ? 0 : before);
      budget -= Math.max(0, read);
      this.stats.bytesRead += Math.max(0, read);
      if (rec.tail.offset > rec.knownSize) rec.knownSize = rec.tail.offset;
      const now = this.now();
      for (const line of r.lines) {
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const res = rec.fold(entry, now);
        this.stats.linesFolded++;
        for (const id of res.agentCalls) this.setOwner(id, rec.agentId);
        for (const note of res.notifications) this.route(note);
        if (performance.now() - sliceStart >= SLICE_MS) await maybeYield();
      }
      rec.backlog = r.more;
      if (r.more) this.dirty.add(rec.agentId);
      if (r.lines.length || r.reset) {
        rec.bump(now);
        this.evaluate(rec, now);
        this.noteChange(rec);
      }
      await maybeYield();
    }
  }

  private setOwner(toolUseId: string, agentId: string): void {
    if (this.owners.size >= MAX_OWNERS) {
      const first = this.owners.keys().next().value;
      if (first !== undefined) this.owners.delete(first);
    }
    this.owners.set(toolUseId, agentId);
    // A child registered before its spawning line was read: its tree position changed.
    for (const rec of this.agents.values())
      if (rec.meta.toolUseId === toolUseId) {
        rec.bump(this.now());
        this.noteChange(rec);
      }
  }

  private route(n: TaskNotification): void {
    const rec = this.agents.get(n.taskId);
    if (!rec) {
      // Background Bash tasks share the envelope: only keep agent-looking ids.
      if (!/^a[0-9a-f]{6,}$/.test(n.taskId)) return;
      const list = this.orphans.get(n.taskId) || [];
      if (list.length < 5) list.push(n);
      this.orphans.set(n.taskId, list);
      if (this.orphans.size > MAX_ORPHANS) {
        const first = this.orphans.keys().next().value;
        if (first !== undefined) this.orphans.delete(first);
      }
      return;
    }
    if (rec.applyNotification(n)) {
      const now = this.now();
      rec.bump(now);
      this.evaluate(rec, now);
      this.noteChange(rec);
    }
  }

  // ------------------------------------------------------------- status

  parentOf(rec: AgentRecord): string | undefined {
    const t = rec.meta.toolUseId;
    if (!t) return undefined;
    const owner = this.owners.get(t);
    return owner && owner !== rec.agentId ? owner : undefined;
  }

  private childActive(rec: AgentRecord): boolean {
    if (!rec.agentCalls.size) return false;
    for (const other of this.agents.values()) {
      if (other === rec || !isActive(other.status)) continue;
      if (other.meta.toolUseId && rec.agentCalls.has(other.meta.toolUseId)) return true;
    }
    return false;
  }

  /** Re-derive one agent's status. Returns true when it changed. */
  evaluate(rec: AgentRecord, now: number): boolean {
    const scan = this.parents.get(convOfAgentFile(rec.filePath).convPath);
    const next = deriveStatus({
      now,
      startedAt: rec.startedAt,
      lastEntryAt: rec.lastEntryAt,
      lastBytesAt: rec.history
        ? Math.min(rec.lastBytesAt, rec.lastEntryAt || rec.lastBytesAt)
        : rec.lastBytesAt,
      assistantEntries: rec.assistantEntries,
      pendingCount: rec.pendingCount,
      pendingAgentCall: rec.hasPendingAgentCall(),
      childActive: this.childActive(rec),
      lastStopReason: rec.lastStopReason,
      notification: rec.notification
        ? { status: rec.notification.status, at: rec.notification.at }
        : null,
      stoppedByUser: rec.meta.stoppedByUser === true,
      parentKnown: !!scan?.seen,
    });
    if (next === rec.status) return false;
    const wasActive = isActive(rec.status);
    rec.status = next;
    if (isFinished(next)) {
      rec.endedAt =
        rec.notification && (next === 'done' || next === 'failed' || next === 'stopped')
          ? rec.notification.at
          : Math.max(rec.lastEntryAt, rec.startedAt);
      rec.stuck = null;
      if (wasActive) rec.compact();
    } else {
      rec.endedAt = undefined;
    }
    rec.bump(now);
    this.noteChange(rec);
    return true;
  }

  // ------------------------------------------------------------- tick

  /**
   * Backstop + time-based transitions. Stats only ACTIVE agents' files (fs.watch
   * may drop events) and their parents; never old or finished files.
   */
  async tick(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    const statParents = new Set<string>();
    const checks: Array<Promise<void>> = [];
    for (const rec of this.agents.values()) {
      if (rec.history || (!isActive(rec.status) && rec.status !== 'done_unconfirmed')) continue;
      statParents.add(convOfAgentFile(rec.filePath).convPath);
      checks.push(
        fs.promises.stat(rec.filePath).then(
          (st) => {
            if (st.size !== rec.knownSize) {
              if (st.mtimeMs > rec.lastBytesAt) rec.lastBytesAt = st.mtimeMs;
              rec.knownSize = st.size;
            }
            if (!rec.tail || st.size !== rec.tail.offset) this.markDirty(rec.agentId);
          },
          () => undefined
        )
      );
    }
    for (const p of statParents) {
      const scan = this.parents.get(p);
      if (!scan) continue;
      checks.push(
        fs.promises.stat(p).then(
          (st) => {
            if (st.size !== scan.offset) this.markParentDirty(p);
          },
          () => undefined
        )
      );
    }
    await Promise.all(checks);
    for (const rec of this.agents.values()) this.evaluate(rec, now);
    if (now - this.lastStuckAt >= STUCK_EVERY_MS) {
      this.lastStuckAt = now;
      this.evaluateStuck(now);
    }
    this.evict(now);
    this.flush();
  }

  evaluateStuck(now: number): void {
    const settings = this.deps.stuckSettings?.() ?? STUCK_DEFAULTS;
    for (const rec of this.agents.values()) {
      let next: AgentRecord['stuck'] = null;
      if (
        settings.enabled &&
        (rec.status === 'running' || rec.status === 'waiting_child') &&
        rec.assistantEntries > 0
      ) {
        const pending = rec.pendingEvents();
        const newest = pending[pending.length - 1];
        const digest: StuckDigest = {
          phase: 'working',
          turnId: `${rec.agentId}#${rec.notifications}`,
          turnStartedAt: rec.notification ? rec.notification.at : rec.startedAt,
          lastTextAt: rec.lastTextAt,
          lastEditAt: rec.lastEditAt,
          lastMessageAt: rec.lastEntryAt,
          events: rec.stuckEvents,
          pending,
        };
        // A subagent has no pane: "screen unchanged" becomes "no bytes written".
        const pane: PaneTrack = {
          reading: { hash: '', prompt: false, alive: true },
          stableSince: Math.max(rec.lastBytesAt, rec.lastEntryAt),
          stableChecks: 2,
          checkedAt: now,
          pendingId: newest ? newest.id : null,
        };
        const c = analyze(digest, now, settings, pane)[0];
        if (c)
          next = {
            kind: c.kind,
            severity: c.severity,
            headline: c.headline,
            summary: c.summary.replace('with no screen change', 'with nothing written'),
            since: c.firstSeen,
          };
      }
      const prev = rec.stuck;
      const same =
        (!prev && !next) ||
        (!!prev && !!next && prev.kind === next.kind && prev.headline === next.headline);
      if (!same) {
        rec.stuck = next;
        rec.bump(now);
        this.noteChange(rec);
      }
    }
  }

  // ------------------------------------------------------------- memory

  private dropAgent(rec: AgentRecord): void {
    this.agents.delete(rec.agentId);
    this.dirty.delete(rec.agentId);
    this.changed.delete(rec.agentId);
    this.removed.add(rec.agentId);
    const conv = convOfAgentFile(rec.filePath).convPath;
    const set = this.byParent.get(conv);
    if (set) {
      set.delete(rec.agentId);
      if (!set.size) {
        this.byParent.delete(conv);
        this.parents.delete(conv);
        this.parentDirty.delete(conv);
      }
    }
  }

  evict(now: number): void {
    for (const rec of [...this.agents.values()]) {
      if (!isFinished(rec.status)) continue;
      const end = rec.endedAt ?? rec.touchedAt;
      if (now - end > SUBAGENT_LIMITS.retainMs) this.dropAgent(rec);
    }
    this.enforceCap();
  }

  private enforceCap(): void {
    if (this.agents.size <= SUBAGENT_LIMITS.maxAgents) return;
    const victims = [...this.agents.values()].sort((a, b) => {
      const fa = isFinished(a.status) ? 0 : 1;
      const fb = isFinished(b.status) ? 0 : 1;
      return fa - fb || a.touchedAt - b.touchedAt;
    });
    for (const v of victims) {
      if (this.agents.size <= SUBAGENT_LIMITS.maxAgents) break;
      this.dropAgent(v);
    }
  }

  // ------------------------------------------------------------- output

  private noteChange(rec: AgentRecord): void {
    this.changed.add(rec.agentId);
  }

  /** Emit 'changed' with the ids changed since the last flush. */
  flush(): void {
    if (!this.changed.size && !this.removed.size) return;
    const ids = [...this.changed];
    const removed = [...this.removed];
    this.changed.clear();
    this.removed.clear();
    this.emit('changed', ids, removed);
  }

  summary(rec: AgentRecord): SubagentSummary {
    const parentAgentId = this.parentOf(rec);
    const parent = parentAgentId ? this.agents.get(parentAgentId) : undefined;
    const depth = parent ? (parent.meta.spawnDepth ?? 1) + 1 : (rec.meta.spawnDepth ?? 1);
    const act = rec.activity();
    const out: SubagentSummary = {
      agentId: rec.agentId,
      sessionId: rec.sessionId,
      depth,
      name:
        rec.meta.description ||
        (rec.prompt ? clip(rec.prompt.replace(/\s+/g, ' '), 80) : rec.agentId.slice(0, 8)),
      status: rec.status,
      startedAt: rec.startedAt,
      lastEntryAt: rec.lastEntryAt || rec.startedAt,
      toolCalls: rec.toolCalls,
      edits: rec.edits,
      filesTouched: rec.files.size,
      tokens: rec.totalTokens(),
      recent: rec.timeline.slice(-3),
      version: rec.version,
    };
    if (parentAgentId) out.parentAgentId = parentAgentId;
    if (rec.meta.toolUseId) out.parentToolUseId = rec.meta.toolUseId;
    if (rec.meta.agentType) out.type = rec.meta.agentType;
    if (rec.meta.background !== undefined) out.background = rec.meta.background;
    if (rec.meta.worktree) out.worktree = rec.meta.worktree;
    if (rec.meta.model) out.model = rec.meta.model;
    if (rec.endedAt !== undefined) out.endedAt = rec.endedAt;
    if (isActive(rec.status)) {
      if (act.activity) out.activity = act.activity;
      if (act.pendingTool) out.pendingTool = act.pendingTool;
      if (act.pendingSince) out.pendingSince = act.pendingSince;
    } else if (rec.lastText) out.activity = rec.lastText;
    if (rec.tests) out.tests = { ...rec.tests };
    if (rec.checklist) out.checklist = { ...rec.checklist };
    if (rec.stuck) out.stuck = { ...rec.stuck };
    if (rec.notification?.summary) out.notifySummary = rec.notification.summary;
    if (rec.partial) out.partial = true;
    if (rec.history) out.partial = true;
    return out;
  }

  state(rec: AgentRecord): SubagentState {
    const tools: Record<string, number> = {};
    for (const [k, v] of rec.toolCounts) tools[k] = v;
    const files = [...rec.files.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([p, count]) => ({ path: p, count }));
    const out: SubagentState = {
      ...this.summary(rec),
      tools,
      files,
      timeline: rec.timeline.slice(),
      tokenDetail: {
        ...rec.tokenDetail(),
        ...(rec.notification?.tokens !== undefined ? { reported: rec.notification.tokens } : {}),
      },
      notifications: rec.notifications,
    };
    if (rec.lastText) out.lastText = rec.lastText;
    if (rec.prompt) out.prompt = rec.prompt;
    if (rec.notification?.result) out.result = rec.notification.result;
    return out;
  }

  /** Agents of these conversations (all when omitted), newest activity first. */
  list(convIds?: string[] | null): AgentRecord[] {
    const set = convIds && convIds.length ? new Set(convIds) : null;
    const out: AgentRecord[] = [];
    for (const rec of this.agents.values()) if (!set || set.has(rec.sessionId)) out.push(rec);
    return out.sort((a, b) => (b.lastEntryAt || b.startedAt) - (a.lastEntryAt || a.startedAt));
  }

  get(agentId: string): AgentRecord | undefined {
    return this.agents.get(agentId);
  }

  /** Read a history (unread) agent now, within one pass budget. */
  async hydrate(agentId: string): Promise<AgentRecord | undefined> {
    const rec = this.agents.get(agentId);
    if (!rec) return undefined;
    if (rec.history || rec.backlog || this.dirty.has(agentId)) {
      rec.history = false;
      this.dirty.add(agentId);
      await this.pass();
    }
    return this.agents.get(agentId);
  }

  refreshStats(): TrackerStats {
    let active = 0;
    let bytes = 0;
    for (const r of this.agents.values()) {
      if (isActive(r.status)) active++;
      bytes += r.approxBytes();
    }
    this.stats.agents = this.agents.size;
    this.stats.active = active;
    this.stats.parents = this.parents.size;
    this.stats.approxBytes = bytes;
    return { ...this.stats };
  }

  stop(): void {
    this.stopped = true;
    if (this.passTimer) clearTimeout(this.passTimer);
    this.passTimer = null;
  }
}
