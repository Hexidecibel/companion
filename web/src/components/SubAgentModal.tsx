import { SubAgent } from '../types';

interface SubAgentModalProps {
  agents: SubAgent[];
  runningCount: number;
  completedCount: number;
  onClose: () => void;
  onViewAgent: (agentId: string) => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(start: number, end?: number): string {
  const ms = (end || Date.now()) - start;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

const STATUS_LABELS: Record<SubAgent['status'], string> = {
  running: 'Running',
  completed: 'Done',
  error: 'Error',
};

const STATUS_CLASSES: Record<SubAgent['status'], string> = {
  running: 'subagent-status-running',
  completed: 'subagent-status-completed',
  error: 'subagent-status-error',
};

export function SubAgentModal({ agents, runningCount, completedCount, onClose, onViewAgent }: SubAgentModalProps) {
  const running = agents.filter((a) => a.status === 'running');
  const completed = agents.filter((a) => a.status !== 'running');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content subagent-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Sub-Agents ({agents.length})</h3>
          <button className="modal-close" onClick={onClose}>{'\u2715'}</button>
        </div>

        <div className="subagent-modal-body">
          {running.length > 0 && (
            <div className="subagent-modal-section">
              <div className="subagent-modal-section-title">
                Running ({runningCount})
              </div>
              {running.map((agent) => (
                <AgentCard key={agent.agentId} agent={agent} onClick={() => onViewAgent(agent.agentId)} />
              ))}
            </div>
          )}

          {completed.length > 0 && (
            <div className="subagent-modal-section">
              <div className="subagent-modal-section-title">
                Completed ({completedCount})
              </div>
              {completed.map((agent) => (
                <AgentCard key={agent.agentId} agent={agent} onClick={() => onViewAgent(agent.agentId)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentCard({ agent, onClick }: { agent: SubAgent; onClick: () => void }) {
  return (
    <div className="subagent-card" onClick={onClick}>
      <div className="subagent-card-header">
        <span className="subagent-card-slug">{agent.slug}</span>
        <span className={`subagent-card-status ${STATUS_CLASSES[agent.status]}`}>
          {STATUS_LABELS[agent.status]}
        </span>
      </div>
      {agent.description && (
        <div className="subagent-card-desc">{agent.description}</div>
      )}
      <div className="subagent-card-meta">
        <span>{agent.subagentType || 'agent'}</span>
        <span>{agent.messageCount} messages</span>
        <span>{formatDuration(agent.startedAt, agent.completedAt)}</span>
        <span>{formatTime(agent.startedAt)}</span>
      </div>
    </div>
  );
}
