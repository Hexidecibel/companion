/**
 * "Where's it at" facts (pure): compact, structured, redacted per-session groups
 * built from the tracker's in-memory summaries. Herald's `subagent_status` tool and
 * the MCP `remote_subagent_status` (via subagent_rollup {facts:true}) return these.
 * No transcript text: names, statuses, counters, the deterministic rollup lines and
 * the (already clipped) activity / notification summary, all through redactSecrets.
 */

import type {
  SubagentAgentFacts,
  SubagentFacts,
  SubagentSessionFacts,
  SubagentSummary,
} from './protocol';
import { isActive } from './completion';
import { agentLine, rollupText } from './rollup';
import { redactSecrets } from '../herald/knowledge/redact';
import { clip, oneLine } from '../herald/text';

export interface FactsLabel {
  /** Display name ("Out4", or "a session in companion"). */
  session: string;
  /** App session id (tmux session) when known. */
  sessionId?: string;
}

export interface FactsOptions {
  /** Conversation id -> how to name it. */
  label: (conversationId: string) => FactsLabel;
  maxSessions?: number;
  maxAgents?: number;
  /**
   * Finished agents older than this are left out (0 = keep every retained one).
   * A session filter usually passes 0; the fleet view keeps only recent history.
   */
  finishedWithinMs?: number;
}

export const FACTS_DEFAULTS = {
  maxSessions: 6,
  maxAgents: 8,
  finishedWithinMs: 2 * 60 * 60 * 1000,
} as const;

const safe = (s: string | undefined, max: number): string | undefined => {
  if (!s) return undefined;
  const t = clip(oneLine(redactSecrets(s)), max);
  return t || undefined;
};

export function agentFacts(a: SubagentSummary, now: number): SubagentAgentFacts {
  const active = isActive(a.status);
  const out: SubagentAgentFacts = {
    agentId: a.agentId,
    name: safe(a.name, 80) || a.agentId.slice(0, 8),
    status: a.status,
    line: safe(agentLine(a, now), 200) || '',
    elapsedMs: Math.max(0, (a.endedAt ?? now) - a.startedAt),
    filesTouched: a.filesTouched,
  };
  if (a.type) out.type = clip(a.type, 40);
  if (a.parentAgentId) out.parentAgentId = a.parentAgentId;
  if (active) {
    out.idleMs = Math.max(0, now - Math.max(a.lastEntryAt, a.pendingSince ?? 0));
    const act = safe(a.activity, 120);
    if (act) out.activity = act;
    if (a.stuck) out.stuck = safe(a.stuck.headline, 120);
  } else {
    const sum = safe(a.notifySummary, 160);
    if (sum) out.summary = sum;
  }
  if (a.checklist) out.checklist = `${a.checklist.done}/${a.checklist.total}`;
  if (a.tests && a.tests.runs)
    out.tests = { runs: a.tests.runs, failed: a.tests.failed, lastFailed: a.tests.lastFailed };
  return out;
}

/** Active first (stuck first among them), then the newest finished. */
function order(a: SubagentSummary, b: SubagentSummary): number {
  const aa = isActive(a.status);
  const ba = isActive(b.status);
  if (aa !== ba) return aa ? -1 : 1;
  if (aa && !!a.stuck !== !!b.stuck) return a.stuck ? -1 : 1;
  return (b.endedAt ?? b.lastEntryAt) - (a.endedAt ?? a.lastEntryAt);
}

export function buildFacts(
  agents: SubagentSummary[],
  now: number,
  opts: FactsOptions
): SubagentFacts {
  const maxSessions = opts.maxSessions ?? FACTS_DEFAULTS.maxSessions;
  const maxAgents = opts.maxAgents ?? FACTS_DEFAULTS.maxAgents;
  const within = opts.finishedWithinMs ?? FACTS_DEFAULTS.finishedWithinMs;
  const kept = agents.filter(
    (a) => isActive(a.status) || !within || now - (a.endedAt ?? a.lastEntryAt) <= within
  );
  const byConv = new Map<string, SubagentSummary[]>();
  for (const a of kept) {
    const l = byConv.get(a.sessionId);
    if (l) l.push(a);
    else byConv.set(a.sessionId, [a]);
  }
  const sessions: SubagentSessionFacts[] = [];
  for (const [conv, list] of byConv) {
    list.sort(order);
    const label = opts.label(conv);
    const s: SubagentSessionFacts = {
      conversationId: conv,
      session: safe(label.session, 80) || 'a session',
      rollup: safe(rollupText(list, now), 600) || '',
      running: list.filter((a) => isActive(a.status)).length,
      total: list.length,
      failed: list.filter((a) => a.status === 'failed').length,
      agents: list.slice(0, maxAgents).map((a) => agentFacts(a, now)),
      more: Math.max(0, list.length - maxAgents),
    };
    if (label.sessionId) s.sessionId = label.sessionId;
    sessions.push(s);
  }
  const newest = (s: SubagentSessionFacts) =>
    Math.max(
      ...byConv.get(s.conversationId)!.map((a) => a.endedAt ?? Math.max(a.lastEntryAt, a.startedAt))
    );
  sessions.sort((a, b) => Number(b.running > 0) - Number(a.running > 0) || newest(b) - newest(a));
  const shown = sessions.slice(0, maxSessions);
  return {
    rollup: safe(rollupText(kept, now), 600) || '',
    running: kept.filter((a) => isActive(a.status)).length,
    total: kept.length,
    sessions: shown,
    moreSessions: Math.max(0, sessions.length - shown.length),
    generatedAt: now,
  };
}

/** The encoded project dir of a Claude transcript path -> a short project label (best effort). */
export function projectLabelOf(encodedDir: string, home: string): string {
  const enc = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');
  const h = enc(home.replace(/\/+$/, ''));
  let rest = encodedDir;
  for (const prefix of [`${h}-local-src-`, `${h}-src-`, `${h}-`]) {
    if (rest.startsWith(prefix) && rest.length > prefix.length) {
      rest = rest.slice(prefix.length);
      break;
    }
  }
  return rest.replace(/^-+/, '') || 'a project';
}
