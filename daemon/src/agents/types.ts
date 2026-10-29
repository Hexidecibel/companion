/**
 * The seam between the daemon and a coding agent CLI (Claude Code today,
 * OpenAI Codex CLI). An adapter has two halves:
 *
 * - transcript: where the agent writes its session logs, how to read them into
 *   the agent-neutral ConversationMessage model, and what they mean
 *   (waiting / idle / pending approval, file edits for review).
 * - terminal: how the agent is launched in tmux and how its TUI looks
 *   (prompt box, overlays, choice / permission prompts, start-up screens) and
 *   is driven (key sequences for a choice).
 *
 * Output types stay the daemon's own (types.ts); the web client keeps seeing
 * whatever tool names the agent uses. Nothing here changes a wire protocol.
 */
import type {
  ConversationMessage,
  QuestionOption,
  SessionStatus,
  TerminalChoicePrompt,
} from '../types';
import type { PromptBoxState } from '../prompt-guard';
import type { ToolRole, ToolRoleTable } from './roles';

export type { ToolRole, ToolRoleTable } from './roles';

/** Registered agents. */
export type AgentId = 'claude' | 'codex';

// ---------------------------------------------------------------------------
// Transcript side

/** One unified-diff hunk (Claude's `structuredPatch` shape). */
export interface RawHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** A tool call recognised as a file edit, at tool_use time. */
export interface EditStart {
  /** File path as the agent wrote it (may be relative to the session cwd). */
  file: string;
  /** Best guess before the result is known. */
  kind: 'create' | 'update';
}

/** What a finished edit did, from its tool result. */
export interface EditOutcome {
  kind: 'create' | 'update';
  /** null = the result carried no usable patch. */
  hunks: RawHunk[] | null;
}

/** Edit extraction for the review ledger (Claude: tool_use input + toolUseResult). */
export interface AgentEditExtractor {
  /** null = not an edit (or no target file). */
  editStart(toolName: string, input: Record<string, unknown>): EditStart | null;
  /** `result` is the agent's structured tool result (Claude: entry.toolUseResult), if any. */
  editOutcome(toolName: string, current: 'create' | 'update', result: unknown): EditOutcome;
}

export interface AgentTranscript {
  /** Directory that holds every project's transcripts (Claude: <codeHome>/projects). */
  projectsDir(codeHome: string): string;
  /** Directory name for a working directory under projectsDir (Claude: encodeProjectDir). */
  encodeProjectDir(workingDir: string): string;
  /** Directory holding a working directory's transcripts. */
  projectDirFor(codeHome: string, workingDir: string): string;
  /** Transcript file of one session in an already-encoded project dir. */
  transcriptPath(codeHome: string, encodedProjectDir: string, sessionId: string): string;
  /** The agent's process under a tmux pane (/proc walk), or null. */
  findAgentPid(panePid: number, procRoot?: string): Promise<number | null>;

  /** Parse a transcript file (or its pre-read content) into messages. */
  parseFile(filePath: string, limit?: number, preReadContent?: string): ConversationMessage[];
  detectWaitingForInput(messages: ConversationMessage[]): boolean;
  detectIdle(messages: ConversationMessage[]): boolean;
  getPendingApprovalTools(messages: ConversationMessage[]): Array<{ name: string; id: string }>;
  getSessionStatus(conversationPath: string, isProcessRunning: boolean): SessionStatus;
  /** Status-bar text while the agent works (undefined = nothing to show). */
  detectCurrentActivity(messages: ConversationMessage[]): string | undefined;

  edits: AgentEditExtractor;
  /** Present when the agent has subagents with their own transcripts. */
  subagents?: AgentSubagentCapability;
}

/** Optional: subagent transcripts (Claude: <session>/subagents/agent-*.jsonl + .meta.json). */
export interface AgentSubagentCapability {
  /** Directory with a session's subagent transcripts. */
  subagentDir(sessionTranscriptPath: string): string;
}

// ---------------------------------------------------------------------------
// Terminal side

/** Start-up screen of a freshly launched session. */
export type StartupPaneState = 'ready' | 'bypass_warning' | 'trust_prompt' | 'starting';

export interface PermissionPrompt {
  question: string;
  options: QuestionOption[];
  cleanContent: string;
}

export interface TextChoicePrompt {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: QuestionOption[];
  cleanContent: string;
}

/** One step of a key sequence sent to the pane. */
export type KeyStep =
  | { type: 'key'; key: string }
  /** Literal text (`send-keys -l --`). */
  | { type: 'text'; text: string }
  /**
   * Bracketed paste (`set-buffer` + `paste-buffer -p -d`): the TUI sees one
   * paste, so a fast typed burst is never mistaken for a paste that swallows
   * the Enter after it (Codex).
   */
  | { type: 'paste'; text: string }
  | { type: 'delay'; ms: number };

export interface ChoiceKeyPlan {
  /** Log line describing the choice. */
  description: string;
  /** Logged before sending (e.g. an option that cannot be addressed). */
  warnings: string[];
  steps: KeyStep[];
}

export interface ChoiceRequest {
  selectedIndices: number[];
  optionCount: number;
  multiSelect: boolean;
  otherText?: string;
  /** The box on screen is the agent's folder-trust prompt (its own keys). */
  trust?: boolean;
}

export interface AgentTerminal<PermissionMode extends string = string> {
  /** Shell line typed into a new tmux session to start the agent. */
  launchCommand(permissionMode?: PermissionMode): string;
  /** The rule-bounded input box at the bottom of the pane, and any typed draft. */
  readPromptBox(capture: string): PromptBoxState;
  /** An overlay (task list / details) is up instead of the prompt box. */
  detectOverlay(capture: string, hintLines?: number): boolean;
  /** "Do you want to ...?" permission box rendered as text. */
  parsePermissionPrompt(content: string): PermissionPrompt | null;
  /** A numbered choice box (e.g. AskUserQuestion) rendered as text. */
  parseTextChoicePrompt(content: string): TextChoicePrompt | null;
  /** The choice box live at the bottom of a pane capture. */
  detectActiveChoicePrompt(paneOutput: string): TerminalChoicePrompt | null;
  /** Matches a pane that shows a tool-approval prompt. */
  approvalPromptRe: RegExp;
  /** Keys that answer a choice box. */
  choiceKeys(req: ChoiceRequest): ChoiceKeyPlan;
  /** Trust / bypass-permissions warning / ready / still starting. */
  classifyStartupPane(pane: string): StartupPaneState;
  /** Keys that type free text into the prompt box and submit it. */
  textKeys(text: string): KeyStep[];
  /** Keys that stop the running turn (Claude: Ctrl+C; Codex: Esc, its Ctrl+C quits). */
  interruptKeys(): KeyStep[];
  /**
   * Answer a choice only while the box is live on screen: a key sent to the
   * bare prompt box would be typed into it (Codex: a digit) or interrupt.
   */
  requiresLiveChoiceBox?: boolean;
  /** Environment for a newly launched agent's tmux session (Codex: CODEX_HOME). */
  launchEnv?(ctx: { codexHome?: string }): Record<string, string>;
}

// ---------------------------------------------------------------------------

export interface AgentAdapter<PermissionMode extends string = string> {
  id: AgentId;
  displayName: string;
  /** Tool name -> role, and which tools need approval. */
  tools: ToolRoleTable;
  toolRole(name: string): ToolRole;
  transcript: AgentTranscript;
  terminal: AgentTerminal<PermissionMode>;
}
