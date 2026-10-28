/**
 * Claude Code's transcript side: `<codeHome>/projects/<encoded cwd>/<uuid>.jsonl`,
 * parsed by the existing parser. Thin wrappers only.
 */
import * as path from 'path';
import {
  detectCurrentActivity,
  detectIdle,
  detectWaitingForInput,
  getPendingApprovalTools,
  getSessionStatus,
  parseConversationFile,
} from '../../parser';
import { encodeProjectDir, findClaudePid } from '../../session-identity';
import type { AgentSubagentCapability, AgentTranscript } from '../types';
import { claudeEdits } from './edits';

export const claudeSubagents: AgentSubagentCapability = {
  subagentDir(sessionTranscriptPath: string): string {
    return path.join(
      path.dirname(sessionTranscriptPath),
      path.basename(sessionTranscriptPath, '.jsonl'),
      'subagents'
    );
  },
};

export const claudeTranscript: AgentTranscript = {
  projectsDir: (codeHome) => path.join(codeHome, 'projects'),
  encodeProjectDir,
  projectDirFor: (codeHome, workingDir) =>
    path.join(codeHome, 'projects', encodeProjectDir(workingDir)),
  transcriptPath: (codeHome, encoded, sessionId) =>
    path.join(codeHome, 'projects', encoded, `${sessionId}.jsonl`),
  findAgentPid: findClaudePid,
  parseFile: parseConversationFile,
  detectWaitingForInput,
  detectIdle,
  getPendingApprovalTools,
  getSessionStatus,
  detectCurrentActivity,
  edits: claudeEdits,
  subagents: claudeSubagents,
};
