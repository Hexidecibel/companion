import { isMobileViewport } from '../utils/platform';

interface DispatchOpenerProps {
  runningCount: number;
  totalAgents: number;
  open: boolean;
  onToggle: () => void;
}

/**
 * Desktop-only header chip that opens/closes the subagent dispatch panel.
 * Shown whenever the session has any agents (running or finished), so
 * finished agents' results stay reachable. Never rendered on mobile
 * viewports: the mobile toolbar has no room for it (see 9edbf50); mobile
 * uses the collapsed bar rendered by DispatchPanel instead.
 */
export function DispatchOpener({ runningCount, totalAgents, open, onToggle }: DispatchOpenerProps) {
  if (totalAgents <= 0 || isMobileViewport()) return null;

  const done = totalAgents - runningCount;
  const label = runningCount > 0
    ? `${runningCount} running${done > 0 ? ` / ${done} done` : ''}`
    : `${totalAgents} agent${totalAgents !== 1 ? 's' : ''}`;

  return (
    <button
      className={`session-header-btn session-agent-chip ${open ? 'terminal-active' : ''}`}
      onClick={onToggle}
      title={open ? 'Hide dispatch panel' : 'Show dispatch panel'}
      aria-pressed={open}
      data-testid="dispatch-opener"
    >
      <span className={`dispatch-mobile-dot ${runningCount > 0 ? 'dispatch-dot-running' : 'dispatch-dot-done'}`} />
      <span>{label}</span>
    </button>
  );
}
