/**
 * Tool roles: what an agent's tool DOES, independent of what the agent calls it.
 *
 * Pure and dependency-light on purpose (no parser, no tmux): analysis modules
 * (stuck signals, background work, subagents, review ledger, Herald text) ask
 * "is this an edit?" here instead of matching Claude tool names themselves.
 *
 * Only the default agent (Claude Code) exists today; its table lives in
 * `claude/tools.ts`. When another agent is added, its adapter carries its own
 * table and callers that know the session's agent pass it explicitly.
 */
import { CLAUDE_TOOL_ROLES, CLAUDE_APPROVAL_TOOLS } from './claude/tools';

export type ToolRole =
  | 'edit'
  | 'shell'
  | 'read'
  | 'search'
  | 'ask_user'
  | 'plan_approval'
  | 'subagent'
  | 'todo'
  | 'poll'
  | 'web'
  | 'other';

export interface ToolRoleTable {
  /** Tool name -> role. Unknown names (MCP tools, new tools) are 'other'. */
  roles: Readonly<Record<string, ToolRole>>;
  /** Tools whose call normally needs the user's approval in the agent's TUI. */
  approvalTools: ReadonlySet<string>;
}

export const CLAUDE_TOOL_TABLE: ToolRoleTable = {
  roles: CLAUDE_TOOL_ROLES,
  approvalTools: CLAUDE_APPROVAL_TOOLS,
};

/** Role of a tool. Defaults to Claude Code's table (the only agent today). */
export function toolRole(name: string, table: ToolRoleTable = CLAUDE_TOOL_TABLE): ToolRole {
  return Object.prototype.hasOwnProperty.call(table.roles, name) ? table.roles[name] : 'other';
}

export function hasRole(
  name: string,
  roles: ToolRole | readonly ToolRole[],
  table: ToolRoleTable = CLAUDE_TOOL_TABLE
): boolean {
  const r = toolRole(name, table);
  return typeof roles === 'string' ? r === roles : roles.includes(r);
}

/** A tool that blocks on the user inside the agent (a question or plan approval). */
export function isInteractiveTool(name: string, table: ToolRoleTable = CLAUDE_TOOL_TABLE): boolean {
  return hasRole(name, ['ask_user', 'plan_approval'], table);
}

/** A tool that writes files the review ledger / stuck detector track. */
export function isEditTool(name: string, table: ToolRoleTable = CLAUDE_TOOL_TABLE): boolean {
  return toolRole(name, table) === 'edit';
}

/** A tool that starts a subagent. */
export function isSubagentTool(name: string, table: ToolRoleTable = CLAUDE_TOOL_TABLE): boolean {
  return toolRole(name, table) === 'subagent';
}

/** Needs approval in the TUI (the agent's own list, e.g. Claude's tool-config). */
export function requiresApproval(name: string, table: ToolRoleTable = CLAUDE_TOOL_TABLE): boolean {
  return table.approvalTools.has(name);
}
