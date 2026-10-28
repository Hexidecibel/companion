/**
 * Agent registry. Claude Code is the default; Codex CLI is the second adapter
 * (read-only: transcript + status). The watcher decides per tmux session which
 * agent runs in it (`SessionWatcher.agentFor`).
 */
import type { AgentAdapter, AgentId } from './types';
import { claudeAdapter } from './claude';
import { codexAdapter } from './codex';

export * from './types';
export {
  toolRole,
  hasRole,
  isInteractiveTool,
  isEditTool,
  isSubagentTool,
  requiresApproval,
} from './roles';
export { claudeAdapter } from './claude';
export { codexAdapter } from './codex';

export const DEFAULT_AGENT_ID: AgentId = 'claude';

const ADAPTERS: Record<AgentId, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

/** The adapter for an agent id; unknown / missing ids get the default (Claude). */
export function getAgentAdapter(id?: string | null): AgentAdapter {
  if (id && Object.prototype.hasOwnProperty.call(ADAPTERS, id)) return ADAPTERS[id as AgentId];
  return ADAPTERS[DEFAULT_AGENT_ID];
}

/** Shorthand for the default adapter. */
export function defaultAgent(): AgentAdapter {
  return ADAPTERS[DEFAULT_AGENT_ID];
}

export function listAgentIds(): AgentId[] {
  return Object.keys(ADAPTERS) as AgentId[];
}
