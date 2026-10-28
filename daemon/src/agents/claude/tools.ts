/**
 * Claude Code's tool table: role per tool name. Every tool in tool-config.ts
 * MUST have a role (type-checked via `ConfiguredTool`); the extras are tools
 * Claude Code emits that tool-config does not describe for the app.
 *
 * Kept free of heavy imports (only tool-config) so pure analysis modules can
 * use it without pulling in the parser or tmux code.
 */
import { DEFAULT_TOOL_CONFIG, APPROVAL_TOOLS } from '../../tool-config';
import type { ToolRole } from '../roles';

type ConfiguredTool = keyof typeof DEFAULT_TOOL_CONFIG;

const CONFIGURED_ROLES: Record<ConfiguredTool, ToolRole> = {
  Bash: 'shell',
  Read: 'read',
  Write: 'edit',
  Edit: 'edit',
  Glob: 'search',
  Grep: 'search',
  Task: 'subagent',
  WebFetch: 'web',
  WebSearch: 'web',
  AskUserQuestion: 'ask_user',
  NotebookEdit: 'edit',
  TodoRead: 'todo',
  TodoWrite: 'todo',
  TaskCreate: 'todo',
  TaskUpdate: 'todo',
  TaskGet: 'todo',
  TaskList: 'todo',
  EnterPlanMode: 'other',
  ExitPlanMode: 'plan_approval',
  Skill: 'other',
};

/** Tools Claude Code emits that tool-config.ts does not list. */
const EXTRA_ROLES: Record<string, ToolRole> = {
  MultiEdit: 'edit',
  Agent: 'subagent',
  LS: 'search',
  NotebookRead: 'read',
  BashOutput: 'poll',
  TaskOutput: 'poll',
  Monitor: 'poll',
  KillShell: 'poll',
};

export const CLAUDE_TOOL_ROLES: Readonly<Record<string, ToolRole>> = Object.freeze({
  ...CONFIGURED_ROLES,
  ...EXTRA_ROLES,
});

/** Same membership as tool-config's APPROVAL_TOOLS (requiresApproval: true). */
export const CLAUDE_APPROVAL_TOOLS: ReadonlySet<string> = new Set(APPROVAL_TOOLS);
