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
  /** Conversation id -> how to name it (newer daemons; absent = the client falls back to facts / ids). */
  sessions?: Record<string, SubagentSessionLabel>;
}

/** How a conversation is named in all-sessions views. */
export interface SubagentSessionLabel {
  /** Display name: the session's name, else "a session in <project>". */
  session: string;
  /** App session id (tmux session) when the conversation runs in one. */
  sessionId?: string;
  /** Short project label ("companion"). */
  project?: string;
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
  /** Also return structured facts (Herald's subagent_status, the MCP remote_subagent_status). */
  facts?: boolean;
}

export interface SubagentRollupResponse {
  text: string;
  running: number;
  total: number;
  /** Present when the request asked for facts. */
  facts?: SubagentFacts;
}

/** One agent in "where's it at" facts: structured, clipped and redacted; never transcript text. */
export interface SubagentAgentFacts {
  agentId: string;
  name: string;
  type?: string;
  status: SubagentStatus;
  /** Deterministic sentence ("Bob is running tests (2 failing runs, 4 min)"). */
  line: string;
  elapsedMs: number;
  /** Time since its newest transcript entry (active agents). */
  idleMs?: number;
  /** What it is doing now (active agents). */
  activity?: string;
  /** "3/5" from its checklist. */
  checklist?: string;
  tests?: { runs: number; failed: number; lastFailed: boolean };
  filesTouched: number;
  /** Stuck headline (active agents). */
  stuck?: string;
  /** Task-notification summary (finished agents). */
  summary?: string;
  parentAgentId?: string;
}

/** The agents of one conversation. */
export interface SubagentSessionFacts {
  /** Conversation id the agents belong to. */
  conversationId: string;
  /** App session id (tmux session) when the conversation runs in one. */
  sessionId?: string;
  /** Display name: the session's name, else "a session in <project>". */
  session: string;
  rollup: string;
  running: number;
  total: number;
  failed: number;
  /** Active agents first, then the newest finished ones. */
  agents: SubagentAgentFacts[];
  /** Agents left out (limits). */
  more: number;
}

export interface SubagentFacts {
  rollup: string;
  running: number;
  total: number;
  sessions: SubagentSessionFacts[];
  /** Sessions left out (limits). */
  moreSessions: number;
  generatedAt: number;
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
