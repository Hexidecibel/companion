/**
 * Codex CLI's transcript side: rollouts under `<codexHome>/sessions/YYYY/MM/DD/`
 * (keyed by date, the cwd is inside), parsed by `parse.ts`. Read-only.
 *
 * Status rules (from the file alone):
 *   - working: a task_started without its task_complete / turn_aborted
 *   - waiting for input (the app's "turn over" state): the last turn ended
 *   - a tool call without output: running (an approval request is NOT in the
 *     file; it is read from the pane by the terminal half)
 */
import * as path from 'path';
import type { ConversationMessage, SessionStatus } from '../../types';
import type { AgentEditExtractor, AgentTranscript } from '../types';
import { findCodexPid } from './discovery';
import { codexCurrentActivity, codexTurnEnded, parseCodexFile } from './parse';

/** Step 4 parses apply_patch envelopes into hunks; until then Codex reports no edits. */
const codexEdits: AgentEditExtractor = {
  editStart: () => null,
  editOutcome: (_name, current) => ({ kind: current, hunks: null }),
};

export const codexTranscript: AgentTranscript = {
  // `codeHome` here is the Codex home (resolveCodexHome).
  projectsDir: (codexHome) => path.join(codexHome, 'sessions'),
  // Not cwd-keyed: a session's "project dir" is its rollout, found by discovery.ts.
  encodeProjectDir: (workingDir) => workingDir,
  projectDirFor: (codexHome) => path.join(codexHome, 'sessions'),
  transcriptPath: (codexHome, rel) => path.join(codexHome, 'sessions', rel),
  findAgentPid: findCodexPid,
  parseFile: parseCodexFile,
  detectWaitingForInput: codexTurnEnded,
  detectIdle: codexTurnEnded,
  getPendingApprovalTools: () => [],
  getSessionStatus(conversationPath: string, isProcessRunning: boolean): SessionStatus {
    const messages = parseCodexFile(conversationPath);
    const last = messages[messages.length - 1];
    return {
      isRunning: isProcessRunning,
      isWaitingForInput: isProcessRunning && codexTurnEnded(messages),
      lastActivity: last?.timestamp || 0,
      conversationId: conversationPath,
      currentActivity: isProcessRunning ? codexCurrentActivity(messages) : undefined,
    };
  },
  detectCurrentActivity: (messages: ConversationMessage[]) => codexCurrentActivity(messages),
  edits: codexEdits,
};
