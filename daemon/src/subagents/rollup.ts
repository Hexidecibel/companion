/**
 * Deterministic one-line "where's it at" rollup over compact agent states (pure).
 * "3 of 5 done. Bob is running tests (2 failing, 4 min). Ann is idle 6 min on a Bash call."
 * Free and always available: phase 2/3 surfaces (Herald, MCP, LLM polish) start from it.
 */

import type { SubagentSummary } from './protocol';
import { isActive } from './completion';

const MIN = 60_000;
const IDLE_NOTE_MS = 3 * MIN;
const MAX_NAMED = 3;
const TEST_HINT =
  /\b(?:jest|vitest|pytest|mocha|playwright|cargo test|go test|npm (?:run )?test|bin\/test|rspec|phpunit)\b/i;

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} h ${rm} min` : `${h} h`;
}

function nameOf(a: SubagentSummary): string {
  const n = (a.name || a.agentId.slice(0, 8)).replace(/\s+/g, ' ').trim();
  return n.length > 48 ? `${n.slice(0, 47).trimEnd()}…` : n;
}

function doing(a: SubagentSummary, now: number): string {
  const idle = now - Math.max(a.lastEntryAt, a.pendingSince ?? 0);
  if (a.status === 'waiting_child') return 'waiting on its own subagents';
  if (a.status === 'starting') return 'starting';
  const tool = a.pendingTool;
  if (tool) {
    const since = a.pendingSince ? now - a.pendingSince : 0;
    if (tool === 'Bash' && TEST_HINT.test(a.activity || '')) return 'running tests';
    if (since >= IDLE_NOTE_MS) return `idle ${fmtDuration(since)} on a ${tool} call`;
    if (tool === 'Bash') return 'running a command';
    if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write' || tool === 'NotebookEdit')
      return 'editing files';
    if (tool === 'Read' || tool === 'Grep' || tool === 'Glob' || tool === 'LS')
      return 'reading code';
    if (tool === 'WebFetch' || tool === 'WebSearch') return 'researching online';
    if (tool === 'Agent' || tool === 'Task') return 'dispatching a subagent';
    return `using ${tool}`;
  }
  if (idle >= IDLE_NOTE_MS) return `quiet for ${fmtDuration(idle)}`;
  return 'working';
}

function extras(a: SubagentSummary, now: number): string {
  const bits: string[] = [];
  if (a.checklist)
    bits.push(`step ${Math.min(a.checklist.done + 1, a.checklist.total)}/${a.checklist.total}`);
  if (a.tests && a.tests.runs) {
    if (a.tests.lastFailed)
      bits.push(`${a.tests.failed} failing run${a.tests.failed === 1 ? '' : 's'}`);
    else bits.push('tests passing');
  }
  bits.push(fmtDuration(now - a.startedAt));
  return bits.join(', ');
}

/** One agent as a sentence fragment. */
export function agentLine(a: SubagentSummary, now: number): string {
  const name = nameOf(a);
  if (isActive(a.status)) {
    if (a.stuck)
      return `${name} looks stuck: ${a.stuck.headline} (${fmtDuration(now - a.startedAt)})`;
    return `${name} is ${doing(a, now)} (${extras(a, now)})`;
  }
  const took = a.endedAt ? ` after ${fmtDuration(a.endedAt - a.startedAt)}` : '';
  switch (a.status) {
    case 'done':
      return `${name} finished${took}`;
    case 'done_unconfirmed':
      return `${name} seems finished${took}`;
    case 'failed':
      return `${name} failed${took}`;
    case 'stopped':
      return `${name} was stopped${took}`;
    case 'lost':
      return `${name} went silent ${fmtDuration(now - a.lastEntryAt)} ago`;
    default:
      return name;
  }
}

export function rollupText(agents: SubagentSummary[], now: number): string {
  if (!agents.length) return 'No subagents.';
  const active = agents.filter((a) => isActive(a.status));
  const done = agents.filter((a) => a.status === 'done' || a.status === 'done_unconfirmed').length;
  const failed = agents.filter((a) => a.status === 'failed').length;
  const stopped = agents.filter((a) => a.status === 'stopped').length;
  const lost = agents.filter((a) => a.status === 'lost').length;
  const head: string[] = [];
  if (agents.length === 1) {
    return `${agentLine(agents[0], now)}.`;
  }
  head.push(
    active.length
      ? `${done} of ${agents.length} done, ${active.length} running`
      : `All ${agents.length} finished`
  );
  if (failed) head.push(`${failed} failed`);
  if (stopped) head.push(`${stopped} stopped`);
  if (lost) head.push(`${lost} went silent`);
  const parts = [`${head.join(', ')}.`];
  // Stuck first, then the most recently active.
  const named = [...active]
    .sort((a, b) => Number(!!b.stuck) - Number(!!a.stuck) || b.lastEntryAt - a.lastEntryAt)
    .slice(0, MAX_NAMED);
  for (const a of named) parts.push(`${agentLine(a, now)}.`);
  if (active.length > named.length) parts.push(`${active.length - named.length} more running.`);
  if (!active.length) {
    const bad = agents.filter((a) => a.status === 'failed' || a.status === 'lost').slice(0, 2);
    for (const a of bad) parts.push(`${agentLine(a, now)}.`);
  }
  return parts.join(' ');
}
