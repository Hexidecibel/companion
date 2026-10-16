/**
 * Herald inbox alerts for subagents (user decision 2026-10-14):
 *
 *   group_done - ONE item when a dispatched group finishes: every agent of one
 *                conversation (and one spawning agent, for nested ones) that ran
 *                together has ended, and no new one joined for `settleMs`. Groups
 *                smaller than `minGroup` (default 2) make no item: one agent
 *                finishing is noise (the session's own "finished" covers it).
 *   failed     - one item per failed agent (status failed), immediately.
 *   stuck      - one item per running agent that looks stuck; current truth (gone
 *                when it recovers or ends), updated in place.
 *
 * Fed ONLY by the tracker's coalesced 'changed' events (ids) plus in-memory
 * summaries: no fs, no subprocess, no LLM. Only agents this process saw running
 * and that ended after it started make news, so a restart that re-reads finished
 * transcripts never replays old notifications. Dedupe keys (agent + end time /
 * stuck kind + since, group id) make a resumed agent's second notification a new
 * fact, and a repeated event the same one. Quiet hours: nothing new is made, and
 * stuck items are withheld while they last.
 */

import type { SubagentSummary } from './protocol';
import { isActive } from './completion';
import { clip, oneLine } from '../herald/text';
import { redactSecrets } from '../herald/knowledge/redact';

export type SubagentAlertKind = 'group_done' | 'failed' | 'stuck';

export interface SubagentAlert {
  /** Dedupe / identity key (stable for the same fact). */
  key: string;
  kind: SubagentAlertKind;
  /** App session id (tmux session) and its display name. */
  sessionId: string;
  sessionName: string;
  conversationId: string;
  headline: string;
  agentIds: string[];
  /** Agent names (clipped, at most 8). */
  names: string[];
  total: number;
  failed: number;
  /** Stuck kind (stuck items). */
  stuckKind?: string;
  at: number;
}

export interface SubagentAlertsDeps {
  summary: (agentId: string) => SubagentSummary | undefined;
  /** Conversation id -> the app session it runs in; null = not a Companion session (no item). */
  label: (conversationId: string) => { sessionId: string; sessionName: string } | null;
  /** Escalation quiet hours. */
  quiet?: () => boolean;
  /** The whole current alert list (news + stuck), on every change. */
  publish: (alerts: SubagentAlert[]) => void;
  now?: () => number;
  settleMs?: number;
  minGroup?: number;
  newsTtlMs?: number;
}

export const SUBAGENT_ALERT_DEFAULTS = {
  settleMs: 20_000,
  minGroup: 2,
  newsTtlMs: 12 * 60 * 60 * 1000,
  maxNews: 20,
  maxStuck: 10,
  /** Tolerance for an end time a little before this process started. */
  startSlackMs: 5_000,
} as const;

const MAX_SEEN = 2000;

/** Insertion-ordered set that forgets its oldest entries (never all at once). */
class FifoSet {
  private m = new Map<string, true>();
  constructor(private max: number) {}
  has(k: string): boolean {
    return this.m.has(k);
  }
  add(k: string): void {
    this.m.delete(k);
    this.m.set(k, true);
    if (this.m.size > this.max) {
      const first = this.m.keys().next().value;
      if (first !== undefined) this.m.delete(first);
    }
  }
}

interface Group {
  id: string;
  scope: string;
  conversationId: string;
  members: Set<string>;
  timer: NodeJS.Timeout | null;
}

const name = (s: SubagentSummary | undefined, id: string): string =>
  clip(oneLine(redactSecrets(s?.name || '')), 60) || id.slice(0, 8);

export class SubagentAlerts {
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly settleMs: number;
  private readonly minGroup: number;
  private readonly ttl: number;
  /** Agents seen active by this process. */
  private seenActive = new FifoSet(MAX_SEEN);
  /** Facts already turned into news (dedupe). */
  private emitted = new FifoSet(MAX_SEEN);
  private groups = new Map<string, Group>();
  private groupOf = new Map<string, Group>();
  private news: SubagentAlert[] = [];
  private stuck = new Map<string, SubagentAlert>();
  private lastKey = '[]';
  private disposed = false;

