import type { AgentAdapter } from '../types';
import { CODEX_TOOL_TABLE, toolRole } from '../roles';
import { codexTerminal, type CodexPermissionMode } from './terminal';
import { codexTranscript } from './transcript';

export type { CodexPermissionMode } from './terminal';

/** OpenAI Codex CLI, read-only: transcript + status + approval-box reading. */
export const codexAdapter: AgentAdapter<CodexPermissionMode> = {
  id: 'codex',
  displayName: 'Codex',
  tools: CODEX_TOOL_TABLE,
  toolRole: (name) => toolRole(name, CODEX_TOOL_TABLE),
  transcript: codexTranscript,
  terminal: codexTerminal,
};
