# Code Review 2.0 (daemon) - working notes

Moved verbatim from `CLAUDE.md` (2026-11-03) to keep the auto-loaded context small.

Authoritative design plan: `docs/code-review-2-plan.md`. This file holds the operational rules.

### Code Review 2.0 (daemon)
Authoritative plan: `docs/code-review-2-plan.md`. Code lives in `daemon/src/review/`, handlers in `daemon/src/handlers/review.ts`.
- **Protocol:** `daemon/src/review/protocol.ts` is mirrored byte-for-byte by `web/src/types/review.ts` (web mirror test enforces it). Change both or neither; only add optional fields.
- **Two sources of truth:** the transcript ledger (`ledger.ts`, async byte-offset JSONL tail, turns + per-edit `structuredPatch` hunks, subagent files attributed via their `.meta.json` `toolUseId`) for turns / chips / live / summaries; git for the net "by file" view (`net-view.ts`: temp-index snapshot of now vs checkpoint snapshot / baseline / HEAD, one tree-to-tree `git diff -M` per repo, unattributed = changed but claimed by no transcript).
- **GitRunner is the ONLY way review code runs git** (`git-runner.ts`): execFile (no shell), SIGKILL timeouts, 8 MB maxBuffer, in-flight dedupe, concurrency 3 + queue 20, per-repo breaker, `config.git=false` honoured, and no pathspecs in argv (it refuses `--`; `add` reads pathspecs from stdin, everything else diffs whole trees and filters in JS). Never add `exec`/shell git calls on a hot path again (fork-bomb history: 3058a0a).
- **No subprocess per `conversation_update`:** watcher events only tail the JSONL (300 ms debounce/session). Git runs when the files view is requested (memo 2 s), on mark/approve (one snapshot per repo), on revert, and once at the end of a turn that ran Bash.
- **Events are GLOBAL** (`review_summary`, `review_reverted`; `review_live` only to connections that sent `review_watch`) with `sessionId` in the payload — a session-scoped broadcast only reaches one pane.
- **State:** `~/.companion/review/state.json` (checkpoints, baselines, polish cache; `COMPANION_REVIEW_STATE_DIR` overrides), revert backups in `~/.companion/review/backups/` (24 h / 200 MB), audit in `~/.companion/audit.log` (`review_revert`, `review_revert_undo`, `review_ask`).
- **Marks must stick:** the web sends a pending mark for the session it was made in (the provider is reused across session switches) with `through` = server `computedAt`; the daemon re-snapshots whenever `through` covers every claimed edit, so unattributed changes clear even if the time cannot move. Unattributed changes are `summary.unattributedFiles`, never `unreviewedFiles`. Ledger scan budgets are per `update()` call, never per ledger lifetime (a lifetime cap froze sessions with 100 MB+ of subagent transcripts).
- **Reverts** refuse in the sandbox (`COMPANION_SANDBOX=1`) by design: test them only in jest temp repos (`daemon/src/review/__tests__/revert.test.ts`).
- **Herald:** `review_changes` tool, risk alerts as inbox items with `review` (resolved by `review_mark_reviewed`), `relayAsk` for "Ask why", `polishGists` for `review_polish_summaries` (metered as Herald usage). `get_session_diff` (response `session_diff`) is a compat shim on the same ledger + one bounded diff.
