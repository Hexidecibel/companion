/**
 * Codex CLI's transcript side: rollouts under `<codexHome>/sessions/YYYY/MM/DD/`
 * (keyed by date, the cwd is inside), parsed by `parse.ts`. Read-only.
 *
 * Status rules (from the file alone):
 *   - working: a task_started without its task_complete / turn_aborted
 *   - waiting for input (the app's "turn over" state): the last turn ended
 *   - a tool call without output: running, except an exec_command that asked
 *     for sandbox escalation: that one waits on the approval box (waiting,
 *     and listed as a pending approval). Other approval boxes (edits outside
 *     the sandbox) are only on the pane, read by the terminal half.
 */
import * as path from 'path';
import type { ConversationMessage, SessionStatus } from '../../types';
import type { AgentEditExtractor, AgentTranscript } from '../types';
import { findCodexPid } from './discovery';
import {
  codexAwaitingApproval,
  codexCurrentActivity,
  codexTurnEnded,
  parseCodexFile,
} from './parse';

const codexWaiting = (messages: ConversationMessage[]) =>
  codexTurnEnded(messages) || codexAwaitingApproval(messages).length > 0;

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
  detectWaitingForInput: codexWaiting,
  detectIdle: codexTurnEnded,
  getPendingApprovalTools: codexAwaitingApproval,
  getSessionStatus(conversationPath: string, isProcessRunning: boolean): SessionStatus {
    const messages = parseCodexFile(conversationPath);
    const last = messages[messages.length - 1];
    return {
      isRunning: isProcessRunning,
      isWaitingForInput: isProcessRunning && codexWaiting(messages),
      lastActivity: last?.timestamp || 0,
      conversationId: conversationPath,
      currentActivity: isProcessRunning ? codexCurrentActivity(messages) : undefined,
    };
  },
  detectCurrentActivity: (messages: ConversationMessage[]) => codexCurrentActivity(messages),
  edits: codexEdits,
};
