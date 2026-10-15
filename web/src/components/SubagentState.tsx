import { useEffect, useState } from 'react';
import type { SubAgent } from '../types';
import type { SubagentSummary } from '../types/subagents';
import { formatDuration, formatTokens, isActiveStatus, statusChip } from '../services/subagents';

/** Status chip: running / waiting on child / done / finished (unconfirmed) / failed / stopped / lost / stuck. */
export function SubagentStatusChip({ agent }: { agent: SubAgent }) {
  const chip = statusChip(agent);
  return (
    <span className={`subagent-chip subagent-chip-${chip.tone}`} title={agent.summary?.stuck?.summary || chip.label}>
      {chip.label}
    </span>
  );
}

/** Re-render once a second while the agent is active (elapsed / idle clocks). */
function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return active ? now : Date.now();
}

/** Compact state of one agent (no transcript): activity, checklist, tests, tokens, newest events. */
export function SubagentStateBody({ summary: s }: { summary: SubagentSummary }) {
  const active = isActiveStatus(s.status);
  const now = useClock(active);
  const elapsed = (s.endedAt ?? now) - s.startedAt;
  const idle = active ? now - Math.max(s.lastEntryAt, s.pendingSince ?? 0) : 0;
  return (
    <div className="subagent-state">
      <div className="subagent-state-meta">
        {s.type && <span>{s.type}</span>}
        <span>{formatDuration(elapsed)}</span>
        {active && idle >= 60_000 && <span className="subagent-idle">idle {formatDuration(idle)}</span>}
        {s.tokens > 0 && <span>{formatTokens(s.tokens)} tok</span>}
        <span>{s.toolCalls} tools</span>
        {s.edits > 0 && <span>{s.edits} edits / {s.filesTouched} files</span>}
        {s.partial && <span title="Only the newest part of a long transcript was read">partial</span>}
      </div>
      {s.stuck && active && <div className="subagent-stuck">{s.stuck.summary || s.stuck.headline}</div>}
      {s.activity && (
        <div className="subagent-activity" title={s.activity}>
          {active ? (s.pendingTool ? 'Running ' : 'Said: ') : 'Last: '}
          {s.activity}
        </div>
      )}
      {s.checklist && (
        <div className="subagent-checklist">
          <div className="subagent-progress">
            <div style={{ width: `${Math.round((100 * s.checklist.done) / Math.max(1, s.checklist.total))}%` }} />
          </div>
          <span>
            {s.checklist.done}/{s.checklist.total}
            {s.checklist.current ? ` - ${s.checklist.current}` : ''}
          </span>
        </div>
      )}
      {s.tests && s.tests.runs > 0 && (
        <div className={`subagent-tests ${s.tests.lastFailed ? 'failing' : 'passing'}`}>
          Tests: {s.tests.runs} run{s.tests.runs === 1 ? '' : 's'}, {s.tests.failed} failed
          {s.tests.lastFailed ? ' (last run failed)' : ' (last run passed)'}
        </div>
      )}
      {s.notifySummary && !active && <div className="subagent-notify">{s.notifySummary}</div>}
      {s.recent.length > 0 && (
        <ul className="subagent-events">
          {s.recent.map((e) => (
            <li key={e.id} className={e.failed ? 'failed' : e.pending ? 'pending' : ''}>
              <span className="subagent-event-kind">{e.tool || e.kind}</span>
              <span className="subagent-event-text">{e.display}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
