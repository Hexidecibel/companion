/**
 * Pure helpers for the subagent panel: legacy <-> tracker shapes, live delta
 * merging, change detection (no-op suppression), tree order and status chips.
 */
import type { SubAgent } from '../types';
import type { SubagentStatus, SubagentSummary, SubagentUpdateEvent } from '../types/subagents';

/** Finished agents stay in the session panel this long (same as get_agent_tree). */
export const PANEL_FINISHED_MS = 5 * 60 * 1000;

export function isActiveStatus(s: SubagentStatus): boolean {
  return s === 'starting' || s === 'running' || s === 'waiting_child';
}

export function legacyStatus(s: SubagentStatus): SubAgent['status'] {
  if (isActiveStatus(s)) return 'running';
  return s === 'failed' ? 'error' : 'completed';
}

/** A tracker summary in the SubAgent shape the panel components take. */
export function summaryToSubAgent(s: SubagentSummary): SubAgent {
  const status = legacyStatus(s.status);
  const out: SubAgent = {
    agentId: s.agentId,
    slug: s.name,
    sessionId: s.sessionId,
    status,
    startedAt: s.startedAt,
    description: s.name,
    subagentType: s.type || '',
    messageCount: s.toolCalls,
    lastActivity: s.lastEntryAt,
    state: s.status,
    depth: s.depth,
    summary: s,
  };
  if (status !== 'running' && s.endedAt !== undefined) out.completedAt = s.endedAt;
  if (s.activity) out.currentActivity = s.activity;
  if (s.parentAgentId) out.parentAgentId = s.parentAgentId;
  return out;
}

/** Panel set: active agents, plus agents that finished in the last 5 minutes. */
export function panelVisible(s: SubagentSummary, now = Date.now()): boolean {
  if (isActiveStatus(s.status)) return true;
  return s.endedAt !== undefined && now - s.endedAt < PANEL_FINISHED_MS;
}

/** Merge a subagent_update into the map (returns a new map, or the same one when nothing applied). */
export function applyUpdate(
  map: Map<string, SubagentSummary>,
  ev: SubagentUpdateEvent,
): Map<string, SubagentSummary> {
  let next: Map<string, SubagentSummary> | null = null;
  for (const a of ev.agents || []) {
    const cur = map.get(a.agentId);
    if (cur && cur.version === a.version && cur.status === a.status) continue;
    if (!next) next = new Map(map);
    next.set(a.agentId, a);
  }
  for (const id of ev.removed || []) {
    if (!map.has(id)) continue;
    if (!next) next = new Map(map);
    next.delete(id);
  }
  return next || map;
}

/** Signature of what the panel shows; equal signature = skip setState. */
export function listSignature(agents: SubAgent[]): string {
  return agents
    .map((a) => `${a.agentId}:${a.summary ? a.summary.version : `${a.status}|${a.messageCount}|${a.lastActivity}|${a.currentActivity ?? ''}`}`)
    .join(',');
}

/**
 * Tree order: roots (running first, newest activity first), each followed by its
 * children (same rule), depth-first. Agents whose parent is not in the list are roots.
 */
export function orderTree(agents: SubAgent[]): SubAgent[] {
  const ids = new Set(agents.map((a) => a.agentId));
  const kids = new Map<string, SubAgent[]>();
  const roots: SubAgent[] = [];
  for (const a of agents) {
    const p = a.parentAgentId;
    if (p && ids.has(p) && p !== a.agentId) {
      const list = kids.get(p) || [];
      list.push(a);
      kids.set(p, list);
    } else roots.push(a);
  }
  const cmp = (a: SubAgent, b: SubAgent) => {
    const ra = a.status === 'running' ? 0 : 1;
    const rb = b.status === 'running' ? 0 : 1;
    return ra - rb || b.lastActivity - a.lastActivity;
  };
  const out: SubAgent[] = [];
  const seen = new Set<string>();
  const walk = (list: SubAgent[]) => {
    for (const a of [...list].sort(cmp)) {
      if (seen.has(a.agentId)) continue;
      seen.add(a.agentId);
      out.push(a);
      const c = kids.get(a.agentId);
      if (c) walk(c);
    }
  };
  walk(roots);
  // Cycles (should not happen): append whatever was not reached.
  for (const a of agents) if (!seen.has(a.agentId)) out.push(a);
  return out;
}

/** Indent level inside the panel (0 = dispatched by the main thread). */
export function indentOf(a: SubAgent, all: SubAgent[]): number {
  let n = 0;
  let cur: SubAgent | undefined = a;
  const byId = new Map(all.map((x) => [x.agentId, x]));
  while (cur?.parentAgentId && byId.has(cur.parentAgentId) && n < 6) {
    n++;
    cur = byId.get(cur.parentAgentId);
  }
  return n;
}

export interface StatusChip {
  label: string;
  tone: 'running' | 'waiting' | 'done' | 'unconfirmed' | 'failed' | 'stopped' | 'lost' | 'stuck';
}

export function statusChip(a: SubAgent): StatusChip {
  const s = a.summary;
  if (s?.stuck && isActiveStatus(s.status)) return { label: 'stuck', tone: 'stuck' };
  const st: SubagentStatus | undefined = a.state ?? s?.status;
  switch (st) {
    case 'starting':
      return { label: 'starting', tone: 'running' };
    case 'running':
      return { label: 'running', tone: 'running' };
    case 'waiting_child':
      return { label: 'waiting on child', tone: 'waiting' };
    case 'done':
      return { label: 'done', tone: 'done' };
    case 'done_unconfirmed':
      return { label: 'finished (unconfirmed)', tone: 'unconfirmed' };
    case 'failed':
      return { label: 'failed', tone: 'failed' };
    case 'stopped':
      return { label: 'stopped', tone: 'stopped' };
    case 'lost':
      return { label: 'lost', tone: 'lost' };
    default:
      if (a.status === 'running') return { label: 'running', tone: 'running' };
      if (a.status === 'error') return { label: 'failed', tone: 'failed' };
      return { label: 'done', tone: 'done' };
  }
}

export function formatDuration(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
