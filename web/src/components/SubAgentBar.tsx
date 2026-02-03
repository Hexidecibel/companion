import { useState } from 'react';
import { SubAgent } from '../types';
import { SubAgentTree } from './SubAgentTree';

interface SubAgentBarProps {
  agents: SubAgent[];
  runningCount: number;
  completedCount: number;
  totalAgents: number;
  onClick: () => void;
  onViewAgent: (agentId: string) => void;
}

export function SubAgentBar({
  agents,
  runningCount,
  completedCount,
  totalAgents,
  onClick,
  onViewAgent,
}: SubAgentBarProps) {
  const [expanded, setExpanded] = useState(false);

  if (totalAgents === 0) return null;

  const latestRunning = agents
    .filter((a) => a.status === 'running')
    .sort((a, b) => b.lastActivity - a.lastActivity)[0];

  const activityText = latestRunning?.currentActivity || latestRunning?.description || '';

  return (
    <div className="subagent-bar-wrapper">
      <div className="subagent-bar">
        <div
          className="subagent-bar-left"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(!expanded);
          }}
        >
          <span className="subagent-bar-expand">{expanded ? '\u25BC' : '\u25B6'}</span>
          <span className="subagent-bar-indicator">
            {runningCount > 0 ? '\u25CF' : '\u25CB'}
          </span>
          <span className="subagent-bar-count">
            {runningCount > 0
              ? `${runningCount} agent${runningCount !== 1 ? 's' : ''} running`
              : `${totalAgents} agent${totalAgents !== 1 ? 's' : ''} completed`}
          </span>
        </div>
        {activityText && (
          <span className="subagent-bar-activity">{activityText}</span>
        )}
        <span className="subagent-bar-chevron" onClick={onClick}>{'\u203A'}</span>
      </div>
      {expanded && (
        <SubAgentTree
          agents={agents}
          runningCount={runningCount}
          completedCount={completedCount}
          totalAgents={totalAgents}
          onViewAgent={onViewAgent}
        />
      )}
    </div>
  );
}
