import { DEFAULT_TOOL_CONFIG, APPROVAL_TOOLS } from '../../tool-config';
import {
  CLAUDE_TOOL_TABLE,
  hasRole,
  isEditTool,
  isInteractiveTool,
  isSubagentTool,
  requiresApproval,
  toolRole,
  type ToolRole,
} from '../roles';

const membersOf = (role: ToolRole): string[] =>
  Object.keys(CLAUDE_TOOL_TABLE.roles)
    .filter((n) => toolRole(n) === role)
    .sort();

describe('Claude tool roles', () => {
  it('gives every tool-config tool a role', () => {
    for (const name of Object.keys(DEFAULT_TOOL_CONFIG)) {
      expect(Object.prototype.hasOwnProperty.call(CLAUDE_TOOL_TABLE.roles, name)).toBe(true);
    }
  });

  it('keeps the membership of the name sets it replaced', () => {
    // review/ledger.ts + stuck/signals.ts EDIT_TOOLS
    expect(membersOf('edit')).toEqual(['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
    // stuck SUBAGENT_TOOLS, subagents AGENT_TOOLS
    expect(membersOf('subagent')).toEqual(['Agent', 'Task']);
    // watcher / stuck WAITING_TOOLS / background-work INTERACTIVE
    const interactive = Object.keys(CLAUDE_TOOL_TABLE.roles).filter((n) => isInteractiveTool(n));
    expect(interactive.sort()).toEqual(['AskUserQuestion', 'ExitPlanMode']);
    // background-work APPROVAL_LIKE
    const approvalLike = Object.keys(CLAUDE_TOOL_TABLE.roles).filter((n) =>
      hasRole(n, ['shell', 'edit'])
    );
    expect(approvalLike.sort()).toEqual(['Bash', 'Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
    // stuck LOOP_TOOLS minus WebFetch (kept by name)
    const loop = Object.keys(CLAUDE_TOOL_TABLE.roles).filter((n) =>
      hasRole(n, ['shell', 'read', 'search'])
    );
    expect(loop.sort()).toEqual(['Bash', 'Glob', 'Grep', 'LS', 'NotebookRead', 'Read']);
    // stuck POLL_TOOLS minus TodoWrite (kept by name)
    expect(membersOf('poll')).toEqual(['BashOutput', 'KillShell', 'Monitor', 'TaskOutput']);
    expect(membersOf('shell')).toEqual(['Bash']);
  });

  it('approval tools match tool-config, and minus subagents match the watcher rule', () => {
    expect([...CLAUDE_TOOL_TABLE.approvalTools].sort()).toEqual([...APPROVAL_TOOLS].sort());
    const nonSubagent = APPROVAL_TOOLS.filter((n) => requiresApproval(n) && !isSubagentTool(n));
    expect(nonSubagent).toEqual(APPROVAL_TOOLS.filter((n) => n !== 'Task'));
  });

  it('treats unknown and MCP tools as other', () => {
    expect(toolRole('mcp__x__y')).toBe('other');
    expect(toolRole('constructor')).toBe('other');
    expect(toolRole('toString')).toBe('other');
    expect(isEditTool('Bash')).toBe(false);
    expect(isEditTool('MultiEdit')).toBe(true);
  });

  it('accepts another table', () => {
    const table = { roles: { apply_patch: 'edit' as ToolRole }, approvalTools: new Set<string>() };
    expect(toolRole('apply_patch', table)).toBe('edit');
    expect(toolRole('Edit', table)).toBe('other');
  });
});