  constructor(private deps: SubagentAlertsDeps) {
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
    this.settleMs = deps.settleMs ?? SUBAGENT_ALERT_DEFAULTS.settleMs;
    this.minGroup = deps.minGroup ?? SUBAGENT_ALERT_DEFAULTS.minGroup;
    this.ttl = deps.newsTtlMs ?? SUBAGENT_ALERT_DEFAULTS.newsTtlMs;
  }

  /** Tracker 'changed' (already coalesced per pass / tick). */
  onChanged(ids: string[], removed: string[] = []): void {
    if (this.disposed) return;
    const touched = new Set<Group>();
    for (const id of ids) {
      const s = this.deps.summary(id);
      if (!s) continue;
      if (isActive(s.status)) this.onActive(s);
      else this.onFinished(s);
      const g = this.groupOf.get(id);
      if (g) touched.add(g);
    }
    for (const id of removed) {
      this.stuck.delete(id);
      const g = this.groupOf.get(id);
      if (g) touched.add(g);
    }
    for (const g of touched) this.check(g);
    this.publish();
  }

  /** Current alerts (news newest first, then stuck). */
  list(): SubagentAlert[] {
    const now = this.now();
    this.news = this.news.filter((a) => now - a.at <= this.ttl);
    const quiet = this.deps.quiet?.() ?? false;
    const stuck = quiet ? [] : [...this.stuck.values()].slice(0, SUBAGENT_ALERT_DEFAULTS.maxStuck);
    return [...this.news, ...stuck].map((a) => ({
      ...a,
      agentIds: [...a.agentIds],
      names: [...a.names],
    }));
  }

  dispose(): void {
    this.disposed = true;
    for (const g of this.groups.values()) if (g.timer) clearTimeout(g.timer);
    this.groups.clear();
    this.groupOf.clear();
  }

  // ------------------------------------------------------------------ internals

  private scopeOf(s: SubagentSummary): string {
    return `${s.sessionId}|${s.parentAgentId ?? ''}`;
  }

  private onActive(s: SubagentSummary): void {
    this.seenActive.add(s.agentId);
    const scope = this.scopeOf(s);
    let g = this.groupOf.get(s.agentId);
    if (!g || g.scope !== scope || !this.groups.has(g.scope)) {
      g = this.groups.get(scope);
      if (!g) {
        g = {
          id: s.agentId,
          scope,
          conversationId: s.sessionId,
          members: new Set(),
          timer: null,
        };
        this.groups.set(scope, g);
      }
      g.members.add(s.agentId);
      this.groupOf.set(s.agentId, g);
    }
    if (g.timer) {
      clearTimeout(g.timer);
      g.timer = null;
    }
    if (s.stuck) {
      const label = this.deps.label(s.sessionId);
      if (!label) return;
      const key = `s|${s.agentId}|${s.stuck.kind}|${s.stuck.since}`;
      const prev = this.stuck.get(s.agentId);
      const quiet = this.deps.quiet?.() ?? false;
      if (prev?.key === key) return;
      if (quiet && !prev) return;
      const n = name(s, s.agentId);
      this.stuck.set(s.agentId, {
        key,
        kind: 'stuck',
        sessionId: label.sessionId,
        sessionName: label.sessionName,
        conversationId: s.sessionId,
        headline: clip(
          `An agent in ${label.sessionName} looks stuck: ${n}, ${oneLine(redactSecrets(s.stuck.headline))}`,
          200
        ),
        agentIds: [s.agentId],
        names: [n],
        total: 1,
        failed: 0,
        stuckKind: s.stuck.kind,
        at: prev?.at ?? this.now(),
      });
    } else {
      this.stuck.delete(s.agentId);
    }
  }

