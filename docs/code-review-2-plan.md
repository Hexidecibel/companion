# Code Review 2.0 — implementation plan (authoritative)

## 0. Findings that shape the plan
- `get_session_diff` (`daemon/src/handlers/session.ts` ~L424; file has a raw `\x01` — use `grep -a`) is a process-storm: `exec` per file through a shell (N+1 shells), SIGTERM-only timeout, no dedupe, default 1 MB maxBuffer (silent loss).
- `web/src/hooks/useCodeReview.ts` refetches on EVERY `conversation_update` → ~61 shells per JSONL flush on a 30-file session. Same failure class as fork-bomb commit 3058a0a.
- JSONL read with `readFileSync` (blocks loop on 50 MB); only current conversation file (pre-`/clear` changes lost).
- Untracked filter compares absolute `fc.path` vs repo-relative porcelain paths → new untracked files silently dropped.
- JSONL already has exact per-edit patches: Edit/Write `tool_result` → `toolUseResult.structuredPatch` (`[{oldStart,oldLines,newStart,newLines,lines[]}]`); Write has `type:'create'|'update'` + `content`. `originalFile` missing in ~2/3 of Edits (don't rely). User entries carry `promptId`, `uuid`.
- Session-scoped `broadcast(type,payload,sessionId)` only reaches a client's single `subscribedSessionId` → split view's 2nd pane misses it. Review events must be GLOBAL with `sessionId` in payload.
- Reuse: `herald/danger.ts` (`w()` helper, secrets/production/destructive rules), `herald/knowledge/redact.ts` (`redactSecrets`, `isDeniedPath`), atomic debounced write pattern (`herald/store.ts`, utils), `HoldToConfirm` (private in `HeraldActionCard.tsx`), `InboxChimeTracker`, `chime.ts`, ask links (`asks.ts`), web deps `highlight.js`, `react-virtuoso`.

## 1. Architecture
Two sources of truth:
| Concern | Source |
|---|---|
| Turn grouping, per-edit hunks, inline chips, live view, turn summaries | Transcript ledger (JSONL tool_use + structuredPatch) — exact, no subprocess, works non-git |
| Net "by file" view, renames, binary, modes, Bash-made deletions, unattributed changes, file revert | Git via bounded GitRunner |
| "Since you looked" net baseline | Checkpoint snapshot tree (temp-index `git write-tree`) |

### Data model (daemon)
- **Ledger** (`review/ledger.ts`, memory, LRU 24 sessions): per session `turns: LedgerTurn[]`, `edits: Map<toolUseId, LedgerEdit>`, `fileOffsets: Map<convPath,{offset,carry}>`; incremental tail from byte offsets; lazy rebuild after restart.
  - Turn openers: `type:'user'` not `isMeta`/`isSidechain`/`isCompactSummary`, string/text content, no `tool_result` blocks. `turnId = entry.uuid`. `<command-name>` entries count as prompts (label=command). `<task-notification>` opens turn labelled "Background task". `<local-command-*>` attach to current turn.
  - Edit/Write/MultiEdit/NotebookEdit `tool_use` → pending edit in current turn; matching `tool_result` completes: structuredPatch→hunks, Write create→all `+`, `is_error`→failed.
  - Turn end = timestamp of entry before next opener; last turn `endedAt=null` while working.
  - Subagent sidechain files attributed to parent turn by time window (Phase 2).
- **Checkpoint** (persisted), key = app sessionId (tmux name) + `projectPath` (reused tmux name with different project resets):
  `{ reviewedThrough: ms, approvedTurnIds: string[], snapshots: [{repoRoot, tree}], baseline?: [{repoRoot, tree}], updatedAt, updatedBy }`
  Edit unreviewed iff `edit.at > reviewedThrough && !approvedTurnIds.includes(edit.turnId)`; approvals stay individual (reversible: un-approving makes the turn unreviewed again) and are compacted into `reviewedThrough` only by "mark all reviewed".
- **Snapshot trees:** copy repo index (`git rev-parse --git-path index`, worktree-correct) to temp; `GIT_INDEX_FILE=tmp git add -A [-- paths]`; `git write-tree`. Taken at mark-reviewed/approve, and baseline first time a session with empty ledger is seen. Net diff: temp-index snapshot of "now" restricted to touched paths, `git diff --cached -M <tree> -- <pathspec>`; cached by `(repo, baseTree, now-fingerprint)`. Writes dangling objects only (never refs). If gc pruned a tree → fall back to HEAD + "checkpoint snapshot expired".
- **Risk** — pure `classifyChangedFile` in `danger.ts`:
  | Kind | Level | Examples |
  |---|---|---|
  | migration | high | `migrations?/`, `db/migrate`, `*.sql`, `prisma/migrations` |
  | ci | high | `.github/workflows`, `.gitlab-ci.yml`, `.circleci`, `Jenkinsfile`, `bin/deploy*` |
  | env | high | `.env*` |
  | secrets | high | `*.pem`, `*.key`, `id_*`, `credentials*`, `secrets.*`, keystore; added lines where `redactSecrets(line)!==line` |
  | agent_config | high | `.claude/settings*.json`, `.claude/hooks`, `.husky`, `.git/hooks` |
  | permissions | high | mode change, sudoers, `*.service` |
  | security | high | paths under auth, security, crypto, encryption, audit-log |
  | deleted | medium (high >100 lines) | |
  | config | medium | `*config.*`, tsconfig, vite.config, nginx/haproxy, Dockerfile, compose |
  | dependency | medium | package.json dependency blocks |
  | large_rewrite | medium | >300 changed lines or >60% of file |
  | lockfile | low, trivial | |
  | binary | low | |
  | outside_project | low | outside session project; scratchpad & os.tmpdir() excluded entirely |
  | foreign | medium | another session's ledger also touched the file |
- **Heat** 0–100: `25·log2(1+churn/10) + 15·min(edits,4) + {high:30,medium:15} + (changed<10min ? 10 : 0)`, cap 100.
- **Trivial** (collapsed): `whitespace` (every hunk removed==added after whitespace strip), `lockfile`, `generated` (`dist/`, `build/`, `*.min.*`, `__snapshots__`, `*.snap`).
- **Turn summary** (free, pure `review/summarize.ts`): last assistant text → `flattenMarkdown` → strip filler ("Done.", "All set", "Summary:") → "I've fixed X…"→"Fixed X" → first sentence, clip at word boundary to 60 chars; fallback to prompt, then files ("Edited echoGuard.ts and 2 more"). `summary = "${gist}: ${n} file(s), +A -D"`. Optional LLM polish: Herald provider (Haiku), one batched call ≤20 turns, explicit request only, cached by `turnId+fnv1a(text)`, metered via Herald usage.

### Persistence
| Data | Where |
|---|---|
| Checkpoints, baselines, polish cache | `~/.companion/review/state.json` (0600, 1 s debounced atomic write, sanitized on load, corrupt moved aside, prune sessions unseen 30 days; override `COMPANION_REVIEW_STATE_DIR`; sandbox HOME isolates) |
| Revert backups | `~/.companion/review/backups/<backupId>/` (prune 24 h or 200 MB) |
| Audit | existing `~/.companion/audit.log` via AuditLog |
| Risk alerts | Herald state.json (like answer items) |
| Ledger, diff caches | memory |

## 2. Protocol contract (EXACT — byte-identical mirror)
Daemon owns `daemon/src/review/protocol.ts`; web `web/src/types/review.ts` byte-identical, enforced by `web/src/types/__tests__/reviewProtocolMirror.test.ts` (copy Herald mirror test approach, markers below). `daemon/src/types.ts` adds `export * from './review/protocol'`; `web/src/types/index.ts` adds `export * from './review'`. Mark old `FileChange` `@deprecated`, keep it. Daemon builder commits this file FIRST (Phase 0); web builder pastes the same text.

```ts
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
```

Message table (response type = request type):
| Type | Request | Response |
|---|---|---|
| review_summary_list | `{}` | ReviewSummaryListResponse |
| review_get | ReviewGetRequest | ReviewGetResponse |
| review_get_file | ReviewGetFileRequest | ReviewGetFileResponse |
| review_get_edits | ReviewGetEditsRequest | ReviewGetEditsResponse |
| review_mark_reviewed | ReviewMarkRequest | ReviewMarkResponse |
| review_approve_turn | ReviewApproveTurnRequest | ReviewMarkResponse |
| review_watch | ReviewWatchRequest | ReviewWatchResponse |
| review_ask | ReviewAskRequest | ReviewAskResponse |
| review_revert_preview | ReviewRevertPreviewRequest | ReviewRevertPreviewResponse |
| review_revert | ReviewRevertRequest | ReviewRevertResponse |
| review_revert_undo | ReviewRevertUndoRequest | ReviewRevertUndoResponse |
| review_polish_summaries | ReviewPolishRequest | ReviewPolishResponse |
| get_session_diff (compat) | unchanged | unchanged `{fileChanges, sessionId}` — reimplemented on ledger + one bounded GitRunner diff so old mobile/desktop builds stay safe |

Herald protocol addition — add to `HeraldInboxItem` in BOTH `daemon/src/herald/protocol.ts` and `web/src/types/herald.ts`, identical text:
```ts
  /** A risky code change (Code Review): toned like news, never spoken unasked. */
  review?: { level: 'high' | 'medium'; kinds: string[]; paths: string[] };
```

## 3. File-by-file

### Daemon workstream (incl. Herald)
New `daemon/src/review/`:
- `protocol.ts` (contract).
- `git-runner.ts` — ONLY way review code runs git: `execFile('git', ['-c','core.quotepath=off','-c','color.ui=never','-c','core.fsmonitor=false', ...args])`; env `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`; diffs always `--no-ext-diff --no-textconv`. Timeouts: rev-parse/status 4 s, diff 8 s, add/write-tree 10 s, apply 4 s; `killSignal:'SIGKILL'`; maxBuffer 8 MB (overflow → `too_large`). In-flight dedupe keyed `cwd+args+env+stdin hash`. Global semaphore 3, queue ≤20 else reject `busy`. Per-repo breaker: 3 timeouts in 60 s → `degraded:'timeout'` 5 min. Pathspecs via stdin (`--pathspec-from-file=- --pathspec-file-nul`), never argv. Injectable `spawnFn`. Honour `config.git===false` → never exec, report `git_disabled`.
- `repo.ts` — `resolveRepo(dir)` via one `rev-parse --show-toplevel --absolute-git-dir --git-common-dir --abbrev-ref HEAD`, cached 60 s + in-flight dedupe; ≤4 repos/session.
- `jsonl-tail.ts` — async incremental reader (fs.promises open/read from offset, carry partial last line, rescan if file shrinks); skip lines >8 MB (count them).
- `ledger.ts` — turn/edit extraction per §1; chain via `watcher.getConversationChain`.
- `diff-parse.ts` — git unified diff parse (rename from/to, new/deleted, old/new mode, `Binary files … differ`, `\ No newline`, CRLF, `-z` numstat) → ReviewFileChange/ReviewHunk, line clipping.
- `snapshot.ts` — temp-index snapshot + `netDiff(repo, baseTree, paths)`; gitignored paths (e.g. `.env`) fall back to transcript hunks.
- `analyze.ts` — trivial, heat, stats (pure).
- `summarize.ts` — free gists (pure) + optional LLM polish adapter.
- `store.ts` — checkpoint persistence (copy HeraldStore pattern).
- `revert.ts` — preview, token, CAS apply, backup, undo, per-repo mutex, audit.
- `service.ts` — ReviewService: subscribes to watcher `conversation-update` (300 ms debounce/session) and `status-change` (turn end → one `git status --porcelain=v2 -z` per repo only if the turn used Bash → unattributed counts + risk); builds + throttles summary broadcasts; watchers `Map<clientId, Set<sessionId>>` + `dropClient()`; risk alerts (high only, dedupe per session+path+kind 30 min, coalesce 20 s window); `heraldDigest(sessionId, scope)`; `relayAsk` composition.
- `index.ts`.
New `daemon/src/handlers/review.ts`: the 12 handlers + `get_session_diff` compat shim; delete the old body in `handlers/session.ts`.
Edits: `handlers/index.ts` (register); `handler-context.ts` (`review: ReviewService|null`, `sendToClient(clientId,type,payload):boolean`); `websocket.ts` (construct ReviewService after Herald, wire `onRiskAlert→herald.addReviewAlert`, `review.dropClient(id)` on ws close, `review.shutdown()`, pass review into Herald deps via setter/late binding); `types.ts` (re-export, deprecate FileChange); `herald/danger.ts` (export `w`; add pure `classifyChangedFile(absPath, relPath, stats, addedLines?) → ReviewRiskFlag[]` and `classifyRevert(input) → ClassifyResult`); `herald/tools.ts` (`review_changes` spec, `ToolEnv.review?: { digest(sessionId, scope): Promise<object|null> }`, executor: local sessions only, `safeOk` redaction); `herald/service.ts` (`deps.review`, `relayAsk({sessionId, sessionName, prompt, userText, clientId})` — source `sendText` re-validates pane then `openAsk`; `addReviewAlert(...)`; `resolveReviewAlerts(sessionKey)`); `herald/inbox.ts` (`addReviewAlert`; review items survive "work resumed", removed by resolve/TTL); `herald/store.ts` (persist/sanitize review items alongside answers); `herald/protocol.ts` (`review?`); `herald/fallback.ts` (templated brief line for review items). Docs (`CLAUDE.md`, `FEATURES.md`, plan.md) owned by the daemon builder.

Herald tool spec (exact):
```
name: 'review_changes'
description: "What a session changed in code: its recent turns as one-line summaries, files with +/- line counts, risk flags (CI, migrations, secrets, deletions, config...) and how much the user has not reviewed yet. Use for 'what did Out4 change?', 'anything risky in X?', 'did X touch the deploy script?'. Report counts and at most three file names, risky ones first. Never mention changes that are not listed."
params: { session: SESSION_PROP, scope: { type:'string', enum:['since_last_look','last_turn','all'] } }, required ['session']
```
Returns `{session, scope, mode, unreviewed:{files,turns,additions,deletions}, turns:[{n,summary,ago,risk}] (≤8), files:[{path,plus,minus,status,risks:[reason]}] (≤12, heat order), last_looked_ago, note}`. Add an `example()` case. Spec text static → prompt cache byte-stable after one change.

### Web workstream
New:
- `types/review.ts` (mirror) + `types/__tests__/reviewProtocolMirror.test.ts`.
- `services/reviewStore.ts` — per-server summaries (pub/sub like heraldVolumeStore); listens `review_summary`, `review_reverted`; fetches `review_summary_list` on connect/reconnect; drops stale versions.
- Hooks: `useReviewSummary.ts`; `useReview.ts` (replaces useCodeReview; fetch by scope/view; refetch on summary.version change, 500 ms debounce, single in-flight, only while drawer open); `useReviewLive.ts`.
- `utils/diff/`: `intraline.ts` (pair each `-` block with following `+` block; jsdiff `diffWordsWithSpace`; skip lines >500 chars, hunks >400 lines, pairs similarity <0.3); `highlight.ts` (hljs per hunk side, split HTML into per-line `{text,cls}` segments closing/reopening spans at newlines, merge word-diff ranges); `patchText.ts`. Add `diff` (jsdiff) dep; `@types/diff` only if needed.
- `components/review/`: `ReviewContext.tsx` (session-scoped provider; editsById cache + `getEdits()` batching); `ChangeStrip.tsx`; `ReviewDrawer.tsx` (replaces modal); `TurnGroup.tsx`; `FileDiff.tsx`; `HunkView.tsx` (line context menu: Comment — carry over existing `crmCommentsKey` logic; Ask why; Revert hunk; Copy); `DiffLine.tsx`; `RiskBadge.tsx`; `RevertDialog.tsx` (echo = tap popover; hard_confirm = HoldToConfirm; undo toast); `AskWhyPopover.tsx`; `LiveFeed.tsx`; `EditChip.tsx`.
- `components/common/HoldToConfirm.tsx` (moved out of HeraldActionCard.tsx; that file re-imports it).
- `styles/review.css`.
Edits: `SessionView.tsx` (remove useCodeReview/CodeReviewCard/CodeReviewModal; add `<ReviewProvider>`, `<ChangeStrip>` above message list, drawer; header "Review (N)" opens drawer, badge from summary); `ToolCard.tsx` (`<EditChip toolId=…/>` under Edit/Write/MultiEdit); `types/index.ts` re-export; `types/herald.ts` `review?` field; `services/tts/chime.ts` `risk` tone (two low→high notes then off-motif third: G5, C6, then B5 short); `services/tts/heraldSpeech.ts` (ChimeKind `risk`; tracker returns risk for unseen `item.review` unless a blocked item also present); `hooks/useHeraldVoice.ts` pref `riskTones` (default on), same gating as other tones (chimeOn, announcer, tonesAudible; Gaming plays tones, never speaks); Herald inbox chip with `review` → open session + drawer + mark heard; `SessionSidebar.tsx` unreviewed pill (Phase 2). DELETE `CodeReviewModal.tsx`, `CodeReviewCard.tsx`, `useCodeReview.ts`.
Shared files: only the two mirror files and the one-field Herald protocol edit (exact text above; tests enforce).

## 4. Revert / ask-why / alerts
Revert preview: (1) resolve path; check `allowedPaths` + `isDeniedPath`, sandbox (`isSandbox()` → `sandbox`), `config.git`. (2) pending ledger edit on path, or completed edit within 5 s while session working → `session_editing`. (3) Hunk: build single-hunk patch; copy file to private temp dir; `git apply -R --check` then `git apply -R` on the copy (works outside repos); failure → `conflict` ("the file changed after this edit"). (4) File→head: staged (`git diff --cached --quiet -- p` non-zero) → `staged_changes`; another session's ledger touched it in scope → `foreign_changes` (name it); `HEAD:p` missing → effect `delete`; binary or >2 MB → block. (5) File→checkpoint: blob from snapshot tree (`no_checkpoint` if none). (6) Tier via `classifyRevert`: hard_confirm if effect delete, whole file, high risk present, >200 lines, or session working; else echo. (7) Token: 128-bit, bound to clientId, holds expectedSha + result bytes + tier, 2-min TTL, ≤20 live.
Revert apply: (1) check token/client/tier (`tier_mismatch` on wrong confirm); per-repo mutex; re-check session_editing. (2) copy current file to backup dir. (3) temp file in same dir, same mode, fsync; re-read sha must equal expectedSha else `conflict`; rename over original (or unlink for delete). (4) audit `review_revert` (origin, session, path, target, tier, reasons, confirm, backupId, device, result). (5) bump version, broadcast `review_reverted`. (6) `notifySession` → direct one-liner: "[Companion] I reverted <hunk|file> in <path>; re-read it before editing." (7) Undo requires current sha == post-revert sha; audit `review_revert_undo`. (8) clients authed with `originCredential` must pass `requireRemoteCapability(client,'write')`.
Ask why: text = `Why did you make this change? (from Companion review)` then `path:start-end (turn N: "gist")` then fenced diff ≤40 lines then optional question (≤500 chars). Herald enabled → `herald.relayAsk` validates pane + opens ask link; answer arrives as inbox `answer` item with finished tone (quiet unless voice used recently). Choice prompt on screen → `session_waiting`. Herald disabled → send directly via injector, `via:'direct'`.
Risk alert: deterministic headline ("Out4 changed a CI workflow: deploy.yml", "Out4 deleted 2 files including migrations/003_users.sql"); inbox item `priority:'finished'` + `review`; included in brief me; resolved by `review_mark_reviewed`.

## 5. Edge cases
- Non-git or `config.git=false`: `mode:'transcript'`; files view lists per-file edit hunks in order labelled "per edit, not merged"; no snapshots, no file revert; hunk revert still works via git apply unless git disabled.
- Untracked: temp index `add -A -- paths` includes them; gitignored touched files (`.env`) use transcript hunks `source:'transcript'`, risk still fires.
- Binary: `binary:true`, `hunksOmitted:'binary'`, revert refused v1.
- Huge diffs: REVIEW_LIMITS caps; lockfile/generated always lazy; clip lines; >8 MB git output → `too_large` numstat only; build response until maxResponseBytes, rest `lazy`.
- >2000 untracked → `too_many_untracked`, net view limited to ledger paths.
- Worktrees: per-file-dir repo resolution, temp index from that worktree's `--git-path index`; edits from worktree session into main checkout flagged `outside_project`.
- ≤4 repos per session resolved; others transcript-only.
- Concurrent edits during review: version bumps, open view refetches after 500 ms; "3 new changes" pill at top (no scroll jump); mark uses the `through` the device displayed; `reviewedThrough = max(old, min(through, now))`.
- Revert mid-edit: blocked on pending/very recent edit on path; CAS closes race; Claude Code's own "modified since read" guard + notify line.
- Multi-device: server checkpoints with `updatedBy`; global summaries (split view OK); tokens bound to one connection; mutex + sha → second concurrent revert `conflict`; `review_reverted` toast elsewhere ("Reverted on Phone").
- Daemon restart: ledger lazily rebuilt one session at a time; checkpoints/alerts persist; gc-pruned trees → HEAD + notice.
- Session renamed/reused: projectPath mismatch resets checkpoint; `/clear` chain via getConversationChain (≤20 files).
- Bash-made edits: unattributed in files view; turn-end status scans count them + raise risk alerts.
- Subagent edits: Phase 2 sidechain attribution by time window; until then unattributed via git.
- Herald `review_changes` for remote sessions: reports "only local sessions" for now.

## 6. Phasing
0. Contract first commit (daemon builder): both protocol files + mirror test; GitRunner; `get_session_diff` rebuilt on it (kills shell fan-out). Web Phase 0: stop refetching on every conversation_update (500 ms debounce, single in flight) — one-line fix to useCodeReview, ships same day.
1. "Since you looked": daemon ledger, summaries, store, review_summary_list / review_get (turns view) / mark / approve_turn, review_summary events, free summaries. Web: reviewStore, ChangeStrip, drawer turns view with plain diffs, mark all + approve turn, sidebar pill.
2. Highlights + net view: snapshots + net files view; review_get_file; risk/heat/trivial; renames/binary/modes; unattributed section. Web: intraline + syntax highlighting, collapsed gaps + trivial rows, EditChip via review_get_edits, RiskBadge. Subagent attribution.
3. Actions + live: review_ask via Herald relayAsk; revert preview/apply/undo + audit; review_watch + review_live + LiveFeed.
4. Herald: review_changes tool, risk alerts + `risk` tone, review_polish_summaries.

## 7. Tests
Daemon (jest), fixtures `daemon/src/review/__tests__/fixtures/*.jsonl` from real entry shapes:
- Ledger: prompts, task notifications, `<command-name>`, compaction, meta, sidechain, Edit w/ structuredPatch, Write create+update, MultiEdit, is_error, pending tool_use, malformed line, oversized line, incremental append with partial last line.
- diff-parse: rename, copy, binary, mode change, deletion, no-newline-at-end, CRLF, unicode paths, `-z` numstat.
- danger.ts: table tests for classifyChangedFile, classifyRevert.
- summarize: filler, "I've fixed", empty reply, in-progress turn.
- analyze: whitespace-only, lockfile, heat ordering.
- store: sanitize, corrupt moved aside, prune, monotonic reviewedThrough, approval compaction.
- GitRunner (injected spawn): 2 concurrent identical calls → 1 spawn; timeout → SIGKILL; semaphore ≤3; queue overflow → busy; breaker trips after 3 timeouts; pathspecs via stdin.
- Integration in temp git repos (mkdtemp + git init): snapshot + net diff incl. untracked + gitignored; hunk revert ok; hunk revert refused after later overlapping change; CAS (change between preview and apply → conflict); revert of created file → delete, backup exists, undo restores; staged refused; worktree repo; hunk revert in non-git dir; sandbox refused.
- Handlers: unknown session, expired/foreign token, tier_mismatch, audit entry written.
- Herald: review_changes with fake env → redacted, capped data; review inbox items survive session working again + persist across store round trip; relayAsk opens ask link + refuses when choice prompt on screen.
Web (vitest): review mirror test + existing Herald mirror still passing; intraline pairing + long-line skip; highlight segment merge across newlines; reviewStore drops stale versions; useReview debounce + single in-flight; ChangeStrip states (empty, unreviewed, high risk, live, pulse on version change, reduced motion); RevertDialog echo→tap, hard_confirm→HoldToConfirm; InboxChimeTracker returns risk, blocked wins; EditChip lazy fetch + batching.
Manual: herald probe sandbox for strip/drawer/Herald tool/tones; revert only via jest temp repos (sandbox refuses by design). `bin/test` before deploy.

## 8. Performance
- No polling on hot path: ledger updates from watcher events (300 ms debounce/session, byte-offset tails); no subprocess per conversation_update. Git only when drawer files view open (recompute on events ≤1/2 s, plus 15 s refresh while tab visible), on mark/approve (one snapshot per repo), on revert, once per turn end for turns that used Bash. Initial ledger build sequential, yields between chunks, cap 64 MB scanned/session.
- Every git subprocess: execFile no shell, timeout + SIGKILL, maxBuffer, dedupe, global concurrency 3, per-repo breaker, `GIT_OPTIONAL_LOCKS=0`, one diff per repo per view (not per file).
- Caches: net diffs keyed `(repo, baseTree, fingerprint of touched-path mtime+size + index mtime)` LRU 64 / 32 MB; repo info 60 s; ledger LRU 24; summary broadcast ≤1/s/session, only on change, <1 KB.
- Web: virtualize lists >200 lines (react-virtuoso); highlight only on expand, memo by hunk id, chunked in requestIdleCallback.

## 9. UX
- Change strip (28 px, under session header): bg `#1f2937`, bottom border `#374151`, 3 px left rail by risk (red `#ef4444` high, amber `#f59e0b` medium, `#374151` none). Text `Δ 5 files since you looked · +142 −38` (`#f3f4f6`, tabular nums), ≤2 risk chips, blue live dot (`#3b82f6`, slow breathe) while editing. Right: "Review ›" + check icon "Mark reviewed" (5 s undo toast). New version → 600 ms accent ring pulse (off under reduced-motion). After turn end: "Turn 12 finished · 3 files · Review". Nothing unreviewed → collapses to 4 px rail.
- Drawer (right, 560 px resizable desktop; full-screen sheet mobile): segmented "Since you looked | Everything" and "By turn | By file". Turn cards `#1f2937`: "T12" pill, gist semibold, `3 files · +42 −18 · 4m ago` in `#9ca3af`, Approve check; approved fade to 60% + fold. Files in heat order, "Hot" pill at heat ≥70; trivial collapse into "4 trivial changes (formatting, lockfile)"; gaps "⋯ 42 unchanged lines". Diff colours: added rows `rgba(16,185,129,.10)` word `.35`; removed `rgba(239,68,68,.10)` / `.35`; gutter `#111827`. Sticky footer "Mark all reviewed". Empty: "You're all caught up. Last looked 12m ago." Mobile: swipe right on a turn to approve.
- Keys: j/k hunk, J/K file, n next unreviewed turn, a approve turn, A mark all, w ask why, x revert hunk, t since/everything, v turn/file, l live, o open file, Esc close.
- Inline chips: `echoGuard.ts +12 −3` + unreviewed dot + risk dot; tap expands real hunk in place with Ask why / Revert.
- Revert dialog: reasons list, exact patch, "Tell Claude" checkbox (default on); echo one tap, hard_confirm hold; "Undo" toast 10 s, file header Undo link 10 min.
- Herald: soft distinct `risk` tone on active device only; never spoken unasked; Gaming = tone only. "What did Out4 change?" → grounded summary, risky first, ≤3 files named.

## Critical files
- `daemon/src/handlers/session.ts` (old get_session_diff ~L424; raw control char — `grep -a`)
- `daemon/src/herald/danger.ts`
- `daemon/src/herald/service.ts`
- `daemon/src/websocket.ts`
- `web/src/components/SessionView.tsx`
