import type { CodingAgent } from '../types';

/** Claude / Codex choice shared by New Session and New Project. */
export const CODING_AGENTS: Array<{ id: CodingAgent; label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
];

const AGENT_STORAGE_PREFIX = 'new-session-agent:';

/** Last agent picked for new sessions on a server (default Claude). */
export function readStoredAgent(serverId: string): CodingAgent {
  try {
    return localStorage.getItem(AGENT_STORAGE_PREFIX + serverId) === 'codex' ? 'codex' : 'claude';
  } catch {
    return 'claude';
  }
}

export function writeStoredAgent(serverId: string, agent: CodingAgent) {
  try {
    localStorage.setItem(AGENT_STORAGE_PREFIX + serverId, agent);
  } catch {
    // ignore
  }
}

interface AgentPickerProps {
  value: CodingAgent;
  onChange: (agent: CodingAgent) => void;
  disabled?: boolean;
  className?: string;
}

export function AgentPicker({ value, onChange, disabled, className }: AgentPickerProps) {
  return (
    <div
      className={`new-session-agent-row${className ? ` ${className}` : ''}`}
      role="radiogroup"
      aria-label="Coding agent"
    >
      <span className="new-session-agent-label">Agent</span>
      {CODING_AGENTS.map((a) => (
        <button
          key={a.id}
          type="button"
          role="radio"
          aria-checked={value === a.id}
          className={`new-session-agent-btn ${value === a.id ? 'active' : ''}`}
          onClick={() => onChange(a.id)}
          disabled={disabled}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}
