import { SubAgent } from '../types';

interface SubAgentBarProps {
  agents: SubAgent[];
  runningCount: number;
  totalAgents: number;
  onClick: () => void;
}

export function SubAgentBar({ agents, runningCount, totalAgents, onClick }: SubAgentBarProps) {
  if (totalAgents === 0) return null;

  const latestRunning = agents
    .filter((a) => a.status === 'running')
    .sort((a, b) => b.lastActivity - a.lastActivity)[0];

  const activityText = latestRunning?.currentActivity || latestRunning?.description || '';

  return (
    <div className="subagent-bar" onClick={onClick}>
      <div className="subagent-bar-left">
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
      <span className="subagent-bar-chevron">{'\u203A'}</span>
    </div>
  );
}
