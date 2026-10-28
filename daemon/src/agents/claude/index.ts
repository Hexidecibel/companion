import type { AgentAdapter } from '../types';
import { CLAUDE_TOOL_TABLE, toolRole } from '../roles';
import { claudeTerminal, type ClaudePermissionMode } from './terminal';
import { claudeTranscript } from './transcript';

export type { ClaudePermissionMode } from './terminal';

export const claudeAdapter: AgentAdapter<ClaudePermissionMode> = {
  id: 'claude',
  displayName: 'Claude Code',
  tools: CLAUDE_TOOL_TABLE,
  toolRole: (name) => toolRole(name, CLAUDE_TOOL_TABLE),
  transcript: claudeTranscript,
  terminal: claudeTerminal,
};
