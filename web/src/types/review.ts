// --- review protocol v1 ---
// Mirrored byte-for-byte: daemon/src/review/protocol.ts <-> web/src/types/review.ts. No imports.

export type ReviewRiskLevel = 'high' | 'medium' | 'low';
export type ReviewRiskKind =
  | 'deleted' | 'migration' | 'ci' | 'config' | 'secrets' | 'env' | 'lockfile' | 'dependency'
  | 'large_rewrite' | 'permissions' | 'security' | 'agent_config' | 'binary' | 'outside_project' | 'foreign';
export interface ReviewRiskFlag {
  kind: ReviewRiskKind;
  level: ReviewRiskLevel;
  /** Deterministic, human: "CI workflow", "deletes 140 lines". */
  reason: string;
}
export type ReviewTrivialKind = 'whitespace' | 'lockfile' | 'generated';
export type ReviewFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'mode_changed';
export type ReviewMode = 'git' | 'transcript';
export type ReviewScope = 'since_checkpoint' | 'all';
export type ReviewView = 'turns' | 'files';

export interface ReviewHunk {
  /** `<editId>#<n>` (transcript) or `g<fnv1a(absPath+header+lines)>` (git). Stable across fetches. */
  id: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Enclosing function text after the second @@, when git provides it. */
  section?: string;
  /** Unified body lines, each prefixed ' ', '+', '-' or '\\'. */
  lines: string[];
  trivial?: ReviewTrivialKind;
  /** Some lines were clipped to REVIEW_LIMITS.maxLineChars. */
  clipped?: boolean;
}

export interface ReviewEdit {
  /** tool_use id (also ToolCall.id in the conversation). */
  id: string;
  turnId: string;
  tool: 'Edit' | 'MultiEdit' | 'Write' | 'NotebookEdit';
  /** Display path: project-relative inside the session's project, else absolute with ~. */
  path: string;
  absPath: string;
  kind: 'create' | 'update';
  /** tool_result time (ms); pending edits: tool_use time. */
  at: number;
  additions: number;
  deletions: number;
  hunks: ReviewHunk[];
  patchUnavailable?: boolean;
  risks: ReviewRiskFlag[];
  /** tool_use seen, tool_result not yet (live view). */
  pending?: boolean;
  /** tool_result was an error: nothing changed; excluded from stats. */
  failed?: boolean;
}

export interface ReviewTurn {
  /** uuid of the user entry that opened the turn. */
  id: string;
  /** 1-based within the session (stable for a given conversation chain). */
  index: number;
  startedAt: number;
  /** null = still in progress. */
  endedAt: number | null;
  /** User prompt, one line, <= 200 chars. */
  prompt: string;
  /** "Fixed echo guard" */
  gist: string;
  /** "Fixed echo guard: 3 files, +42 -18" */
  summary: string;
  summarySource: 'reply' | 'prompt' | 'files' | 'llm';
  fileCount: number;
  additions: number;
  deletions: number;
  riskLevel: ReviewRiskLevel | null;
  approved: boolean;
  unreviewed: boolean;
  editIds: string[];
}

export interface ReviewFileChange {
  path: string;
  absPath: string;
  /** Renames: previous display path. */
  oldPath?: string;
  status: ReviewFileStatus;
  binary?: boolean;
  additions: number;
  deletions: number;
  risks: ReviewRiskFlag[];
  /** 0..100, higher = review first. */
  heat: number;
  trivial?: ReviewTrivialKind;
  source: ReviewMode;
  /** Turns (in scope) whose edits touched this file. Empty = unattributed. */
  turnIds: string[];
  /** Other sessions whose transcripts touched this file in scope (display names). */
  alsoChangedBy?: string[];
  unreviewed: boolean;
  /** null = not inlined; fetch with review_get_file. */
  hunks: ReviewHunk[] | null;
  hunksOmitted?: 'lazy' | 'too_large' | 'binary' | 'unavailable';
}

export interface ReviewRepo {
  root: string;
  worktree: boolean;
  branch: string | null;
  head: string | null;
  degraded?: 'timeout' | 'too_many_untracked' | 'git_disabled' | 'not_a_repo';
}

export interface ReviewCheckpoint {
  /** Edits at or before this time (ms) are reviewed. 0 = never reviewed. */
  reviewedThrough: number;
  /** Turns approved individually beyond reviewedThrough. */
  approvedTurnIds: string[];
  /** Working-tree snapshots taken when reviewedThrough last moved (git repos only). */
  snapshots: Array<{ repoRoot: string; tree: string }>;
  updatedAt: number;
  /** Device label that last moved it. */
  updatedBy: string | null;
}

export interface ReviewSummary {
  sessionId: string;
  /** Increases on any change (edits, checkpoint, revert). Clients drop older versions. */
  version: number;
  unreviewedFiles: number;
  unreviewedTurns: number;
  unreviewedAdditions: number;
  unreviewedDeletions: number;
  totalFiles: number;
  totalTurns: number;
  /** Highest risk among unreviewed changes. */
  riskLevel: ReviewRiskLevel | null;
  /** Up to 3, unreviewed, highest first. */
  topRisks: Array<ReviewRiskFlag & { path: string }>;
  lastChangeAt: number | null;
  /** The in-progress turn has edits (session is editing now). */
  live: boolean;
  reviewedThrough: number;
  mode: ReviewMode;
}

export type ReviewErrorCode =
  | 'unknown_session' | 'bad_request' | 'unavailable' | 'expired' | 'tier_mismatch'
  | 'blocked' | 'busy' | 'herald_unavailable' | 'session_waiting' | 'not_found';

