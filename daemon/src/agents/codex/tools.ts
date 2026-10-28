/**
 * Codex CLI's tool table. Codex (0.16x "code mode") runs most work through one
 * `exec` custom tool whose input is a JS snippet calling `tools.<name>(...)`;
 * the parser names each ToolCall after the inner tool (exec_command,
 * apply_patch, ...). Older rollouts use plain function calls (`shell`,
 * `apply_patch`, `update_plan`, ...). Unknown names are 'other'.
 *
 * Kept free of heavy imports so pure analysis modules can use it.
 */
import type { ToolRole } from '../roles';

export const CODEX_TOOL_ROLES: Readonly<Record<string, ToolRole>> = Object.freeze({
  exec_command: 'shell',
  exec: 'shell',
  shell: 'shell',
  local_shell: 'shell',
  local_shell_call: 'shell',
  'container.exec': 'shell',
  unified_exec: 'shell',
  apply_patch: 'edit',
  update_plan: 'todo',
  write_stdin: 'poll',
  view_image: 'read',
  list_files: 'search',
  web_search: 'web',
  web_search_call: 'web',
  request_user_input: 'ask_user',
});

/**
 * Codex asks for approval by policy (sandbox escalation, untrusted command),
 * not per tool name, and the pending request is never in the rollout file: it
 * only shows on screen. So no tool is an "approval tool" here.
 */
export const CODEX_APPROVAL_TOOLS: ReadonlySet<string> = new Set();
