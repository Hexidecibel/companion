/**
 * "Agents" entry next to the session list. Badge = running agents on every
 * server, red when any is stuck or failed (in the last 2 h); hidden at zero.
 */
import { useAgentsOverview } from '../../hooks/useAgentsOverview';
import { agentsBadge } from '../../services/agentsOverview';

export interface AgentsNavButtonProps {
  onClick: () => void;
  active?: boolean;
  className?: string;
}

export function AgentsNavButton({ onClick, active, className }: AgentsNavButtonProps) {
  const { overview } = useAgentsOverview();
  const badge = agentsBadge(overview);
  const label = badge
    ? `Agents: ${badge.count} running${badge.alert ? `, ${overview.stuck} stuck, ${overview.failed} failed` : ''}`
    : 'Agents';
  return (
    <button
      type="button"
      className={`agents-nav${active ? ' agents-nav--active' : ''}${className ? ` ${className}` : ''}`}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <span className="agents-nav__label">Agents</span>
      {badge && (
        <span className={`agents-nav__badge${badge.alert ? ' agents-nav__badge--alert' : ''}`} data-testid="agents-badge">
          {badge.count > 0 ? badge.count : '!'}
        </span>
      )}
    </button>
  );
}
