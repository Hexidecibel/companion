import { useState } from 'react';
import { SubAgent } from '../types';

interface SubAgentTreeProps {
  agents: SubAgent[];
  runningCount: number;
  completedCount: number;
  totalAgents: number;
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
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

const STATUS_ICON: Record<SubAgent['status'], string> = {
  running: '\u25CF',
  completed: '\u2713',
  error: '\u2715',
};

const STATUS_CLASS: Record<SubAgent['status'], string> = {
  running: 'subagent-tree-status-running',
  completed: 'subagent-tree-status-completed',
  error: 'subagent-tree-status-error',
};

export function SubAgentTree({
  agents,
  runningCount,
  completedCount,
  totalAgents,
  onViewAgent,
}: SubAgentTreeProps) {
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());

  const toggleExpanded = (agentId: string) => {
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      return next;
    });
  };

  if (totalAgents === 0) return null;

  return (
    <div className="subagent-tree">
      <div className="subagent-tree-summary">
        <div className="subagent-tree-summary-item">
          <span className="subagent-tree-summary-value">{totalAgents}</span>
          <span className="subagent-tree-summary-label">Total</span>
        </div>
        <div className="subagent-tree-summary-divider" />
        <div className="subagent-tree-summary-item">
          <span className="subagent-tree-summary-value" style={{ color: 'var(--accent-green)' }}>
            {runningCount}
          </span>
          <span className="subagent-tree-summary-label">Running</span>
        </div>
        <div className="subagent-tree-summary-divider" />
        <div className="subagent-tree-summary-item">
          <span className="subagent-tree-summary-value" style={{ color: 'var(--accent-blue)' }}>
            {completedCount}
          </span>
          <span className="subagent-tree-summary-label">Done</span>
        </div>
      </div>

      <div className="subagent-tree-list">
        {agents.map((agent) => {
          const isExpanded = expandedAgents.has(agent.agentId);

          return (
            <div key={agent.agentId} className="subagent-tree-node">
              <div
                className="subagent-tree-node-header"
                onClick={() => toggleExpanded(agent.agentId)}
              >
                <span className={`subagent-tree-node-icon ${STATUS_CLASS[agent.status]}`}>
                  {STATUS_ICON[agent.status]}
                </span>
                <div className="subagent-tree-node-info">
                  <span className="subagent-tree-node-slug">
                    {agent.slug || agent.agentId}
                  </span>
                  <span className="subagent-tree-node-meta">
                    {agent.status === 'running'
                      ? `Running for ${formatDuration(agent.startedAt)}`
                      : `Completed in ${formatDuration(agent.startedAt, agent.completedAt)}`}
                    {' \u2022 '}{agent.messageCount} msgs
                  </span>
                </div>
                <span className="subagent-tree-node-expand">
                  {isExpanded ? '\u25BC' : '\u25B6'}
                </span>
              </div>

              {isExpanded && (
                <div className="subagent-tree-node-details">
                  {agent.description && (
                    <div className="subagent-tree-detail-row">
                      <span className="subagent-tree-detail-label">Task:</span>
                      <span className="subagent-tree-detail-value">{agent.description}</span>
                    </div>
                  )}
                  {agent.currentActivity && (
                    <div className="subagent-tree-detail-row">
                      <span className="subagent-tree-detail-label">Activity:</span>
                      <span className="subagent-tree-detail-value">{agent.currentActivity}</span>
                    </div>
                  )}
                  {agent.subagentType && (
                    <div className="subagent-tree-detail-row">
                      <span className="subagent-tree-detail-label">Type:</span>
                      <span className="subagent-tree-detail-value">{agent.subagentType}</span>
                    </div>
                  )}
                  <div className="subagent-tree-detail-row">
                    <span className="subagent-tree-detail-label">Started:</span>
                    <span className="subagent-tree-detail-value">{formatTime(agent.startedAt)}</span>
                  </div>
                  {agent.completedAt && (
                    <div className="subagent-tree-detail-row">
                      <span className="subagent-tree-detail-label">Finished:</span>
                      <span className="subagent-tree-detail-value">{formatTime(agent.completedAt)}</span>
                    </div>
                  )}
                  <div className="subagent-tree-detail-row">
                    <span className="subagent-tree-detail-label">Agent ID:</span>
                    <span className="subagent-tree-detail-value subagent-tree-agent-id">
                      {agent.agentId}
                    </span>
                  </div>
                  <button
                    className="subagent-tree-view-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onViewAgent(agent.agentId);
                    }}
                  >
                    View Conversation
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
