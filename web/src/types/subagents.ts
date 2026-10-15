// --- subagents protocol v1 ---
// Mirrored byte-for-byte: daemon/src/subagents/protocol.ts <-> web/src/types/subagents.ts. No imports.

/**
 * starting         - file created, no assistant entry yet
 * running          - working (a tool may be pending for a long time: still running)
 * waiting_child    - its own work is paused on an Agent call / a running child agent
 * done             - the parent got a "completed" task-notification for it
 * done_unconfirmed - its last reply ended the turn and it went quiet, but no notification was seen
 * failed           - the parent got a "failed" task-notification
 * stopped          - stopped by the user (meta stoppedByUser, or a "killed"/"stopped" notification)
 * lost             - no notification, nothing pending and no bytes for 30 min
 */
export type SubagentStatus =
  | 'starting'
  | 'running'
  | 'waiting_child'
  | 'done'
  | 'done_unconfirmed'
  | 'failed'
  | 'stopped'
  | 'lost';

export type SubagentStuckKind =
  | 'repeated_failure'
  | 'loop'
  | 'oscillation'
  | 'no_progress'
  | 'stalled_tool';

export interface SubagentStuck {
  kind: SubagentStuckKind;
  severity: 'medium' | 'high';
  /** Short: "same test failing 6 times". */
  headline: string;
  /** Full sentence: "Same test failing 6 times in 18 min: api.test.ts". */
  summary: string;
  since: number;
}

/** One line of an agent's timeline (bounded ring, newest last). */
export interface SubagentEvent {
  /** tool_use id for tools; a synthetic id otherwise. */
  id: string;
  at: number;
  kind: 'tool' | 'text' | 'notify' | 'resume';
  /** Tool name (kind 'tool'). */
  tool?: string;
  /** Command / file / pattern / text, clipped and redacted. */
  display: string;
  /** Tool still running. */
  pending?: boolean;
  /** Tool result was an error (or a failing test / compiler run). */
  failed?: boolean;
  doneAt?: number;
}

/** Progress from the agent's own TodoWrite list, or "Step N/M:" lines in its text. */
export interface SubagentChecklist {
  done: number;
  total: number;
  current?: string;
  source: 'todo' | 'steps';
}

export interface SubagentTests {
  /** Test commands run (jest, vitest, pytest, cargo test, ...). */
  runs: number;
  /** Runs that failed. */
  failed: number;
  lastFailed: boolean;
  lastAt: number;
}

/** Cumulative usage over every message of the agent. */
export interface SubagentTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  /** subagent_tokens from the latest task-notification, when present. */
  reported?: number;
}

/** Compact per-agent state: list views and live deltas. */
export interface SubagentSummary {
  agentId: string;
  /** Conversation id the agent belongs to (its transcript's sessionId). */
  sessionId: string;
  /** The spawning agent when nested (its file holds the Agent tool_use). */
  parentAgentId?: string;
  /** The Agent tool_use id that spawned it (.meta.json toolUseId). */
  parentToolUseId?: string;
  depth: number;
  /** Description given at dispatch (.meta.json), else the start of the prompt. */
  name: string;
  /** Agent type (general-purpose, Explore, Plan, ...). */
  type?: string;
  background?: boolean;
  worktree?: string;
  model?: string;
  status: SubagentStatus;
  startedAt: number;
  /** Timestamp of the newest transcript entry. */
  lastEntryAt: number;
  endedAt?: number;
  /** What it is doing now: the pending tool, else its last text. */
  activity?: string;
  /** Name of the newest pending tool. */
  pendingTool?: string;
  /** When the newest pending tool started. */
  pendingSince?: number;
  toolCalls: number;
  edits: number;
  filesTouched: number;
  tests?: SubagentTests;
  /** Context size in tokens (newest message's input + cache + output, or the notification's subagent_tokens). */
  tokens: number;
  checklist?: SubagentChecklist;
  stuck?: SubagentStuck;
  /** The task-notification summary ("Agent \"x\" finished"). */
  notifySummary?: string;
  /** The newest timeline events (at most 3). */
  recent: SubagentEvent[];
  /** Only part of the transcript was read (large or old file; counters cover that part). */
  partial?: boolean;
  /** Increments on every change (cheap change detection for clients). */
  version: number;
}

/** Full state of one agent (subagent_get). */
export interface SubagentState extends SubagentSummary {
  /** Tool calls per tool name. */
  tools: Record<string, number>;
  /** Files changed (path, edits), most edited first, at most 50. */
  files: Array<{ path: string; count: number }>;
  timeline: SubagentEvent[];
  lastText?: string;
  /** First part of the prompt, clipped and redacted. */
  prompt?: string;
  /** Result excerpt from the latest task-notification, clipped and redacted. */
  result?: string;
  tokenDetail: SubagentTokens;
  /** Task-notifications seen (a resumed agent notifies again). */
  notifications: number;
}

/** subagent_list: compact states, newest activity first. Omit sessionId for every session on the box. */
export interface SubagentListRequest {
  sessionId?: string;
}

export interface SubagentListResponse {
  agents: SubagentSummary[];
  running: number;
  total: number;
  /** Deterministic one-line rollup ("3 of 5 done. ..."). */
  rollup: string;
  generatedAt: number;
}

export interface SubagentGetRequest {
  agentId: string;
}

export interface SubagentGetResponse {
  agent: SubagentState;
  rollup: string;
}

/** subagent_watch: live deltas for one session (or every session when omitted); live:false stops. */
export interface SubagentWatchRequest {
  sessionId?: string;
  live: boolean;
}

export interface SubagentWatchResponse {
  watching: number;
}

export interface SubagentRollupRequest {
  sessionId?: string;
  agentId?: string;
}

export interface SubagentRollupResponse {
  text: string;
  running: number;
  total: number;
}

/**
 * Event type 'subagent_update': only to connections that sent subagent_watch, at most
 * one per second per connection, changed agents only.
 */
export interface SubagentUpdateEvent {
  /** The sessionId this client's watch named (absent for an every-session watch). */
  sessionId?: string;
  agents: SubagentSummary[];
  /** Agents dropped from the tracker (evicted). */
  removed?: string[];
  at: number;
}

export type SubagentErrorCode = 'bad_request' | 'not_found' | 'unavailable' | 'busy';

export const SUBAGENT_LIMITS = {
  timeline: 40,
  files: 50,
  maxWatches: 16,
  /** Finished agents are kept this long. */
  retainMs: 24 * 60 * 60 * 1000,
  /** Agents kept in memory at most (least recently active evicted first). */
  maxAgents: 300,
  /** Live deltas per connection at most once per this many ms. */
  updateIntervalMs: 1000,
} as const;
// --- end subagents protocol ---
