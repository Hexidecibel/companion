import { SubAgent } from '../types';

interface DispatchAgentCardProps {
  agent: SubAgent;
  onClick: () => void;
}

function formatDuration(start: number, end?: number): string {
  const ms = (end || Date.now()) - start;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

export function DispatchAgentCard({ agent, onClick }: DispatchAgentCardProps) {
  const statusClass =
    agent.status === 'running'
      ? 'dispatch-card-running'
      : agent.status === 'error'
        ? 'dispatch-card-error'
        : 'dispatch-card-completed';

  const subtitle =
    agent.status === 'running'
      ? agent.currentActivity || agent.description || ''
      : agent.description || '';

  return (
    <div className={`dispatch-agent-card ${statusClass}`} onClick={(e) => { e.stopPropagation(); onClick(); }}>
      <div className="dispatch-card-row1">
        <span className="dispatch-card-dot" />
        <span className="dispatch-card-slug">{agent.slug || agent.agentId.slice(0, 8)}</span>
        <span className="dispatch-card-duration">
          {formatDuration(agent.startedAt, agent.completedAt)}
        </span>
      </div>
      {subtitle && (
        <div className="dispatch-card-row2">
          <span className="dispatch-card-desc">{subtitle}</span>
          <span className="dispatch-card-meta">
            {agent.messageCount} msgs
          </span>
          <span className="dispatch-card-chevron">{'\u203A'}</span>
        </div>
      )}
      {!subtitle && (
        <div className="dispatch-card-row2">
          <span className="dispatch-card-desc" />
          <span className="dispatch-card-meta">
            {agent.messageCount} msgs
          </span>
          <span className="dispatch-card-chevron">{'\u203A'}</span>
        </div>
      )}
    </div>
  );
}