// Requests: envelope {type, payload, requestId}. Response: same `type`, {success, payload | error, requestId};
// on failure payload = { code: ReviewErrorCode }.

/** review_summary_list */
export interface ReviewSummaryListResponse { summaries: ReviewSummary[] }

/** review_get */
export interface ReviewGetRequest { sessionId: string; scope: ReviewScope; view: ReviewView; turnId?: string }
export interface ReviewGetResponse {
  sessionId: string;
  scope: ReviewScope;
  view: ReviewView;
  turnId?: string;
  summary: ReviewSummary;
  checkpoint: ReviewCheckpoint;
  /** Turns in scope, oldest first (headers for both views). */
  turns: ReviewTurn[];
  /** view 'turns' only (else []), oldest first. */
  edits: ReviewEdit[];
  /** view 'files' only (else []), heat order. */
  files: ReviewFileChange[];
  /** view 'files', git only: changed in the session's repos since the base, claimed by no session transcript. */
  unattributed: ReviewFileChange[];
  repos: ReviewRepo[];
  omitted?: { turns?: number; edits?: number; files?: number };
  computedAt: number;
}

/** review_get_file: full hunks for one file (lazy / too_large in review_get). */
export interface ReviewGetFileRequest { sessionId: string; absPath: string; scope: ReviewScope; turnId?: string }
export interface ReviewGetFileResponse { file: ReviewFileChange; truncated: boolean }

/** review_get_edits: inline chips (by tool_use id). */
export interface ReviewGetEditsRequest { sessionId: string; editIds: string[] }
export interface ReviewGetEditsResponse { edits: ReviewEdit[]; missing: string[] }

/** review_mark_reviewed: through = newest ReviewEdit.at (or computedAt) the device actually showed. */
export interface ReviewMarkRequest { sessionId: string; through: number; device?: string }
/** review_approve_turn */
export interface ReviewApproveTurnRequest { sessionId: string; turnId: string; approved: boolean; device?: string }
export interface ReviewMarkResponse { checkpoint: ReviewCheckpoint; summary: ReviewSummary }

/** review_watch: live edit stream for this connection (live:false stops). */
export interface ReviewWatchRequest { sessionId: string; live: boolean }
export interface ReviewWatchResponse { watching: boolean; summary: ReviewSummary }

/** review_ask: "Ask why" on a hunk. */
export interface ReviewAskRequest { sessionId: string; absPath: string; hunkId: string; editId?: string; question?: string }
export interface ReviewAskResponse { via: 'herald' | 'direct'; askId: string | null; sentText: string }

export type ReviewRevertTarget =
  | { kind: 'hunk'; absPath: string; hunkId: string; editId?: string; scope: ReviewScope }
  | { kind: 'file'; absPath: string; to: 'head' | 'checkpoint' };
export type ReviewRevertBlockCode =
  | 'conflict' | 'session_editing' | 'staged_changes' | 'foreign_changes' | 'not_in_repo'
  | 'binary' | 'too_large' | 'no_checkpoint' | 'sandbox' | 'busy' | 'outside_allowed' | 'git_disabled';
export type ReviewRevertEffect = 'patch' | 'restore' | 'delete';

/** review_revert_preview */
export interface ReviewRevertPreviewRequest { sessionId: string; target: ReviewRevertTarget }
export interface ReviewRevertPreviewResponse {
  /** null when blocked. Bound to this connection. */
  token: string | null;
  tier: 'echo' | 'hard_confirm';
  reasons: string[];
  blocked: { code: ReviewRevertBlockCode; message: string } | null;
  effect: ReviewRevertEffect;
  /** Unified diff of what will change on disk (current -> after revert), clipped to 200 KB. */
  patch: string;
  additions: number;
  deletions: number;
  expiresAt: number;
}

/** review_revert: confirm must be 'hold' for hard_confirm. */
export interface ReviewRevertRequest { token: string; confirm: 'tap' | 'hold'; notifySession?: boolean; device?: string }
export interface ReviewRevertResponse {
  backupId: string;
  absPath: string;
  effect: ReviewRevertEffect;
  undoUntil: number;
  summary: ReviewSummary;
}

/** review_revert_undo */
export interface ReviewRevertUndoRequest { backupId: string }
export interface ReviewRevertUndoResponse { absPath: string; summary: ReviewSummary }

/** review_polish_summaries (optional LLM polish, Herald provider; cached) */
export interface ReviewPolishRequest { sessionId: string; turnIds: string[] }
export interface ReviewPolishResponse { turns: Array<{ id: string; gist: string; summary: string }> }

// Events: envelope {type, success: true, payload}; global (never session-scoped).
/** type 'review_summary': any connected subscribed client; throttled 1/s per session, only on change. */
export interface ReviewSummaryEvent { summary: ReviewSummary }
/** type 'review_live': only connections watching that session. */
export interface ReviewLiveEvent { sessionId: string; phase: 'started' | 'completed' | 'failed'; edit: ReviewEdit }
/** type 'review_reverted': everyone (other devices refresh + toast). */
export interface ReviewRevertedEvent {
  sessionId: string;
  absPath: string;
  effect: ReviewRevertEffect;
  backupId: string;
  by: string | null;
  undone: boolean;
  at: number;
}

export const REVIEW_LIMITS = {
  maxFilesPerView: 300,
  maxEditsPerView: 2000,
  maxInlineHunkLinesPerFile: 400,
  maxFileHunkLines: 5000,
  maxLineChars: 2000,
  maxResponseBytes: 1500000,
  maxGetEdits: 50,
  maxQuestionChars: 500,
  revertTokenTtlMs: 120000,
  undoWindowMs: 600000,
} as const;
// --- end review protocol ---