  /** Ended after this process started, and seen running by it. */
  private fresh(s: SubagentSummary): boolean {
    if (!this.seenActive.has(s.agentId)) return false;
    const end = s.endedAt ?? s.lastEntryAt;
    return end >= this.startedAt - SUBAGENT_ALERT_DEFAULTS.startSlackMs;
  }

  private onFinished(s: SubagentSummary): void {
    this.stuck.delete(s.agentId);
    if (s.status !== 'failed' || !this.fresh(s)) return;
    const key = `f|${s.agentId}|${s.endedAt ?? s.lastEntryAt}`;
    if (this.emitted.has(key)) return;
    this.emitted.add(key);
    if (this.deps.quiet?.()) return;
    const label = this.deps.label(s.sessionId);
    if (!label) return;
    const n = name(s, s.agentId);
    this.addNews({
      key,
      kind: 'failed',
      sessionId: label.sessionId,
      sessionName: label.sessionName,
      conversationId: s.sessionId,
      headline: clip(`An agent failed in ${label.sessionName}: ${n}`, 200),
      agentIds: [s.agentId],
      names: [n],
      total: 1,
      failed: 1,
      at: this.now(),
    });
  }

  private allDone(g: Group): boolean {
    for (const id of g.members) {
      const s = this.deps.summary(id);
      if (s && isActive(s.status)) return false;
    }
    return true;
  }

  private check(g: Group): void {
    if (this.groups.get(g.scope) !== g || !this.allDone(g)) return;
    if (g.timer) return;
    if (this.settleMs <= 0) {
      this.close(g);
      return;
    }
    g.timer = setTimeout(() => {
      g.timer = null;
      if (this.disposed || this.groups.get(g.scope) !== g || !this.allDone(g)) return;
      this.close(g);
      this.publish();
    }, this.settleMs);
    g.timer.unref?.();
  }

  private close(g: Group): void {
    this.groups.delete(g.scope);
    for (const id of g.members) if (this.groupOf.get(id) === g) this.groupOf.delete(id);
    const members = [...g.members]
      .map((id) => ({ id, s: this.deps.summary(id) }))
      .filter((m) => !m.s || this.fresh(m.s));
    if (members.length < this.minGroup) return;
    const key = `g|${g.scope}|${g.id}`;
    if (this.emitted.has(key)) return;
    this.emitted.add(key);
    if (this.deps.quiet?.()) return;
    const label = this.deps.label(g.conversationId);
    if (!label) return;
    const count = (st: string) => members.filter((m) => m.s?.status === st).length;
    const failed = count('failed');
    const stopped = count('stopped');
    const lost = count('lost');
    const tail = [
      failed ? `${failed} failed` : '',
      stopped ? `${stopped} stopped` : '',
      lost ? `${lost} went silent` : '',
    ].filter(Boolean);
    const total = members.length;
    const ok = total - failed - stopped - lost;
    const head =
      ok === total
        ? `All ${total} agents finished in ${label.sessionName}`
        : `${total} agents done in ${label.sessionName}: ${ok} finished, ${tail.join(', ')}`;
    this.addNews({
      key,
      kind: 'group_done',
      sessionId: label.sessionId,
      sessionName: label.sessionName,
      conversationId: g.conversationId,
      headline: clip(head, 200),
      agentIds: members.map((m) => m.id).slice(0, 20),
      names: members.slice(0, 8).map((m) => name(m.s, m.id)),
      total,
      failed,
      at: this.now(),
    });
  }

  private addNews(a: SubagentAlert): void {
    this.news.unshift(a);
    if (this.news.length > SUBAGENT_ALERT_DEFAULTS.maxNews)
      this.news.length = SUBAGENT_ALERT_DEFAULTS.maxNews;
  }

  private publish(): void {
    const list = this.list();
    const key = JSON.stringify(list);
    if (key === this.lastKey) return;
    this.lastKey = key;
    try {
      this.deps.publish(list);
    } catch (err) {
      console.error('Subagents: alert publish failed:', err);
    }
  }
}
