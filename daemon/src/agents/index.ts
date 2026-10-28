/**
 * Agent registry. Claude Code is the default and only adapter; every session
 * is a Claude session until a second adapter (Codex) lands and sessions carry
 * their agent id.
 */
import type { AgentAdapter, AgentId } from './types';
import { claudeAdapter } from './claude';

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

export const DEFAULT_AGENT_ID: AgentId = 'claude';

const ADAPTERS: Record<AgentId, AgentAdapter> = {
  claude: claudeAdapter,
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
