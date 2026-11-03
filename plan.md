# Implementation Plan

Detailed plans for upcoming work items. Shipped plans are archived in `plans-archive/YYYY-MM.md`; shipped features are in FEATURES.md.

---
## Item: Codex support
**Status:** steps 1-3 done 2026-10-28 (adapter seam, read-only transcript adapter, terminal adapter + launch), merged into main; step 4 not started

Watch and drive OpenAI Codex CLI sessions next to Claude Code ones. Claude Code now sits behind an `AgentAdapter` seam (`daemon/src/agents/`); Codex becomes a second adapter.

**Step 1: adapter seam (done, no behaviour change).**
- `agents/roles.ts`: one tool-name -> role table (`edit | shell | read | search | ask_user | plan_approval | subagent | todo | poll | web | other`) + `requiresApproval`. Claude's table (`agents/claude/tools.ts`) covers every tool in `tool-config.ts` (type-checked) plus MultiEdit, Agent, LS, NotebookRead, BashOutput, TaskOutput, Monitor, KillShell. The hard-coded name sets in watcher.ts, stuck/signals.ts, background-work.ts, subagents/state.ts and review/ledger.ts are role checks now. Two odd members are kept by name: stuck's loop set includes WebFetch (not WebSearch), its poll set includes TodoWrite (not TaskCreate/TaskUpdate).
- `agents/types.ts`: `AgentAdapter` = `tools` + `toolRole` + `transcript` (projectsDir / encodeProjectDir / projectDirFor / transcriptPath / findAgentPid, parseFile, waiting / idle / pending-approval / status, `edits` extractor for the review ledger, optional `subagents`) + `terminal` (launchCommand, readPromptBox, detectOverlay, permission / text-choice / active-choice prompt parsers, approvalPromptRe, `choiceKeys` key plan, classifyStartupPane). `agents/index.ts` = registry, Claude default and only.
- Claude adapter = thin wrappers over parser.ts / prompt-guard.ts / session-identity.ts. Moved into `agents/claude/`: `claudeCommand` + `ClaudePermissionMode` (re-exported from tmux-manager.ts), `classifyStartupPane` (re-exported from herald/spawn.ts), auto-approval's prompt regex, the sendChoice key sequence (InputInjector now executes a `ChoiceKeyPlan`), and the ledger's structuredPatch / create-hunk logic (`agents/claude/edits.ts`).
- Routed through the adapter: watcher.ts (transcript paths, encodeProjectDir, pid finder, waiting / pending approval, active choice prompt, interactive + approval checks), input-injector.ts, auto-approval.ts, tmux-manager.ts, herald/spawn.ts, review/ledger.ts (edits), review/sources.ts (subagent dir), subagent watchers + handlers/session.ts (projects dir), handlers/tmux.ts, herald/session-source.ts, stuck/normalize.ts, herald/babysit/tracker.ts.
- Not routed yet: parser.ts's own `APPROVAL_TOOLS` uses (it IS the Claude implementation), herald/text.ts `TOOL_PHRASES` (per-name speech, not role-identical), the many other parser exports the watcher uses (highlights, activity, chains), raw-JSONL readers (subagents/state + tracker, subagent-watcher-legacy, the watcher fast path, turn-error.ts), session-spawn.ts / prompt-guard.ts internals, `tc.name === 'Bash'` checks in stuck/signals. Every call site still uses `defaultAgent()`; sessions do not carry an agent id yet.

**Step 2: Codex transcript adapter (read-only; done).** `daemon/src/agents/codex/` (`AgentId = 'claude' | 'codex'`, registry has both).
- Discovery (`discovery.ts`): Codex 0.16x does not keep the rollout open in the TUI (a shared `codex app-server` daemon outside tmux owns every thread's rollout + writer lock, several per TUI after /new), so /proc fds cannot map a pane. Instead: codex process under the pane (/proc walk, `node .../bin/codex` or the vendored binary, never `app-server`) -> its cwd + start time + `resume <uuid>` argv -> among rollouts in the date dirs since the start (session_meta cached per file): a thread in that cwd born after the start (newest), else the resumed thread (found by uuid in any date dir, cached), else the newest written since the start; newer processes claim first. Codex home: config `codex_home`, `$CODEX_HOME`, else beside code_home (so the probe's own HOME still reads the real one), else `~/.codex`. Verified on the live codex-test pane (picked 01a18489, not the older 01a18488 in the same folder).
- Parser (`parse.ts`, `CodexAccumulator`, incremental; the transcript cache picks it by file name `rollout-*-<uuid>.jsonl`): user/assistant messages (developer messages and harness-injected user content skipped by `content_item_kinds`, prefix fallback), reasoning hidden, `exec` code-mode calls -> one ToolCall per call named after the inner tool (`exec_command` with the decoded `cmd`s, `justification`, `sandbox_permissions`; `apply_patch` with its files), function_call / local_shell_call / web_search_call generic, output chunks -> output + `isError` from exit codes (status stays completed). Turn end: task_complete -> `stopReason 'end_turn'` on the last message, turn_aborted -> system "Turn interrupted" (`'aborted'`); a call without output is `running`.
- Status: waiting (turn over) = the last turn ended; working = otherwise ("Processing...", "Running: <cmd>", "Working..."); no approval tools by name (`getPendingApprovalTools` = []), no feedback-prompt polling.
- Terminal (`terminal.ts`): approval box parser (question, numbered options with hotkeys, footer or hotkeys required, command / reason / environment) behind `parsePermissionPrompt` / `detectActiveChoicePrompt`; launch `codex`; start-up screen; `choiceKeys` returns an empty plan with a warning; prompt-box guard and overlay = not found.
- Watcher: per refresh, a tagged pane without claude is probed for codex; its path key is `codex:<session>` (never mixed with Claude's cwd-encoded dirs), the session -> rollout mapping is direct (`applyCodexMappings`, the rollout is added to chokidar and loaded), the path-based strategies skip it; `agentFor(session)` / per-file adapter for waiting, activity, pending tools. get_highlights live choice, get_terminal_output and Herald's choice read use the session's adapter; stuck's pane reader also knows Codex's box.
- Live-checked on the probe (private tmux server, a stand-in `codex resume 01a18489-...` process in ~/local/src/codegrind printing the captured approval box): listed as `cdx`, status waiting, 4 highlights (user, assistant + 4 exec_command calls, final answer, live approval choice with 3 options), terminal choicePrompt with header Codex.
- Not done (later steps): answering approvals / choice keys / sending input / launching from the app (step 3), review ledger edits from apply_patch + stuck signals by role (step 4), herald/text tool phrases, Codex compaction events, an exact pane -> thread mapping when two Codex TUIs share a folder and both keep writing older threads.

**Step 3: Codex terminal adapter + launch (done).** Learned on a live Codex 0.165 TUI in a private tmux server (captures in `agents/__tests__/fixtures/codex/live-*`; facts in the header of `agents/codex/terminal.ts`).
- `AgentTerminal` gained `textKeys` (Claude: typed + Enter; Codex: one bracketed paste via set-buffer / `paste-buffer -p -d` + Enter, because a typed burst counts as a paste and swallows the Enter), `interruptKeys` (Claude C-c; Codex Esc: Ctrl+C opens a "Task is still running" dialog when working and QUITS an idle Codex), `requiresLiveChoiceBox` (Codex: a choice is sent only while the box is on screen) and `launchEnv` (Codex: CODEX_HOME). New key step `paste`.
- Codex terminal: composer = last `›` line near the bottom (dim placeholder = empty; a draft refuses a send like Claude's), overlays = transcript pager ("Browsing transcript ... ↵ rewind · esc back"), shortcut sheet, Ctrl+C dialog (never the approval box or trust prompt); approval box exec + edit variants (Destination / Description); choice keys = the option's digit (selects + confirms); "Other" text = Esc (option 3, "tell Codex what to do differently", aborts the turn) + the text as a message.
- InputInjector resolves the agent per tmux session (`setAgentResolver` = `watcher.agentFor`, which also keeps a launched-agent hint until the process is seen) for send / choice / interrupt; a literal `\x03` text to a non-Claude session is its interrupt. `send_terminal_keys` maps a lone `C-c` to the agent's interrupt. Auto-approval and babysit's `isPermissionChoice` know Codex (every Codex choice box is a permission prompt).
- Transcript: an exec_command with `sandbox_permissions: require_escalated` and no output = pending approval (waiting, "Waiting for approval", pending-approval event): Codex writes the call before it draws the box. pickRollout: newest-BORN thread with 1.5 s slack (by latest write, a second Codex started seconds later in the same folder stole the first one's thread). After a send to a Codex session without a rollout yet, discovery re-runs 1.5 s later.
- Launch: optional `agent` on `create_tmux_session` (+ optional `permissionMode: 'default'`), `createAgentSession` (alias `createClaudeSession`), saved config (`agent`, recreate), Herald `propose_spawn_session` (`agent` param, readback "New Codex session in X"), startup-pane classification per agent. Bypass mapping: `codex --dangerously-bypass-approvals-and-sandbox` (no prompts, no sandbox = Claude's bypassPermissions; 0.165 has no `--full-auto`, `--approve-for-me` routes approvals through a reviewer model). Web: Claude / Codex choice in New Session, "Codex" label, Shell / Patch / Plan tool-card names; summary sessions carry optional `agent`.
- Live e2e: `daemon/scripts/codex-control-probe.js` on the probe instance with a private tmux server: 27/27 (spawn + CODEX_HOME + tag, detect, bypass spawn + kill, approve via send_choice, decline with feedback, follow-up, interrupt via send_terminal_keys C-c -> Esc with Codex still running). Plain `codex` in a folder Codex does not trust auto-rejects escalations without asking, so the probe's control session runs `codex -a on-request`.
- Not covered: concierge / remote_dispatch stay Claude-only (MCP + `claude -p`); a login screen counts as 'starting'.
- Polish (2026-10-28): New Project has the Claude / Codex picker (shared `AgentPicker`; `scaffold_open_session` takes `agent` + `permissionMode`, goes through `createAgentSession`, waits for Codex's composer before the kickoff prompt); `switch_tmux_session` keeps the saved agent / permission mode; a "Codex" label in SessionView's header; the Bypass switch is read-only for Codex and shows how the session was LAUNCHED (`codexLaunchMode` on the process argv, else the saved spawn config; never writes `.claude/settings.json`); a non-Claude launch is watched for a few bounded captures for the shell's "command not found" (session removed, "Codex is not installed ... npm install -g @openai/codex"); edit approvals (pane-only, no rollout mark) read as waiting from the captures Herald's listing already takes (`BackgroundWorkMonitor` `paneApproval` / `onPaneApprovalChange` -> `watcher.notePaneApproval` re-emits status on each edge; inert when Herald is off). Probe: 40/40 (adds bypass switch, edit approval waiting, New Project with Codex).

**Step 4: Claude parity (done 2026-10-28).**
- Review: Codex 0.165 writes `event_msg item_completed {item: {type: 'FileChange', id, status, changes: {<abs>: {type: add, content} | {type: update, unified_diff, move_path} | {type: delete, content}}}}` right after an apply_patch (fixture `agents/__tests__/fixtures/codex/parity-edits.jsonl`, sanitized from a real run). The ledger tails rollouts by file name (`ingestCodex`): typed user messages open turns, the apply_patch envelope (`agents/codex/edits.ts` `parsePatchEnvelope`, incl. `*** Move to:`) opens pending edits `<call>#<i>` (a move = destination + `:from` source), the FileChange completes them with exact hunks (`parseUnifiedHunks`; add = all `+`, delete = all `-`), a call output with no FileChange fails them; exec snippets with commands and CommandExecution items set `usedBash` (sed -i / heredocs -> the end-of-turn git scan, unattributed). Wire `tool` stays Claude's names (apply_patch -> Edit / Write). The parser now decodes `tools.apply_patch("...")` positional patches (they were lost) and keeps commands beside a patch.
- Stuck: roles over every agent's table (`isShellToolName`, `anyAgentRole`), apply_patch = edit, turn phase per agent (`StuckDetectorDeps.agentOf`; Codex works until task_complete / turn_aborted, an escalation request waits).
- Herald: TOOL_PHRASES for Codex tools, pending approvals through the session's adapter, `[Codex]` on the snapshot line + `agent` in session views, prompt mentions Codex. propose_spawn_session with agent / profile was already in.
- Rollout events: compacted / context_compacted -> one marker + a watcher compaction event (no post-compaction remap); `event_msg error` -> an "Error: ..." assistant message (`codex-error-` id) that turn-error.ts escalates as "Codex: ..."; task_complete's `last_agent_message` added when missing.
- Remote dispatch: `remote_dispatch_spawn` / MCP `remote_dispatch` take `agent`, `profileId`, `permissionMode` (createAgentSession + the agent's readiness; trust prompt = `agent_not_ready`; one-shot `codex exec`). Concierge stays Claude (it relies on Claude's MCP config).
- Usage: `UsageMonitor` reads each Codex profile's newest rollout `token_count.rate_limits` (5-hour / weekly) -> the same usage_warning thresholds (`agents/codex/usage.ts`).
- Probe: `daemon/scripts/codex-parity-probe.js`.
- Fixes after the first real use (2026-10-28, a Codex session created from the app in doc-upload-site, bypass mode):
  - Old Claude transcript shown: for the launch check's ~5 s the watcher had no agent hint and no new-session guard, and a pane without a codex process was keyed by its cwd (Claude's projects dir), so `ensureConversationLoaded` (get_highlights / switch_session / Herald) loaded the folder's newest Claude JSONL. Now: hint + guard before the check, hinted Codex sessions keyed `codex:` without a process, the on-demand loader never scans Claude dirs for Codex or brand-new sessions, cwd fallbacks per agent, hints restored from the saved tmux configs at start.
  - "Discovery took 53 s": not discovery. The first send hit Codex's trust prompt (bypass mode asks too, in an untrusted git folder): the paste was dropped and its Enter answered "Trust and continue" (config.toml written at that second); no turn started until the user typed in the terminal 50 s later, and the rollout (born then) was mapped 3 s after it appeared. Now: sends are refused while the trust prompt / a Codex box is up, a sessions-dir fs.watch + send nudges map a new rollout in ~1 s.
  - Trust prompt is a choice the user taps ("Yes, trust" / "No"), the session reads waiting meanwhile; never auto-answered (babysit / Herald / auto-approval / spawn). Codex: Yes = 1 + Enter, No = 2 + Ctrl+C (Codex exits).
  - Tests: `__tests__/watcher-codex-isolation.test.ts`, `agents/__tests__/trust.test.ts`, injector cases; `codex-control-probe.js` phase 8 (`--trust-only`): 54/54.
  - Web: `describeSendError` shows the new `prompt_waiting` refusal (older apps just keep the text; the trust choice itself needs no web change).
- Not done: review chips under Codex tool cards in the chat (web: `EDIT_CHIP_TOOLS` lacks apply_patch and Codex edit ids are `<call>#<i>`; needs a web change + APK); edit approvals read as waiting only while Herald runs (pane captures); a pane -> thread mapping when two Codex TUIs share a folder.

## Item: Connection resilience
**Status:** phase 1 done 2026-10-18 (web only; follow-up fix: no stale status across a session switch, event-driven summary re-poll); phases 2-3 designed, not started

Stop the app freezing on flaky connections and never blank / flash sessions during interruptions.

**Phase 1 (done, web only):** zombie-socket fix (per-socket handlers, close + detach on every drop), kick never interrupts a fresh connect / resets backoff, queued sends flush only after auth, re-render churn cut (health throttle, memoized context, push re-register on server-set change, summary identity + in-flight guard + out-of-order discard, conversation merge by id + tail-only polls), composer never disabled + "May not have sent" Retry / Discard notice, IndexedDB offline cache (summaries + last 50 messages x 30 sessions, LRU ~5 MB, schema-versioned, memory fallback) with stale-while-revalidate UI ("Reconnecting · updated Xm ago", sessions clickable, cached conversation readable offline). Harness `bin/e2e-flaky-net`. MessageList virtualization skipped (scroll-to-question / flash in `sessionFocus.ts` and the time grouping in `messageTime.ts` make it risky; revisit separately).

**Phase 2 (designed):** durable outbox: queued messages persisted (IndexedDB) with a `clientMsgId`; the daemon dedupes on `clientMsgId` so a retry after an uncertain send never types twice; a message queued for more than 10 min needs a confirm before it is sent; an undo window exists but is off by default.

**Phase 3 (designed):** attachments in the outbox (later).

## Item: Code Review 2.0
**Status:** done (daemon + Herald); web workstream in progress

Authoritative design, protocol contract and tests: `docs/code-review-2-plan.md`.

Daemon shipped in four phases (commits `feat(review): ...`, `feat(herald): review_changes ...`):
0. Protocol contract (`daemon/src/review/protocol.ts`), bounded GitRunner, `get_session_diff` rebuilt on the ledger + one bounded diff (fixes the N+1 shell fan-out and dropped untracked files).
1. Ledger, checkpoint store, free summaries, risk classification, `review_summary_list` / `review_get` (turns) / `review_mark_reviewed` / `review_approve_turn`, global `review_summary` events.
2. Snapshots + net files view, `review_get_file`, `review_get_edits`, renames / binary / modes, unattributed section, subagent attribution.
3. `review_ask` via Herald `relayAsk`, revert preview / apply / undo (CAS, backups, audit, tiers), `review_watch` / `review_live`.
4. Herald `review_changes` tool, risk alerts in the inbox (`review` field), fallback lines, `review_polish_summaries`.

Needs a user-approved daemon restart to go live. Known gaps: no on-wire notice when a checkpoint snapshot was gc-pruned (silently falls back to HEAD); turn-end unattributed scans use the net diff (not `git status`).

---

## Item: Diff line number gutter
**Status:** planned

### Requirements
- Render line numbers in a left gutter alongside diff lines in CodeReviewModal
- Use the existing `displayLineNum` already computed per line for line comments
- Added/removed/context lines show their number; hunk and meta lines show nothing

### Files to Modify
- `web/src/components/CodeReviewModal.tsx` — Add `<span className="crm-line-num">` before line content
- `web/src/styles/global.css` — Add `.crm-line-num` styles (monospace, muted color, fixed width)

### Implementation Steps
1. In the diff line rendering IIFE (lines 207-244), wrap each line in a flex row: `<span className="crm-line-num">{displayLineNum || ''}</span><span>{line || '\n'}</span>`
2. Add CSS: `.crm-line-num { width: 40px; text-align: right; color: #6b7280; user-select: none; flex-shrink: 0; }`
3. Update `.code-review-diff-line` to `display: flex`

### Tests Needed
- Visual verification: hunk lines have no number, context/added/removed lines show correct numbers
- Typecheck passes

---

## Item: Sticky comment threads on files
**Status:** planned

### Requirements
- Persist line comments in localStorage so they survive modal close/reopen
- Show previous comments as annotations on the diff when reopening review modal
- Scoped per session + file path
- Clear comments when session changes or user dismisses

### Files to Modify
- `web/src/components/CodeReviewModal.tsx` — Load/save comments, render annotations on diff lines
- `web/src/styles/global.css` — Annotation styles

### Implementation Steps
1. Define `CommentThread = { filePath: string; lineNumber: number; lineText: string; comment: string; timestamp: number }`
2. On comment submit (before calling `onComment`), also save to localStorage key `crm-comments:${sessionId}`
3. On mount / when expanding a file, load saved comments and match by filePath + lineNumber
4. Render matched comments as a small annotation div below the diff line: `.crm-saved-comment { font-size: 11px; color: #9ca3af; padding: 2px 0 2px 40px; }`
5. Add "Clear comments" button in modal header (only shown when comments exist)
6. Pass `sessionId` as a new prop to CodeReviewModal

### Tests Needed
- Comments persist after closing and reopening modal
- Comments for different sessions don't bleed
- Clear button removes all comments
- Typecheck passes

---

## Item: Session activity sparkline
**Status:** planned

### Requirements
- Tiny inline SVG in sidebar showing message frequency over last 30 minutes
- One bar per minute, height proportional to message count in that minute
- Placed between session name and relative time in sidebar items

### Files to Modify
- `web/src/components/SessionSidebar.tsx` — Add sparkline component inline in session item (around line 595)
- `web/src/components/MobileDashboard.tsx` — Add sparkline in MobileSessionItem
- `web/src/types/index.ts` — Add `recentTimestamps?: number[]` to `SessionSummary` (or compute client-side)

### Implementation Steps
1. Create `web/src/components/Sparkline.tsx` — pure component taking `timestamps: number[]` and rendering an SVG
2. Compute 30 bins (1 per minute), normalize to max height of 16px, render as `<rect>` bars
3. In SessionSidebar, pass `session.recentTimestamps` (if daemon provides) or compute from cached highlights
4. **Option A (simpler):** Daemon adds `recentTimestamps` to `server_summary` response — array of last 30 message timestamps
5. **Option B (client-only):** Use cached highlights timestamps from `SessionCache` — no daemon change needed
6. Style: width ~60px, height 16px, bars colored `#3b82f6` with 1px gap, no axis labels

### Tests Needed
- Sparkline renders 0-bar state gracefully (empty array)
- Correct bin assignment for edge timestamps
- Typecheck passes

---

## Item: Batch approve pending tools
**Status:** planned

### Requirements
- When multiple tool calls are pending approval in the last message, show an "Approve all (N)" button
- Uses existing `send_choice` / key-sequence infrastructure
- Sends approvals sequentially with small delay between each

### Files to Modify
- `web/src/components/MessageBubble.tsx` — Add batch approve button above individual approval prompts
- `daemon/src/parser.ts` — Ensure multiple pending tools in same message all get options

### Implementation Steps
1. In MessageBubble, detect when `message.toolCalls` has multiple pending approval tools
2. Render a "Approve all (N)" button before the individual tool cards
3. On click, iterate through each pending tool and send approval via `onSelectChoice({ selectedIndices: [0], optionCount: 3, multiSelect: false })` with a 500ms delay between each (CLI needs time to process each)
4. Disable individual approve buttons while batch is in progress (use a `batchApproving` state)
5. Show progress: "Approving 2/5..."

### Tests Needed
- Button only appears when 2+ tools are pending
- Sequential sends with delay don't race
- Typecheck passes

---

## Item: Message bookmarks
**Status:** planned

### Requirements
- Right-click (or long-press on mobile) a message to bookmark it
- Bookmarks stored in localStorage, keyed per server
- Accessible from a "Bookmarks" button in session header
- Tapping a bookmark scrolls to that message (if still loaded)

### Files to Modify
- `web/src/components/MessageBubble.tsx` — Add "Bookmark" / "Remove bookmark" to context menu (line ~556)
- `web/src/hooks/useBookmarks.ts` — New hook for bookmark CRUD
- `web/src/components/BookmarkList.tsx` — New dropdown/popover showing bookmarks
- `web/src/components/SessionView.tsx` — Add bookmarks button to header, pass bookmark state to MessageList/MessageBubble
- `web/src/types/index.ts` — Add `Bookmark` interface

### Implementation Steps
1. Define type: `Bookmark { messageId: string; serverId: string; sessionId: string; content: string; timestamp: number }`
2. Create `useBookmarks(serverId)` hook — reads/writes `companion_bookmarks:${serverId}` localStorage key
3. Add "Bookmark" item to MessageBubble context menu. If already bookmarked, show "Remove bookmark"
4. Show bookmarked messages with a subtle left-border accent (e.g., `border-left: 2px solid #f59e0b`)
5. Create BookmarkList component — simple dropdown listing bookmarks with content preview and relative time
6. On click, scroll to message via `data-highlight-id` selector. If not loaded, show "Message not in view"
7. Add "Bookmarks (N)" button in session header viewButtons section

### Tests Needed
- Bookmark persists across page reload
- Remove bookmark works
- Bookmark indicator renders on correct message
- Typecheck passes

---

## Item: Centralize localStorage keys into storageKeys.ts
**Status:** planned

### Requirements
- Single source of truth for all localStorage key strings
- Typed key builder functions for session/server-scoped keys
- Replace 38+ hardcoded string keys across the codebase

### Files to Modify
- `web/src/services/storageKeys.ts` — New file with all key constants and builders
- All files using localStorage — Import keys from storageKeys.ts

### Implementation Steps
1. Create `web/src/services/storageKeys.ts` with:
   - Static keys: `SERVERS_KEY`, `FONT_SCALE_KEY`, `HISTORY_KEY`, `DEVICE_ID_KEY`, `AWAY_KEY`
   - Builder functions: `hideToolsKey(sessionId)`, `openFilesKey(serverId, sessionId)`, `autoApproveKey()`, `bookmarksKey(serverId)`, `notifPrefsKey()`, etc.
2. Find/replace all hardcoded localStorage key strings across:
   - `services/storage.ts` (lines 4, 6)
   - `services/history.ts` (line 8)
   - `services/openFiles.ts` (line 6)
   - `services/BrowserNotifications.ts` (line 10)
   - `services/push.ts` (line 24)
   - `services/recentDirectories.ts` (line 3)
   - `hooks/useAutoApprove.ts` (line 3)
   - `hooks/useAwayDigest.ts` (line 8)
   - `components/SessionView.tsx` (line 116)
3. Import from centralized module in each file

### Tests Needed
- All existing functionality still works (keys unchanged, just centralized)
- Typecheck passes
- No duplicate key values

---

## Item: Extract QuestionBlock and MultiQuestionFlow out of MessageBubble.tsx
**Status:** planned

### Requirements
- Move QuestionBlock, QuestionBlockSingle, MultiQuestionFlow, and AnswerData/ChoiceData types to a dedicated file
- MessageBubble imports from the new file
- No behavior changes

### Files to Modify
- `web/src/components/QuestionBlock.tsx` — New file with extracted components
- `web/src/components/MessageBubble.tsx` — Remove ~300 lines, add imports

### Implementation Steps
1. Create `web/src/components/QuestionBlock.tsx`
2. Move these from MessageBubble.tsx:
   - `ChoiceData` interface (lines 10-15)
   - `QuestionBlockProps` interface (lines 30-34)
   - `QuestionBlock` function (lines 36-175)
   - `MultiQuestionFlowProps` interface (lines 187-190)
   - `MultiQuestionFlow` function (lines 192-311)
   - `AnswerData` interface (lines 313-317)
   - `QuestionBlockSingleProps` interface (lines 319-322)
   - `QuestionBlockSingle` function (lines 324-410)
3. Export all public interfaces and components from QuestionBlock.tsx
4. In MessageBubble.tsx, `import { QuestionBlock, MultiQuestionFlow, ChoiceData } from './QuestionBlock'`
5. Re-export `ChoiceData` from MessageBubble.tsx if other files import it from there

### Tests Needed
- Typecheck passes
- Question UI still works (single-select, multi-select, other input, multi-question flow)

---

## Item: Named constants for daemon magic numbers
**Status:** planned

### Requirements
- Extract ~90 hardcoded numbers across daemon source into `daemon/src/constants.ts`
- Group by category: timeouts, delays, size limits, display limits, cache TTLs
- Replace in-place references with named imports

### Files to Modify
- `daemon/src/constants.ts` — New file with all named constants
- `daemon/src/input-injector.ts` — Replace 5000ms timeouts, 150ms/50ms/80ms delays
- `daemon/src/websocket.ts` — Replace size limits (5MB, 1MB, 150MB), TTLs (30s, 10min), thresholds
- `daemon/src/parser.ts` — Replace truncation limits (50, 100 chars), rate limit interval (60s)
- `daemon/src/watcher.ts` — Replace debounce (150ms, 3000ms), polling (5000ms), chain limit (20)
- `daemon/src/index.ts` — Replace dedup threshold (1s), cleanup window (30s), approval delay (300ms)

### Implementation Steps
1. Create `daemon/src/constants.ts` with groups:
   - TMUX: `TMUX_SPAWN_TIMEOUT_MS`, `KEY_PRESS_DELAY_MS`, `PRE_ENTER_DELAY_MS`, `POST_ENTER_DELAY_MS`
   - FILES: `MAX_IMAGE_SIZE_BYTES`, `MAX_TEXT_FILE_SIZE_BYTES`, `MAX_APK_SIZE_BYTES`
   - CACHE: `FILE_TREE_CACHE_TTL_MS`, `PENDING_SENT_TTL_MS`
   - POLLING: `FILE_CHANGE_DEBOUNCE_MS`, `WAITING_DEBOUNCE_MS`, `TMUX_REFRESH_INTERVAL_MS`
   - DISPLAY: `LOG_TRUNCATION_LENGTH`, `COMMAND_TRUNCATION_LENGTH`, `SEARCH_DEFAULT_LIMIT`, `SEARCH_MAX_LIMIT`
2. Replace hardcoded values file by file (start with input-injector, then websocket, parser, watcher, index)
3. Leave values that are already named constants (e.g., `MAX_SCROLL_LOGS`) in place

### Tests Needed
- All 442 existing daemon tests pass
- No behavior changes (values identical)

---

## Item: Focus-visible keyboard outlines
**Status:** planned

### Requirements
- Add `:focus-visible` styles to all interactive elements (buttons, inputs, links)
- Consistent blue glow ring matching existing input focus styles
- Don't show on mouse click (`:focus-visible` handles this)

### Files to Modify
- `web/src/styles/global.css` — Add global `:focus-visible` rule and component-specific overrides

### Implementation Steps
1. Add global rule near top of global.css:
   ```css
   :focus-visible {
     outline: 2px solid #3b82f6;
     outline-offset: 2px;
   }
   ```
2. For dark-background elements, the blue outline works well already
3. Remove redundant `:focus` styles on inputs that only set `border-color` — keep the ones that adjust background or other properties
4. Add `outline: none` to elements that have their own `:focus-visible` treatment (e.g., inputs with border-color change)
5. Test tab navigation through: sidebar sessions, header buttons, input bar, tool card approve/reject, context menu items

### Tests Needed
- Tab through major UI flows — every interactive element has visible focus ring
- Mouse clicks don't show focus ring
- Typecheck passes (CSS only)

---

## Item: Fleet (Inbox → Missions → Routing → Health)
**Status:** planned

### Goal & Rationale
Anthropic's built-in Remote Control now covers the single-session phone remote (transcript,
AskUserQuestion, permissions, push). Companion should stop competing on that and instead own the
**fleet / orchestration layer**: many sessions, many machines, one place to see what needs you, what
is being worked on, where work should run, and whether the fleet itself is healthy. Nothing in
Remote Control spans machines or persists cross-session intent — that is the differentiator.

Four phases, each shippable on its own:
1. **Fleet Inbox** — one cross-daemon, attention-sorted list of every session; answer prompts inline.
2. **Missions + mission notes** — durable object above sessions (goal, members on N machines,
   results, notes that get injected into whichever session picks the work up).
3. **Routing + fleet inventory** — what each host has (repos, toolchains, load); placement
   suggestions when starting work.
4. **Fleet health** — per-daemon build/version/drift, confirmed rolling updates.

### Hard Constraints (apply to every phase)
- **C1 Opt-in / additive.** The existing server→session Dashboard stays the default home. Inbox is a
  separate view (toggle) with an optional setting to make it home. Missions exist only if created;
  direct session use and plain concierge chat are unchanged. Routing is suggestion-only (never
  auto-places). Health is read-only except explicitly confirmed actions.
- **C2 Backward-compatible protocol.** Only ADD new WS message types and new optional fields. Never
  rename, remove, or change semantics/shape of existing messages/fields. Unknown new fields on old
  clients must be harmless.
- **C3 Graceful degradation.** Older daemons keep working in all existing views. In new views they
  are either shown with reduced data or labelled "needs update" — never an error state, never a
  broken view. The web feature-detects per daemon (see "Capability handshake" below).
- **C4 Zero cost when off.** If the user never opens the Inbox/Missions/Health views, the client
  sends no new requests and daemons do no new work (no new timers, no pane scrapes).
- **C5 Subprocess safety** (engineering rule, commit 3058a0a): every recurring or fan-out exec
  (tmux capture-pane, git, `claude --version`, etc.) must have in-flight dedup + timeout with
  SIGKILL + PID/session liveness check. Prefer on-demand + short TTL cache over intervals.
- **C6 Never restart a daemon without explicit per-daemon sign-off** (project hard rule). No fleet
  action may batch restarts.
- **C7 Conventions.** New handler modules under `daemon/src/handlers/` registered in
  `handlers/index.ts`; shared types mirrored in `daemon/src/types.ts` ↔ `web/src/types/index.ts`;
  hooks in `web/src/hooks/` following the hooks pattern; localStorage keys in
  `web/src/services/storageKeys.ts`; dark-theme CSS variables (no hardcoded hex); no emojis;
  `console.log` daemon logging.

### Decisions (2026-09-24)
User answers to the open questions; no open user questions remain.
1. **Unseen finished turns count as "Needs you"** by default (Q1), with a per-device setting to turn
   it off.
2. **"Seen" state is synced across devices** (Q3), not per device. Each session's own daemon stores
   a monotonic (max-wins) `seenUpTo` watermark per tmux session in `~/.companion/inbox-seen.json`,
   exposed via additive `mark_seen` → `session_seen` (live to fleet-subscribed clients) and
   `seenUpTo` on `get_fleet_inbox` items; feature `inbox_seen_sync_v1`. Older daemons fall back to
   per-device local seen state for those servers only. See Phase 1 design.
3. **Mission home = the daemon where the concierge runs** (Q4); no separate "Fleet home" setting.
4. **Phase 2 may install a Claude Code `SessionStart` hook into project repos** (Q5) to re-inject
   mission notes after compaction — opt-in per repo, idempotent, merged into existing settings
   (never clobbers hooks), easy uninstall, no-op without an active mission.
5. **In-app per-daemon restart confirmation counts as the required sign-off** (Q9) for the Phase 4
   rolling update; each restart is individually confirmed, no batch auto-restart.
- Unanswered minor questions (Q2, Q6, Q7, Q8, Q10) proceed with the plan defaults written in their
  phases; they are not blocking and can be revisited at each phase's kickoff.

### Current-State Findings (research, 2026-09-24)
- **Handshake already half-exists.** `get_capabilities` (`daemon/src/handlers/remote.ts`) returns
  `{ daemonVersion, protocolVersion: 1, remoteCapabilities }`, and `web/src/hooks/useCapabilities.ts`
  consumes it. But `daemonVersion` is `package.json` `1.0.0` on every build (useless for drift), and
  there is no feature list. Daemons older than the MCP work answer `Unknown message type:
  get_capabilities` → that response is itself a reliable "legacy" signal. The `authenticated` reply
  carries only `isLocal` + `gitEnabled`.
- **Cross-server aggregation already exists.** `web/src/hooks/useAllServerSummaries.ts` polls
  `get_server_summary` on every connected server every 5s (used by `Dashboard.tsx`).
  `SessionSummary.status` is `idle | working | waiting | error`, but the daemon never actually
  emits `error` (`watcher.getServerSummary`), and `waiting` conflates "turn finished" with "blocked
  on a permission/plan prompt".
- **Pending live AUQ is invisible to status.** Claude Code only flushes the AUQ tool_use to JSONL
  after it is answered, so `isWaitingForInput` is FALSE while an AUQ box is on screen (see the
  `get_highlights` comment in `handlers/session.ts` and commits 5b4c68c..1028d5d). Only
  `get_highlights` (offset 0) pane-scrapes via `detectActiveChoicePrompt`. The Inbox therefore needs a
  gated pane probe for "stalled working" sessions — the summary alone will miss the most important
  case.
- **Answering already works without subscribing.** `send_input` and `send_choice`
  (`handlers/input.ts`) accept `tmuxSessionName`; `send_worker_input` exists for workers. The Inbox
  needs no new answer endpoints. `QuestionBlock.tsx` is already a standalone component
  (`question`, `onSelectOption`, `onSelectChoice`), and SessionView answers permission prompts by
  `send_input(label)`.
- **Bug that matters for the Inbox:** after `send_input`/`send_choice`, the daemon calls
  `escalation.acknowledgeSession(watcher.getActiveSessionId())` — the *active* session, not the one
  that was answered. Answering from the Inbox would not cancel push escalation for that session.
- **Pending permission tools are computed but not exposed.** The watcher emits `pending-approval`
  (`getPendingApprovalTools`) only to auto-approval in `index.ts`; no client message carries it.
  `status_change` is session-scoped (only the subscribed session gets it); `other_session_activity`,
  `error_detected`, `session_completed`, `work_group_update` are global broadcasts.
- **Away Digest's UI is gone.** `AwayDigest.tsx`/`useAwayDigest.ts` were deleted in 0248880; only the
  daemon's `get_digest` / `get_notification_history` (persisted in
  `~/.companion/notification-history.json`, entries carry `eventType`, `sessionName`, `preview`,
  `acknowledged`) remain. FEATURES.md still lists "Away Digest" as present. The Inbox is the
  natural successor and should reuse that history for error reasons + "Recently finished".
- **Missions have no substrate yet.** Concierge fan-outs keep all state inside the concierge
  Claude's context (`concierge/CLAUDE.md`, `projects.json`); nothing persists. Work groups persist to
  `~/.companion/work-groups.json` and have their own worker lifecycle (`WorkGroup`, `WorkerSession`).
  Daemons never talk to each other directly — only the MCP (`mcp/src/daemon-client.ts`) using
  `~/.companion/mcp-servers.json` (auto-derived by `concierge_sync_mcp`) does.
- **AJ's box is a file-copy deploy** (`bin/deploy-aj`) — no git on the host, so drift can only be
  detected from a build stamp shipped inside `daemon/dist`.
- Uncommitted WS-reliability work is in `web/src/services/ServerConnection.ts` /
  `ConnectionManager.ts`. Fleet work should land after that is committed and should avoid editing
  `ServerConnection.ts` (capability caching goes in a new module instead).

### Capability handshake (prerequisite, part of Phase 1)
- Extend `CapabilitiesResponse` (additive): `features: string[]`, `hostname: string`,
  `platform: NodeJS.Platform`, `arch: string`, `buildInfo?: { gitSha?: string; dirty?: boolean;
  builtAt?: string; branch?: string }`. Bump `protocolVersion` to `2` (field already exists; web
  treats `>= 2` or presence of `features` as feature-aware).
- Feature strings (constants in both type files): `fleet_inbox_v1`, `fleet_inbox_push_v1`,
  `choice_expect_prompt_v1`, `inbox_seen_sync_v1`, later `missions_v1`, `inventory_v1`, `health_v1`, `self_update_v1`.
- Web: new `web/src/services/capabilities.ts` — per-server cache, fetched once per (re)connect via
  `connectionManager.onChange`, lazily (only when a Fleet view is mounted, per C4). Result states:
  `{ kind: 'modern', caps }` | `{ kind: 'legacy-caps', caps }` (has get_capabilities, no
  `features`) | `{ kind: 'legacy' }` (unknown message type / error) | `{ kind: 'unknown' }`
  (not connected). `hasFeature(serverId, f)` helper.
- `useCapabilities.ts` keeps working unchanged (it reads the same message; new fields are ignored).

---

### Phase 1 — Fleet Inbox (DETAILED)
**Size:** M–L. ~600 LOC daemon + ~400 LOC daemon tests, ~950 LOC web + ~300 LOC web tests
(includes daemon-synced seen state, decided 2026-09-24).
Roughly 3–5 focused days; splits cleanly into a daemon workstream and a web workstream (web can
start against the legacy-derivation path before the daemon lands).

#### Design
**Buckets** (fixed order), each item in exactly one:
1. **Needs you** — ranked by reason priority, then oldest-waiting first:
   `permission` (pending approval tool) > `question` (AUQ, JSONL or live pane) > `plan`
   (ExitPlanMode pending) > `worker_question` > `error` / `worker_error` (unacknowledged since the
   session's last user input) > `awaiting_reply` (turn finished, not yet seen by you).
2. **Working** — actively producing output / running tools / subagents running; shows
   `currentActivity`.
3. **Recently finished** — turn ended (or `session_completed`) within `recentWindowMs` (default 2h)
   and already seen/dismissed.
4. **Idle** — everything else, including `inactive` persisted sessions; collapsed by default.

**"Seen" state — SYNCED across devices (decided 2026-09-24)** (makes `awaiting_reply` vs Recently
finished work). Each session's **own daemon** is the source of truth for its sessions' seen
markers; no daemon-to-daemon traffic, no replication (every session lives on exactly one daemon,
so there is nothing to merge across daemons).
- **Marker:** per `tmuxSessionName` a watermark `seenUpTo: number` (ms, **daemon clock**), plus
  `seenAt` / `seenBy` (client label, for debugging). An item is seen iff `seenUpTo >= turnEndedAt`.
  Keyed by tmux name (stable within a daemon, survives `/clear` and conversation-file rotation,
  which a JSONL session id / message uuid would not). A reused tmux name is harmless: the new
  session's `turnEndedAt` is later than the stale watermark, so it shows as unseen.
  Timestamp watermark (not a message/turn id) chosen because it is totally ordered, which makes
  "max wins" trivial, and `turnEndedAt` is already computed for the Inbox item.
- **Clock skew:** the client never supplies wall-clock time of its own. `mark_seen { upTo? }` sends
  the `turnEndedAt` value the daemon itself reported for the item the user saw (so seeing an old
  turn cannot swallow a newer one that arrived meanwhile); omitted → daemon uses its current
  `turnEndedAt` for that session. Values > daemon `now` are clamped.
- **Races (multiple devices):** monotonic — `seenUpTo = max(stored, incoming)`; a lower value is a
  no-op that still returns the effective marker. No un-see/undo in v1 (an "unread" action would need
  a separate explicit `clear` op; deferred).
- **What counts as seen:**
  1. *Opening the session* (SessionView mounted **and** document visible, for ≥ ~1.5s, debounced so
     swiping through sessions doesn't mark everything) → `mark_seen` with the latest `turnEndedAt`
     the client has; re-sent when a new turn ends while the view stays open and visible.
  2. *Answering* — the daemon marks seen **implicitly** inside `send_input` / `send_choice` /
     `send_worker_input` for the answered session (upTo = now). Server-side, so it also works from
     old clients and the terminal-less paths; no extra round trip.
  3. *Explicit "Dismiss"* on an Inbox card → `mark_seen`.
  NOT seen: appearing in the Inbox list, a push/browser notification being delivered or tapped
  without the session opening, the app being foregrounded on the Dashboard.
- **Escalation tie-in:** `mark_seen` also calls `escalation.acknowledgeSession(<that session>)` —
  if you saw it on the desktop, the phone push is cancelled. (Internal behaviour, only triggered by
  new clients.)
- **Live update:** after a marker advances, the daemon sends `session_seen { tmuxSessionName,
  seenUpTo, seenAt }` to **fleet-subscribed clients only** (C4: nothing new to clients that never
  opened the Inbox). Non-subscribed / polling clients pick it up from the `seenUpTo` field in the
  next `get_fleet_inbox`.
- **Persistence:** `~/.companion/inbox-seen.json` `{ version: 1, sessions: { [tmux]: { seenUpTo,
  seenAt, seenBy? } } }`, written with the existing `atomicWriteFileSync` (`daemon/src/utils.ts`)
  with mode `0o600`; loaded lazily on first `mark_seen`/`get_fleet_inbox` (not at boot); writes
  coalesced (≤ 1 write / `SEEN_WRITE_DEBOUNCE_MS` = 1s, timer only exists while a write is pending,
  flushed on shutdown). Pruned on write: entries whose tmux session no longer exists and
  `seenAt` > 30 days old; hard cap 1000 entries. Corrupt/missing file → start empty, log once.
- **Older daemons (no `inbox_seen_sync_v1` in `features`):** fall back to per-device
  `localStorage` seen state **for those servers only** (map `serverId:tmuxSessionName → seenUpTo`,
  using that daemon's `lastActivity`-derived turn end). When a server later advertises the feature,
  the client does a one-time upload of its local entries for that server via `mark_seen` (max-wins
  makes this safe from every device) and then deletes them locally.
- **Offline daemon:** `mark_seen` for a disconnected server is queued in memory (latest per session)
  and flushed on reconnect; the card is shown seen optimistically meanwhile.
- The "Count finished turns as Needs you" setting (default **ON**, decided) stays a **per-device UI
  preference** (localStorage) — only the seen marker is synced. OFF sends finished turns straight to
  Recently finished.

**Daemon side — `get_fleet_inbox`:** one round trip returning classified items for all tagged
sessions on that daemon.
- Base data: reuse `watcher.getServerSummary(tmux.listSessions())` + friendly names + subagent
  counts (same enrichment as `get_server_summary`; factor into a shared helper
  `buildSessionSummaries(ctx)` in `handlers/session.ts` so both handlers use it — no behavior change
  for `get_server_summary`).
- Classification: pure function `classifyAttention(input)` in `daemon/src/fleet/attention.ts`
  using the conversation's cached messages: `getPendingApprovalTools` → `permission` (+ tool name
  and a one-line summary: Bash command / file path), pending `AskUserQuestion` in JSONL →
  `question` (questions from `extractHighlights` last highlight), pending `ExitPlanMode` → `plan`,
  worker membership from `workGroupManager` (`status === 'waiting'` + `lastQuestion` →
  `worker_question`; `status === 'error'` → `worker_error`), notification history
  (`store.getHistorySince(lastUserInputTs)`, `eventType === 'error_detected'`, not acknowledged) →
  `error`, `isWaitingForInput` with no blocking reason → `awaiting_reply`.
- **Live AUQ probe (gated, C5):** only for *candidate* sessions: summary status `working` (or
  `idle` with a live tmux pane), JSONL unchanged for ≥ `FLEET_AUQ_STALL_MS` (4s), tagged tmux
  session present in the `listSessions()` result just fetched (liveness check). Implementation in
  `daemon/src/fleet/live-prompt-probe.ts`:
  - per-session in-flight promise map (dedup concurrent requests from multiple clients),
  - per-session result cache keyed by `(tmuxName, conv.lastModified)` with TTL
    `FLEET_PROBE_TTL_MS` (3s),
  - global concurrency cap `FLEET_PROBE_MAX_CONCURRENT` (4),
  - uses `injector.captureTmuxPane` (already `runTmux` with `TMUX_OPERATION_TIMEOUT_MS` +
    SIGKILL) + `detectActiveChoicePrompt`; any failure → no prompt (never throws),
  - no timers — runs only inside `get_fleet_inbox`.
  A live choice → reason `question`, bucket Needs you, `liveSourced: true`.
- **Prompt identity:** every inline prompt gets a stable `promptId`: live choices reuse
  `liveChoiceHighlightId(sessionId, question)` (already in `handlers/session.ts`); JSONL prompts use
  the tool_use id. Used for the staleness guard below.
- Preview: last assistant text, whitespace-collapsed, truncated to `previewChars` (default 160).
- Also returns daemon identity (`hostname`, `platform`) so cards can show machine tags even when the
  user's server name is generic.

**Push (optional, `fleet_inbox_push_v1`):** `fleet_subscribe { enabled }` marks the client;
subscribed clients receive `fleet_inbox_changed { sessionIds, at }` (a cheap invalidation hint,
debounced 750ms, triggered from watcher `status-change` / `other-session-activity` /
`error-detected` / `session-completed` and `work-group-update`). Client then re-fetches
`get_fleet_inbox`. Keeps payloads small and avoids a second classification codepath. Non-subscribed
clients (all existing ones) see no new traffic. Polling (5s visible / paused when hidden) remains the
baseline so the feature works without push.

**Staleness guard for inline answers (`choice_expect_prompt_v1`):** optional
`expectPromptId?: string` on `send_choice` and `send_input`. If present, the daemon re-derives the
session's current prompt id (JSONL pending tool id, or fresh pane probe bypassing cache) and replies
`{ success: false, error: 'prompt_changed' }` on mismatch without sending keys. Old daemons ignore
the field (so for legacy daemons the web re-fetches immediately before sending and shows a
"prompt may have changed" confirm if the list changed). Behaviour without the field is unchanged.

**Escalation ack fix:** in `send_input` / `send_choice`, additionally call
`escalation.acknowledgeSession(<resolved session>)` for the session actually answered (keep the
existing active-session ack). Internal, non-protocol change.

**Web side:**
- `useFleetInbox()` merges per-server results:
  - modern daemon (`fleet_inbox_v1`) → `get_fleet_inbox`;
  - legacy daemon → derived from `get_server_summary` (`waiting` → Needs you/`awaiting_reply`,
    `working` → Working, else Idle/Recently finished by `lastActivity`), plus bounded
    enrichment: for `waiting` sessions only, `get_highlights { sessionId, limit: 3 }` (max 2
    concurrent per server, cached by `lastActivity`) to surface JSONL-visible permission/AUQ/plan
    prompts inline. Live-pane AUQ is only available if that daemon's `get_highlights` already
    scrapes (post-5b4c68c) — otherwise shown as a normal card. Legacy servers get a subtle
    "limited — update daemon" chip on the machine tag, never an error.
  - disconnected servers: last-known items kept, dimmed, with "offline since …" and prompts
    disabled.
- Pure merge/sort/bucket logic lives in `web/src/utils/fleetInbox.ts` (unit-testable), the hook only
  does IO.
- **Cards** (`InboxCard.tsx`): machine tag (server name, tinted per server), project tag
  (basename of `projectPath`, full path on hover/long-press), friendly/tmux name, reason chip,
  relative time ("waiting 12m"), preview (2 lines), work-group chip if a worker, subagent count.
  Needs-you cards render the prompt inline (`InboxPrompt.tsx`):
  - `question` → existing `QuestionBlock` wired to `send_choice` with `tmuxSessionName` +
    `expectPromptId`; multi-question AUQs: answer current, card re-fetches and shows the next
    (same as Chat behaviour after f5165c8).
  - `permission` / `plan` → option buttons (labels from highlight `options`) → `send_input(label)`
    exactly as `SessionView.handleSelectOption` does, plus "Open" for context.
  - `worker_question` → options/text → `send_worker_input`.
  - `awaiting_reply` → collapsed quick-reply field (`send_input`) + "Dismiss".
  - After a successful send: optimistic "Sent" state + optimistic seen (the daemon marks it seen
    server-side; legacy servers → local seen), re-fetch that server.
  - Failures use the existing error toast pattern; `prompt_changed` → refresh card + inline notice.
- **Layout:**
  - Desktop: the Dashboard gains a segmented control at the top of the sidebar: **Sessions |
    Inbox (N)**. In Inbox mode the main pane shows `FleetInbox` (bucket sections, filter bar:
    machine, project, reason, text search). Clicking a card opens the session in the main pane with
    a "Back to Inbox" affordance; sidebar session list keeps working.
  - Mobile: `MobileDashboard` gets the same toggle in its header; Inbox is a full-screen list; tap a
    card → existing session view; Android back returns to Inbox (use existing `eventBus` /
    history pattern).
  - N badge = Needs-you count, only computed while the Inbox has been opened at least once this app
    session OR "Inbox as home" is set (C4).
- **Settings** (`SettingsScreen.tsx`): "Home view: Sessions (default) | Inbox";
  "Count finished turns as Needs you"; "Recently finished window". Keys in `storageKeys.ts`.
- Notification deep links / push behaviour: unchanged.

#### Data Model / Types (add to `daemon/src/types.ts` and mirror in `web/src/types/index.ts`)
```ts
export const FLEET_FEATURES = {
  INBOX: 'fleet_inbox_v1',
  INBOX_PUSH: 'fleet_inbox_push_v1',
  CHOICE_EXPECT_PROMPT: 'choice_expect_prompt_v1',
  SEEN_SYNC: 'inbox_seen_sync_v1',
} as const;

export interface SessionSeenMarker {
  tmuxSessionName: string;
  seenUpTo: number;             // daemon clock; monotonic (max wins)
  seenAt: number;               // daemon clock when last advanced
  seenBy?: string;              // client label, informational only
}

export interface MarkSeenRequest {
  tmuxSessionName: string;
  upTo?: number;                // a turnEndedAt value the daemon reported; omitted → current
  clientLabel?: string;
}
// Response `session_seen` payload = SessionSeenMarker (effective value after max-merge)

export type AttentionBucket = 'needs_you' | 'working' | 'finished' | 'idle';
export type AttentionReason =
  | 'permission' | 'question' | 'plan' | 'worker_question'
  | 'error' | 'worker_error' | 'awaiting_reply';

export type InboxPrompt =
  | { kind: 'question'; promptId: string; questions: Question[]; liveSourced: boolean }
  | { kind: 'permission'; promptId: string; toolName: string; summary: string; options: string[] }
  | { kind: 'plan'; promptId: string; excerpt: string; options: string[] }
  | { kind: 'worker_question'; promptId: string; groupId: string; workerId: string;
      question: WorkerQuestion };

export interface FleetInboxItem {
  tmuxSessionName: string;      // stable key within a daemon
  sessionId: string;            // same id get_server_summary uses
  friendlyName?: string;
  projectPath: string;
  bucket: AttentionBucket;
  reasons: AttentionReason[];   // highest priority first; [] for working/idle
  lastActivity: number;
  turnEndedAt?: number;         // when it last became waiting
  waitingSince?: number;        // when the current blocking reason appeared
  currentActivity?: string;
  preview?: string;
  prompt?: InboxPrompt;         // only for needs_you items with an answerable prompt
  workGroup?: { groupId: string; groupName: string; workerId: string; taskSlug: string };
  subagentRunning?: number;
  inactive?: boolean;
  lastError?: string;
  seenUpTo?: number;            // present only on inbox_seen_sync_v1 daemons
}

export interface FleetInboxResponse {
  items: FleetInboxItem[];
  generatedAt: number;
  host: { hostname: string; platform: string };
}

// CapabilitiesResponse — additive fields
//   features?: string[]; hostname?: string; platform?: string; arch?: string;
//   buildInfo?: { gitSha?: string; dirty?: boolean; builtAt?: string; branch?: string };
```
Web-only: `InboxEntry = FleetInboxItem & { serverId; serverName; source: 'modern' | 'legacy';
stale: boolean; seen: boolean; seenSource: 'daemon' | 'local' }`.

#### New / Changed WS Messages (all additive)
| Request | Response type | Notes |
|---|---|---|
| `get_fleet_inbox` `{ recentWindowMs?, previewChars?, includeIdle? = true }` | `fleet_inbox` `FleetInboxResponse` | new, `fleet_inbox_v1` |
| `fleet_subscribe` `{ enabled: boolean }` | `fleet_subscribed` | new, `fleet_inbox_push_v1` |
| (broadcast) | `fleet_inbox_changed` `{ sessionIds: string[]; at: number }` | only to fleet-subscribed clients |
| `mark_seen` `MarkSeenRequest` | `session_seen` `SessionSeenMarker` | new, `inbox_seen_sync_v1`; max-wins; also acks escalation for that session |
| (broadcast) | `session_seen` `SessionSeenMarker` | on advance only; only to fleet-subscribed clients (incl. the sender's other devices) |
| `get_fleet_inbox` | items carry optional `seenUpTo` | additive field |
| `send_input`, `send_choice`, `send_worker_input` | unchanged shape; daemon now also advances the seen marker for the answered session | internal side effect, no protocol change |
| `get_capabilities` | `capabilities` + `features`, `hostname`, `platform`, `arch`, `buildInfo` | new optional fields; `protocolVersion: 2` |
| `send_choice`, `send_input` | unchanged + optional `expectPromptId` → may return `error: 'prompt_changed'` | only when field supplied |

#### Files to Create
- `daemon/src/fleet/attention.ts` — `classifyAttention()` pure classifier + reason priority.
- `daemon/src/fleet/live-prompt-probe.ts` — gated, deduped, cached pane probe.
- `daemon/src/fleet/build-info.ts` — reads `dist/build-info.json` if present (used by capabilities;
  groundwork for Phase 4).
- `daemon/src/fleet/seen-store.ts` — lazy-loaded, max-merge, coalesced atomic persistence of
  `~/.companion/inbox-seen.json`, prune, flush-on-shutdown.
- `daemon/src/handlers/fleet.ts` — `get_fleet_inbox`, `fleet_subscribe`, `mark_seen`.
- `daemon/scripts/stamp-build.js` — writes `dist/build-info.json` (git sha, dirty, branch, builtAt;
  tolerates no-git) — hooked into `npm run build`.
- `daemon/src/__tests__/fleet-attention.test.ts`, `daemon/src/__tests__/fleet-inbox-handler.test.ts`,
  `daemon/src/__tests__/live-prompt-probe.test.ts`, `daemon/src/__tests__/seen-store.test.ts`.
- `web/src/services/capabilities.ts` — per-server capability cache + `hasFeature`.
- `web/src/utils/fleetInbox.ts` — legacy derivation, merge, bucket/sort, seen logic.
- `web/src/hooks/useFleetInbox.ts` — polling / push-invalidation IO, visibility pause.
- `web/src/hooks/useInboxSeen.ts` — seen-state router: daemon markers (`mark_seen`,
  `session_seen` listener, offline queue) for `inbox_seen_sync_v1` servers; localStorage fallback
  for legacy servers; one-time local→daemon upload when a server gains the feature.
- `web/src/components/FleetInbox.tsx` — buckets, filters, empty states (desktop + mobile).
- `web/src/components/InboxCard.tsx`, `web/src/components/InboxPrompt.tsx`.
- `web/src/utils/__tests__/fleetInbox.test.ts`, `web/src/services/__tests__/capabilities.test.ts`.

#### Files to Modify
- `daemon/src/types.ts` — types above; extend `CapabilitiesResponse`.
- `daemon/src/handlers/index.ts` — register `registerFleetHandlers`.
- `daemon/src/handlers/remote.ts` — `get_capabilities` adds `features`, host info, `buildInfo`,
  `protocolVersion: 2`.
- `daemon/src/handlers/session.ts` — extract `buildSessionSummaries(ctx)` shared by
  `get_server_summary` and `get_fleet_inbox` (no output change for the old handler); export a helper
  for current prompt id.
- `daemon/src/handlers/input.ts` — optional `expectPromptId` check; ack the answered session;
  advance seen marker for the answered session (`send_input`, `send_choice`, `send_worker_input`).
- `daemon/src/websocket.ts` — `fleetSubscribed` flag on client; debounced `fleet_inbox_changed`
  broadcast wired to existing watcher/work-group events (only to flagged clients); helper to send
  `session_seen` to flagged clients (NOT via the generic `broadcast()`, which targets every
  subscribed client).
- `daemon/src/index.ts` — flush `seen-store` on shutdown.
- `web/src/components/SessionView.tsx` — visible-and-open ≥ 1.5s → mark seen (via `useInboxSeen`).
- `daemon/src/constants.ts` — `FLEET_AUQ_STALL_MS`, `FLEET_PROBE_TTL_MS`,
  `FLEET_PROBE_MAX_CONCURRENT`, `FLEET_INBOX_CHANGED_DEBOUNCE_MS`, `DEFAULT_RECENT_WINDOW_MS`,
  `SEEN_WRITE_DEBOUNCE_MS`, `SEEN_PRUNE_AGE_MS`, `SEEN_MAX_ENTRIES`.
- `daemon/package.json` — `build` runs `stamp-build.js` after `tsc`.
- `bin/deploy-aj` — ensure `dist/build-info.json` is rsynced (it is inside `dist/`, verify).
- `web/src/types/index.ts` — mirrored types; `DaemonCapabilities` gains optional fields.
- `web/src/components/Dashboard.tsx` — view-mode state, segmented toggle, render `FleetInbox`, open
  session from inbox + back affordance.
- `web/src/components/MobileDashboard.tsx` — header toggle + inbox list.
- `web/src/components/SessionSidebar.tsx` — host the desktop segmented control.
- `web/src/components/SettingsScreen.tsx` — home view + inbox settings.
- `web/src/services/storageKeys.ts` — `HOME_VIEW_KEY`, `INBOX_SEEN_KEY` (legacy-server fallback only),
  `INBOX_FINISHED_AS_NEEDS_KEY`, `INBOX_RECENT_WINDOW_KEY`, `INBOX_FILTERS_KEY`.
- `web/src/styles/global.css` (+ `variables.css` if a server-tint palette is needed) — inbox styles.
- `FEATURES.md` — on ship, add "Fleet Inbox"; mark Away Digest UI as superseded.

#### Implementation Steps
1. **Prereq:** confirm the in-flight WS-reliability changes are committed; branch `feat/fleet-inbox`.
2. **Types:** add all Phase 1 types/constants to `daemon/src/types.ts` and mirror in
   `web/src/types/index.ts` (keep field order identical for easy diffing).
3. **Build stamp:** write `daemon/scripts/stamp-build.js` (spawnSync `git` with timeout; on any
   failure write `{ builtAt }` only); add to the `build` script; `daemon/src/fleet/build-info.ts`
   reads it once at startup (sync read at boot only is fine).
4. **Capabilities:** extend `get_capabilities` with `features` (list driven by a single exported
   `DAEMON_FEATURES` array), `hostname` (`os.hostname()`), `platform`, `arch`, `buildInfo`,
   `protocolVersion: 2`. Unit test: payload contains old fields unchanged + new ones.
5. **Shared summaries:** extract `buildSessionSummaries(ctx)` from `get_server_summary`; verify the
   existing handler output is byte-identical with a test snapshot of a fixture.
6. **Classifier:** implement `classifyAttention({ summary, messages, isWaiting, workerInfo,
   recentErrors, livePrompt, now, recentWindowMs })` → `{ bucket, reasons, prompt?, waitingSince?,
   turnEndedAt? }`. Reuse `getPendingApprovalTools`, `extractHighlights` (last highlight only), and
   `detectWaitingForInput` from `parser.ts`. Table-driven tests (step 13).
7. **Live probe:** implement `live-prompt-probe.ts` (in-flight map, TTL cache, semaphore of 4,
   liveness = name present in the `listSessions()` snapshot passed in; never throws). Candidate
   predicate exported separately for testing.
8. **Handler:** `handlers/fleet.ts` `get_fleet_inbox`: listSessions → summaries → per-session gather
   (cached messages, worker map from `workGroupManager.getGroups()`, error events from
   `push.getStore().getHistorySince(since)`) → probe candidates in parallel (bounded) → classify →
   sort (bucket, priority, waitingSince asc, lastActivity desc) → send `fleet_inbox`. Log duration
   when > `SLOW_OPERATION_THRESHOLD_MS`.
9. **Staleness guard + ack fix:** in `handlers/input.ts`, when `expectPromptId` is present compute the
   current prompt id (JSONL pending tool id, else fresh probe with cache bypass) → `prompt_changed`
   on mismatch. Add `escalation.acknowledgeSession(resolvedSession)`. Tests for both paths and for
   "field absent → unchanged behaviour".
10. **Push invalidation:** `fleet_subscribe` sets `client.fleetSubscribed`; in `websocket.ts` add a
    debounced collector fed by `status-change`, `other-session-activity`, `error-detected`,
    `session-completed`, `work-group-update` that sends `fleet_inbox_changed` only to flagged
    clients. Advertise `fleet_inbox_push_v1`.
10b. **Synced seen state:** `fleet/seen-store.ts` (lazy load, `markSeen(tmux, upTo, label)` →
    max-merge, clamp to now, returns effective marker + `advanced` flag; coalesced atomic write
    `0o600`; prune; `flush()`), `mark_seen` handler (validates tmux name exists or is in the store;
    resolves `upTo` default from the session's current `turnEndedAt`; acks escalation; on `advanced`
    sends `session_seen` to fleet-subscribed clients), implicit mark in the answer handlers,
    `seenUpTo` added to `get_fleet_inbox` items, shutdown flush. Advertise `inbox_seen_sync_v1`.
11. **Web capabilities service:** `services/capabilities.ts` with lazy fetch per server on connect,
    classification (`modern` / `legacy-caps` / `legacy` / `unknown`), invalidation on reconnect,
    `hasFeature()`. Does not touch `ServerConnection.ts`.
12. **Web data layer:** `utils/fleetInbox.ts` (pure: `deriveLegacyItems`, `mergeServerItems`,
    `bucketize`, `applySeen` (daemon `seenUpTo` when present, else local map; optimistic pending
    marks overlay both), `applyFilters`), `hooks/useInboxSeen.ts` (feature-routed; `session_seen`
    listener patches items in place without a re-fetch; offline queue; one-time local→daemon
    upload), SessionView open-and-visible mark, `hooks/useFleetInbox.ts`
    (poll every 5s while mounted & document visible; subscribe to `fleet_inbox_changed` where
    supported and refetch only that server; bounded legacy enrichment; keep last-known items for
    disconnected servers marked `stale`).
13. **Tests (daemon):** `fleet-attention.test.ts` — permission pending (Bash + Edit), AUQ pending in
    JSONL, live pane AUQ (reuse fixtures from `auq-side-panel.test.ts` /
    `input-injector-overlay.test.ts`), multi-question AUQ, ExitPlanMode, worker waiting with
    question, worker error, error_detected after last input (and acknowledged/older → ignored),
    finished turn inside/outside window, working, idle, inactive, priority ordering when several
    reasons apply. `live-prompt-probe.test.ts` — 2 concurrent calls → 1 capture; TTL reuse; cache
    invalidated when `lastModified` changes; >4 candidates → never >4 captures in flight; capture
    throws/timeout → null; non-candidates (recent JSONL write, missing tmux session) never captured.
    `fleet-inbox-handler.test.ts` — sort order, previews truncated, host info present, legacy
    `get_server_summary` unchanged, `expectPromptId` mismatch returns `prompt_changed` and does not
    call `sendChoice`, items carry `seenUpTo`. `seen-store.test.ts` — max-wins (lower/equal value
    is a no-op, returns effective marker, `advanced=false`); future `upTo` clamped to now; two
    interleaved "devices" converge; persistence round-trip via atomic write; corrupt file → empty
    store; prune (gone + old) and cap; no file I/O and no timer before first use; writes coalesced.
    Handler tests: `mark_seen` → `session_seen` sent to fleet-subscribed clients only (non-subscribed
    and other daemons' clients get nothing), not sent when not advanced; escalation acked;
    `send_input`/`send_choice` advance the marker for the answered session (not the active one).
14. **Tests (web, vitest):** `fleetInbox.test.ts` — legacy derivation mapping, merge of modern +
    legacy + disconnected servers, bucket ordering, seen logic (daemon `seenUpTo` before/after turn
    end, local fallback only for servers without `inbox_seen_sync_v1`, optimistic overlay, incoming
    `session_seen` patch, setting OFF), filters. `useInboxSeen` logic: offline queue keeps latest
    per session and flushes on reconnect; one-time local→daemon upload then local entries cleared. `capabilities.test.ts` — `features` present → modern; caps without features →
    legacy-caps; `Unknown message type` error → legacy; reconnect clears cache.
15. **UI components:** `InboxPrompt.tsx` (reuse `QuestionBlock`; permission/plan buttons; worker
    question; quick reply), `InboxCard.tsx`, `FleetInbox.tsx` (sections with counts, Idle collapsed,
    filter bar, empty state "Nothing needs you", legacy/offline chips). CSS with existing variables
    only.
16. **Wire into Dashboard/MobileDashboard:** segmented toggle, view-mode state (persist last mode
    only if "Inbox as home" is set), open-session-from-inbox with back affordance, Android back
    handling via existing `eventBus`/history pattern, Needs-you badge (C4 gating).
17. **Settings:** home view, finished-as-needs toggle, recent window; storage keys.
18. **Manual verification** (see test plan), then `cd web && npx tsc --noEmit`, `npm test` in daemon
    and web. Builds/deploys only with user approval; daemon restart only with explicit sign-off.
19. **Docs:** FEATURES.md entry on ship; update `CLAUDE.md` WebSocket Protocol list with new message
    types.

#### Test Plan — Manual
- **Default untouched:** fresh install / existing user → app opens on the existing Dashboard; no
  `get_fleet_inbox` or `get_capabilities` in daemon logs until the Inbox toggle is clicked (C4).
- **Mixed fleet:** local daemon on new build + AJ's daemon (or a second local daemon) on the current
  build. Inbox lists both; old one shows the "limited — update daemon" chip; its waiting sessions
  still appear under Needs you; existing Dashboard for the old daemon fully functional.
- **Pre-capabilities daemon:** point at a checkout older than the MCP work (or stub a daemon that
  rejects `get_capabilities`) → treated as legacy, no errors in console beyond one debug line.
- **Answer inline:** (a) single AUQ via live pane, (b) multi-question AUQ advances to Q2 on the card,
  (c) permission prompt (Bash) approve/deny, (d) ExitPlanMode, (e) worker question from a `/work`
  group, (f) quick reply to a finished turn. Each: session proceeds, card moves bucket within ~5s,
  push escalation for that session is cancelled (check notification history `acknowledged`).
- **Staleness:** answer the prompt in the terminal, then press an option on the (stale) card → modern
  daemon returns `prompt_changed`, card refreshes; nothing is typed into the pane.
- **Mobile:** Android APK + mobile web: toggle, scroll, inline answer, tap-through and back gesture
  returns to Inbox, safe-area insets OK.
- **Load / C5:** 20+ tagged sessions with 5 "stalled working" → `get_fleet_inbox` p95 < 200ms warm;
  `pgrep -c tmux` does not climb while Inbox is open for 10 min on two clients; kill a tmux session
  mid-probe → no hung capture.
- **Offline server:** disconnect a daemon → its cards dim with "offline since", prompts disabled,
  reconnect restores.
- **Synced seen:** phone + desktop both on the Inbox. Finish a turn → Needs you on both. Open the
  session on desktop → within ~2s the phone card moves to Recently finished without a manual
  refresh; the pending push for that session is cancelled. Dismiss on phone → desktop updates.
  Restart-free check: `~/.companion/inbox-seen.json` written, `0o600`. Stale mark race: open an
  old turn on one device while a new turn ends → new turn stays Needs you. Legacy daemon in the
  mix: its seen state stays per device and nothing errors; after upgrading it, the device's local
  seen entries appear on the other device.

#### Acceptance Criteria
- [ ] Dashboard remains the default home; Inbox reachable via a toggle on desktop and mobile; the
      "Inbox as home" setting works and is off by default.
- [ ] Every tagged session on every connected daemon appears in exactly one bucket, ordered Needs you
      → Working → Recently finished → Idle, with machine + project tags and preview.
- [ ] Pending AUQ (including live, not-yet-flushed AUQ), permission, plan and worker questions on
      modern daemons render inline and can be answered without opening the session.
- [ ] Inline answers are guarded against stale prompts on modern daemons (`prompt_changed`) and
      cancel push escalation for the answered session.
- [ ] Older daemons: all existing views unchanged; in the Inbox they appear with reduced data and a
      "needs update" indicator; no error banners.
- [ ] No existing WS message/field changed; `get_server_summary` output identical (test-enforced).
- [ ] With the Inbox never opened, no new requests are sent and no new daemon work happens.
- [ ] Pane probes: deduped, cached, concurrency-capped, timeout+SIGKILL, liveness-checked; no
      intervals added on the daemon (push path is event-driven + debounced).
- [ ] Seen state is synced: seeing/answering/dismissing on one device updates every other
      Inbox-open device live (and others on next fetch); markers survive daemon restart; concurrent
      marks converge (max wins); a stale mark never hides a newer turn.
- [ ] Unseen finished turns land in Needs you by default; the per-device setting moves them to
      Recently finished.
- [ ] Daemons without `inbox_seen_sync_v1` fall back to per-device seen state for those servers
      only, with no errors.
- [ ] Unit tests listed above pass; `tsc --noEmit` clean.

#### Open Questions / Risks (Phase 1)
- **Q1** ~~Should "turn finished, not yet seen" count as Needs you by default?~~ **Decided
  2026-09-24: yes**, with the per-device setting to turn it off.
- **Q2** Desktop placement: plan default = Inbox in the main pane with the sidebar kept. Not
  blocking.
- **Q3** ~~Seen state per device or synced?~~ **Decided 2026-09-24: synced via each session's own
  daemon** (`mark_seen`, feature `inbox_seen_sync_v1`).
- **R4** Seen markers are keyed by tmux session name. Sessions that are renamed or killed and
  recreated under the same name are handled by the timestamp watermark, but a rename loses the
  marker (it shows as unseen once). Acceptable.
- **R5** The implicit "answered ⇒ seen" in the answer handlers also fires for answers from old
  clients and the MCP (`remote_send_input`). That is the intended meaning, but it means a
  concierge-driven answer marks a session seen for the user. Revisit if that is confusing
  (could skip the implicit mark when the request comes from an MCP/per-origin token).
- **R1** Live-AUQ detection relies on pane parsing that has been fragile (five `fix(auq)` commits).
  The Inbox multiplies the surface; keep the probe code path identical to `get_highlights` to avoid
  divergence.
- **R2** Permission-prompt option labels depend on Claude Code's current prompt text; reuse whatever
  `extractHighlights` produces today so Chat and Inbox fail/succeed together.
- **R3** Tagged-session only: untagged tmux sessions stay invisible (existing gotcha) — surface a
  hint in the empty state.

---

### Phase 2 — Missions + Mission Notes (design-level)
**Size:** L. ~2 weeks. Absorbs todo "Server-level / session-persistent working memory".

#### Concept
A **Mission** is a persisted object above sessions: `goal`, `type`, `status`, `members` (sessions on
any daemon), per-member status/result, an aggregated `summary`, and **mission notes** — an
append-only log of what was tried / ruled out / being fixed / decided. Notes are injected into any
session that picks up the work (on join, on dispatch, and after compaction), so context survives
daemon restarts, session restarts and compaction.

#### Key Decisions
- **Where state lives: the daemon where the concierge runs (decided 2026-09-24), no replication.**
  There is no separate "Fleet home" setting. Every mission is stored on the concierge's daemon at
  `~/.companion/missions/<id>.json` (atomic tmp+rename via `atomicWriteFileSync`, `0o600`) plus an
  index. Missions created from the web (`adhoc`) are sent to the concierge daemon too: the web
  identifies it as the server whose `get_capabilities` reports `features` ∋ `missions_v1` **and**
  a running/configured concierge (new capabilities field `conciergeHost: boolean`). If several
  daemons report a concierge, the web uses the one the concierge view is attached to and shows the
  others' missions read-only-merged; if none is connected, "New mission" is disabled with "concierge
  daemon offline". Missions carry `homeServer` so a later concierge move is visible, but v1 does not
  migrate them. Justification: daemons never talk to each other except through the MCP/registry; the web
  client is not durable or multi-device; replication would need conflict resolution for little gain
  (one user, low write rate). The web shows missions from all daemons by calling `list_missions` on
  every `missions_v1` daemon and merging — so "global" view without shared state. Cost: if the home
  daemon is offline, its missions are read-only-unavailable (shown as offline).
- **Cross-host member status:** the home daemon tracks remote members through a `MissionTracker`
  that reuses the MCP daemon client (lift `mcp/src/daemon-client.ts` into a shared module or copy)
  with the auto-derived `~/.companion/mcp-servers.json` registry; it polls only *active* missions'
  remote members, event-driven where possible, and follows C5 discipline (in-flight dedup,
  timeouts, backoff, stop when mission done). Members with no registry entry are status `unknown`;
  the web overlays live status from Inbox data for display only.
- **Membership link on the member's daemon (thin, derived):** each member daemon stores
  `~/.companion/mission-links.json` `{ tmuxSessionName → { missionId, homeServer } }` so it can
  answer "which mission is this session in?" locally (for compaction re-injection and Inbox chips).
  It is a cache; the home daemon is the source of truth.
- **Mission types instead of separate state:** `adhoc` (user-created), `concierge_fanout`,
  `work_group`. Work groups are *projected* into missions (read-only adapter over
  `work-groups.json`, additive optional `missionId` on `WorkGroup`) — no migration of
  `WorkGroupManager` in Phase 2. Concierge fan-outs create a mission only when the user starts one
  ("Start as mission" in the concierge view, or asks the concierge to) — plain concierge chat
  unchanged (C1).
- **Note injection:** (a) *dispatch time* — `remote_dispatch` / spawn from a mission prepends a
  capped "Mission brief" (goal, current summary, last N notes, ≤ 4 KB) to the prompt; (b) *join* —
  "Attach session to mission" offers "Send brief" (explicit `send_input`); (c) *after compaction* —
  Claude Code `SessionStart` hook (matcher `compact|resume`) installed into the project repo
  (**approved 2026-09-24**), which calls the local daemon (`get_mission_brief { cwd |
  tmuxSessionName }`, proxied to the concierge/home daemon) and prints the brief as additional
  context. (d) sessions can append notes themselves via new MCP tools.
- **SessionStart hook install rules (approved; all required):**
  - *Opt-in per repo:* installed only by an explicit action ("Install compaction re-injection" on
    the mission/member, or `bin/companion mission-hook install <repo>`); never automatically on
    dispatch or mission creation.
  - *Merge, never clobber:* read `<repo>/.claude/settings.json` (or `settings.local.json` if the
    user picks "don't commit" — default `settings.local.json`, which is normally gitignored, to
    avoid dirtying the repo), JSON-parse, append one entry to `hooks.SessionStart` preserving all
    existing hooks/keys/order, write back atomically. Unparseable file → abort with a message, never
    overwrite.
  - *Idempotent:* our entry is identified by a marker (command path
    `~/.companion/bin/mission-brief-hook` + `"companion-mission-hook": 1` tag in a sibling key or the
    command string); re-install updates it in place, never duplicates.
  - *Easy uninstall:* `bin/companion mission-hook uninstall <repo>` + an in-app button remove only
    our entry (and an empty `SessionStart` array we created); `mission-hook status` lists repos
    with it installed (tracked in `~/.companion/mission-hooks.json`).
  - *No-op without an active mission:* the hook script exits 0 with no output in < 200ms when the
    daemon is unreachable (short timeout), the session/cwd has no mission link, or the mission is not
    `active`. It must never block or fail session start.
  - Brief output capped (4 KB) and clearly delimited ("Mission brief (Companion) …").
- **Summary:** deterministic by default (per-member last result highlight, one line per member); a
  concierge-owned mission may overwrite with an LLM summary via `mission_update`.

#### Data Model (sketch)
```ts
interface Mission {
  id: string; title: string; goal: string;
  type: 'adhoc' | 'concierge_fanout' | 'work_group';
  status: 'active' | 'paused' | 'done' | 'abandoned';
  homeServer: { hostname: string; label?: string };
  createdAt: number; updatedAt: number; createdBy: 'user' | 'concierge' | 'foreman';
  members: MissionMember[]; summary?: string; notes: MissionNote[];
  workGroupId?: string;
}
interface MissionMember {
  id: string; serverName: string; host?: string; port?: number;
  tmuxSessionName: string; sessionId?: string; cwd: string; branch?: string;
  role?: string; status: 'pending' | 'working' | 'needs_you' | 'done' | 'error' | 'unknown';
  result?: string; joinedAt: number; lastSeenAt?: number;
}
interface MissionNote {
  id: string; ts: number; author: string;   // 'user' | 'concierge' | 'session:<name>@<host>'
  kind: 'tried' | 'ruled_out' | 'fixing' | 'decision' | 'result' | 'note';
  text: string; memberId?: string;
}
```

#### New WS Messages (feature `missions_v1`)
`list_missions`, `get_mission`, `create_mission`, `update_mission`, `add_mission_member`,
`remove_mission_member`, `append_mission_note`, `get_mission_brief`, `get_mission_links`;
broadcast `mission_update` (global, only to clients that sent `missions_subscribe`). MCP tools:
`mission_create`, `mission_get`, `mission_add_member`, `mission_note`, `mission_update`,
`mission_brief`. Writes from per-origin tokens require `dispatch` capability; audit-logged.

#### Files (anticipated)
- Create: `daemon/src/missions/mission-store.ts`, `daemon/src/missions/mission-tracker.ts`,
  `daemon/src/missions/brief.ts`, `daemon/src/handlers/missions.ts`,
  `mcp/src/tools/mission_*.ts`, `web/src/hooks/useMissions.ts`,
  `web/src/components/MissionsView.tsx`, `web/src/components/MissionDetail.tsx`,
  `web/src/components/MissionNotes.tsx`, `daemon/src/missions/hook-installer.ts` (merge /
  idempotent / uninstall logic, unit-tested against fixtures with pre-existing hooks),
  `daemon/scripts/mission-brief-hook` (installed to `~/.companion/bin/`),
  `bin/companion mission-hook install|uninstall|status`.
- Modify: `daemon/src/types.ts`, `web/src/types/index.ts`, `daemon/src/handlers/index.ts`,
  `daemon/src/handlers/remote.ts` (brief prefix on dispatch), `daemon/src/work-group-manager.ts`
  (optional `missionId`), `concierge/CLAUDE.md` (mission-aware routing, opt-in),
  `web/src/components/ConciergeView.tsx` ("Start as mission"), `FleetInbox`/`InboxCard` (mission chip
  + group-by-mission filter).

#### Acceptance Criteria
- Missions survive daemon restart and session compaction (brief re-injected after compaction when
  hook installed); nothing changes for users who never create one.
- A concierge fan-out started "as mission" shows all members across machines with live status and a
  summary; the concierge can append notes; a newly dispatched session starts with the brief.
- Work groups appear as missions (read-only projection) without changing `/work` behaviour.
- Missions are stored only on the concierge's daemon; web "New mission" targets it.
- Hook install into a repo with existing `SessionStart`/other hooks preserves them byte-for-byte
  apart from our appended entry; install twice → one entry; uninstall → file equals the
  pre-install content (modulo formatting); hook prints nothing and exits 0 when there is no active
  mission or the daemon is down.

#### Decisions / Plan Defaults
- **Q4** ~~Fleet home setting?~~ **Decided 2026-09-24: mission home = the concierge's daemon**; no
  separate setting.
- **Q5** ~~SessionStart hook into project repos?~~ **Decided 2026-09-24: approved**, under the
  install rules above (opt-in per repo, merge, idempotent, uninstallable, no-op without mission).
- **Q6** Notes explicit only in v1 (user, concierge, sessions via MCP); no LLM auto-extraction.
  Plan default, not blocking.
- **R** Tracker polling across machines is a new recurring network loop — must stop when missions
  are idle and honour C5.

---

### Phase 3 — Routing + Fleet Inventory (design-level)
**Size:** M–L (inventory M, placement S, handoff stretch M).

#### Design
- **Inventory (`inventory_v1`):** new `get_host_inventory` handler returning host facts (hostname,
  platform, arch, OS release, CPUs, loadavg, memory, uptime), toolchains (`claude --version`, node,
  git, xcodebuild, java/gradle, Android SDK, cargo — presence + version), and repos. Repo discovery
  from a bounded set: configured `inventory.repo_roots` (new optional config), dirs in
  `tmux-sessions.json`, concierge `projects.json` cwds, and recent working dirs. Per repo: normalized
  remote URL (to match the same repo across hosts), branch, dirty file count, ahead/behind, last
  commit. All execs on demand, stale-while-revalidate cache (toolchains 1h, repos 60s), in-flight
  dedup, timeout + SIGKILL, max 2 concurrent git processes (C5). No background interval.
- **Reachability:** from the client's perspective (connection state + ping RTT, which the web already
  has) and, for the concierge, from the MCP registry.
- **Remote capabilities:** already available via `get_capabilities`.
- **Placement engine:** pure `web/src/utils/placement.ts` (mirrored as an MCP helper so the concierge
  can use the same rules): input = task hints (explicit tags or keyword match like
  `projects.json`: ios → darwin + xcodebuild; android → Android SDK), target repo remote URL,
  preferences; output = ranked hosts with human-readable reasons ("has repo, clean, Xcode 17,
  load 0.4") and disqualifiers ("dispatch disabled", "offline"). Surfaced in `NewSessionPanel`, the
  mission creation flow and concierge; always a suggestion with one-tap override (C1).
- **Fleet view:** `FleetView.tsx` machines grid (inventory + repos) — later the home for Phase 4.
- **Stretch — session handoff:** `handoff` wizard: source session → (confirm) commit WIP to a
  `handoff/<slug>` branch and push → target host fetch + worktree checkout (`create_worktree_session`
  already exists) → dispatch with mission brief/summary. Each step explicitly confirmed; aborts leave
  the source untouched.

#### New WS Messages
`get_host_inventory { refresh?: boolean }` → `host_inventory`; optional `get_repo_status { path }`.
Feature `inventory_v1`. Config: optional `inventory: { repo_roots?: string[]; scan_depth?: number }`.

#### Plan Defaults (not blocking; revisit at Phase 3 kickoff)
- **Q7** Scan known session dirs always; configured `inventory.repo_roots` only if set (off by
  default).
- **Q8** Handoff pushes WIP to a `handoff/<slug>` branch on the existing remote (each step
  confirmed); git-bundle-over-`remote_write` is a later alternative.

---

### Phase 4 — Fleet Health (design-level)
**Size:** 4a read-only S; 4b confirmed rolling update M.

#### Design
- **Build identity:** `dist/build-info.json` (from Phase 1 stamp) is the only reliable version
  source, required because AJ's box is a file copy without git. `get_capabilities.buildInfo` +
  new `get_health` (`health_v1`): uptime, node version, memory/CPU of the daemon process, listener
  config summary (no secrets), watcher stats (conversations tracked), last errors (existing
  `get_client_errors`-style ring buffer for daemon errors), tmux session count.
- **Drift flags (web, `FleetHealth.tsx`):** reference = the web client's own build sha (stamped via
  Vite define) or the newest sha seen in the fleet; flags: sha differs, dirty build, missing
  features the web uses, `protocolVersion` behind, pre-capabilities daemon ("unknown build"),
  deployed-by-copy hosts noted.
- **Rolling "Update fleet" (4b):** a wizard, one daemon at a time, strictly sequential:
  1. show current → target build and what will run;
  2. **explicit per-daemon in-app confirmation** ("Restart <name> now?") — **this counts as the
     required restart sign-off (decided 2026-09-24)**. Each daemon's restart is individually
     confirmed at the moment it is about to happen; no "confirm all", no pre-approval of the rest
     of the queue, no batch or unattended auto-restart, no auto-advance to the next daemon (C6);
  3. call new `self_update` handler, gated by a new `remote_capabilities.update` flag
     (disabled by default, audited), which runs the host's configured `update_command`
     (e.g. local: build + `COMPANION_ALLOW_RESTART=1 bin/companion restart`; AJ: launchd kickstart
     after rsync is done from the build host via `bin/deploy-aj`) detached (`systemd-run --user` /
     `launchctl`) so it survives the restart;
  4. wait for reconnect, verify new `buildInfo.gitSha`, check for orphan-port symptom (known gotcha:
     restart "succeeds" while an orphaned daemon keeps the port → sha unchanged ⇒ flag, stop);
  5. only then offer the next daemon. Any failure stops the rollout.
  The in-app confirmation is recorded in the audit log (who/when/which build) as the sign-off.
  The `update_command` passes `COMPANION_ALLOW_RESTART=1` only because that confirmation happened;
  the `confirmToken` is minted by `self_update_prepare` for one daemon, single-use, short TTL
  (e.g. 60s), so the sign-off cannot be reused for another daemon or replayed later. Restarts
  initiated by Claude in a terminal still need the user's in-conversation sign-off (unchanged).

#### New WS Messages
`get_health` → `health`; `self_update { targetSha?, confirmToken }` → `self_update_started`
(`self_update_v1`, requires `remote_capabilities.update`). `confirmToken` is a one-time value from a
preceding `self_update_prepare` call so a replayed request cannot restart a daemon.

#### Decisions / Plan Defaults
- **Q9** ~~Does in-app confirmation count as sign-off?~~ **Decided 2026-09-24: yes**, per daemon,
  each restart individually confirmed; no batch auto-restart.
- **Q10** Non-git hosts: build on hexi and push (current `bin/deploy-aj` model) in v1. Plan default,
  not blocking.
- **R** A self-update that fails half-way can take a daemon offline with no way to recover from the
  app; 4b must keep a documented manual fallback per host (`bin/deploy-aj`, `bin/companion`).

---

### Phase Ordering & Dependencies
- Phase 1 first (also delivers the capability handshake + build stamp used by all later phases).
- Phase 2 depends on Phase 1 (Inbox chips, capability detection); Phase 3 inventory can run in
  parallel with Phase 2; placement is most useful once missions exist.
- Phase 4a can be pulled forward anytime after Phase 1 (build stamp exists); 4b last.

---


## Item: Mission Control (watch and answer many sessions from one screen)
**Status:** phases 1-3 done 2026-11-03 (daemon summary fields, phone overview, jumping between sessions); phase 4 (desktop grid) open

Plan source: `~/.claude/plans/immutable-conjuring-lemon.md` (copied below).


### Context
The user runs 4+ sessions at once and keeps going back and forth between the session list and each session. Goal: a phone-first overview with one tile per session that shows status and what each session is doing, and lights up when a session needs the user. If the session is asking a question, its tile shows the answer buttons so the user can answer from the tile. Tapping a tile opens the session. Back returns to the overview at the same scroll spot. Inside a session, a "N others need you" chip jumps straight to the next waiting session. Desktop gets the same view after the phone version ships.

What exists today:
- `MobileDashboard` lists sessions per server, sorted by status, with a blue pulse when waiting.
- Back uses the history API in `Dashboard.tsx:273-317`.
- The 2-pane split is desktop-only.
- `send_choice` already works from just a session id and option index.

What's missing:
- The summary has no pending question, no waiting-since time and no last-message snippet. Pending AskUserQuestion prompts exist only in a tmux pane scrape (`watcher.ts:~1487` detects them but doesn't store them).
- The list's scroll position is lost when a session opens.
- There is no "next waiting session" navigation.
- There is no unread tracking.

### Phase 1: Daemon: richer summary (protocol: optional fields only)
Add optional fields to the session entries of `get_server_summary` (`watcher.ts:3499` `getServerSummary`, `handlers/session.ts:387`). Mirror them in `daemon/src/types.ts` and `web/src/types/index.ts` `SessionSummary`:
- `waitingSince?: number`: set when the session's waiting state flips on, cleared when it flips off. Kept in a per-session map in the watcher. Trust prompts reuse `startupPrompts.since`.
- `pendingPrompt?: { question, header?, options[{label, description?}], multiSelect?, kind?: 'trust' | 'approval' | 'choice', signature }`.
  - Choice prompts (AUQ, text permission boxes): cache the `TerminalChoicePrompt` that the existing feedback poll (`watcher.ts:~1487`) already detects, instead of only emitting a signature change.
  - Approvals from the transcript: reuse the same derivation Herald uses (`herald/session-source.ts` `derive()` and `readChoice`). Move the shared piece into the watcher or a helper so the summary and Herald use one source, not two.
  - Trust prompts: `startupPromptFor(id)`.
  - Cleared when the session stops waiting.
- `lastMessage?: string`: the last assistant line, truncated to ~140 chars. It already exists on `status_change`; store the latest per session.
- `send_choice` gets an optional `expectSignature`. If the prompt on screen no longer matches, reply with a `stale` error so a late tap on an old tile can't pick the wrong option. Reuse the signature check Herald's `answer_choice` does (`herald/actions.ts:504`).
- Fix: `send_choice` and `send_input` acknowledge the daemon's active session (`handlers/input.ts`); they should acknowledge the target session so its escalation push is cancelled.
- Pane-capture budget: only waiting sessions are captured, through the existing poll. No new interval and no extra capture loop (per the polling-safety rule).

Tests (jest): summary contains `pendingPrompt` and `waitingSince` for a waiting fixture and drops them when it resumes; `send_choice` with a stale signature is rejected; acknowledge goes to the target session; the protocol mirror test passes.

### Phase 2: Phone overview (`web/src/components/mission/`)
- `MissionControl.tsx`: a new view on mobile, reached by a toggle in the `MobileDashboard` header (List / Overview). The choice is remembered in localStorage, and Overview becomes the default once the user picks it. It lists sessions from all servers in one place; a small server label appears only when there are 2+ servers.
- `SessionTile.tsx`, one per session:
  - Name, agent and profile badge, a status color (working blue, waiting amber glow, idle gray, stuck red via the existing `StuckBadge` store).
  - A live line: `currentActivity`, or else `lastMessage`.
  - Relative time; while waiting, "waiting 3m" from `waitingSince`.
  - When a `pendingPrompt` is present: the question and option buttons. Reuse the `normalize*` helpers from `QuestionBlock.tsx` and `QuestionBlock` itself in a compact mode. Answers go through `connectionManager.getConnection(serverId).sendRequest('send_choice', {..., expectSignature})`, with the same payload `SessionView.tsx:594` builds. Pull that payload builder into `services/sendChoice.ts` so SessionView, ConciergeView and the tile share it.
  - Multi-select, "Other" free text, and multi-question flows show "Open to answer" and open the session instead, keeping tiles simple. Trust prompts get the same yes/no as `TrustPromptCard`, user-only as today.
  - A stale-signature reply shows "Prompt changed, tap to open".
- **Order:** tiles keep a fixed position. The order is saved per device (`services/missionOrder.ts`, localStorage: new sessions are added at the end, removed ones dropped), and long-press on a tile offers "Move up/down". A "Needs you" strip at the top shows a count and taps through waiting sessions, so nothing moves under the user's finger.
- **Unseen marker:** `services/lastViewed.ts` stores `{serverId:sessionId -> ts}` in localStorage, updated when a session is opened or closed. A tile gets a dot when `lastActivity > lastViewed`.
- **Scroll restore:** keep the overview mounted but hidden (`display:none`) while a session is open, instead of the early return at `Dashboard.tsx:662`. This keeps scroll position and tile state at no cost. The same treatment goes to `MobileDashboard`.
- Updates: existing `useAllServerSummaries` (5 s poll plus a 250 ms re-poll on `status_change`). Nothing new.

### Phase 3: Jumping between sessions
- `services/nextWaiting.ts`: a pure function that takes the summaries and the current session and returns the waiting sessions on all servers, oldest `waitingSince` first, skipping the current one.
- `NeedsYouChip` in the `SessionView` header (mobile and desktop): "2 need you". Tap opens the next one (using `requestSessionFocus` so it scrolls to the question). Long-press lists them.
- Next waiting session goes through `handleSelectSession`, which **replaces** the history entry instead of pushing a new one, so Back always lands on the overview, not on a chain of sessions.
- Optional (behind a setting, off by default): after answering the last pending prompt in a session, a toast "Back to overview / next waiting" appears.
- Keyboard (desktop): `]` / `Mod+Alt+]` = next waiting (today `]` walks all sessions; that moves to `Mod+Alt+Shift+]`), `Mod+Alt+1..9` follows the Mission Control tile order. Update `ShortcutHelpOverlay`.

### Phase 4: Desktop
- Mission Control is what the main pane shows when no session is selected, and the sidebar gets an "Overview" entry.
- Grid mode: a responsive tile grid (2x2 up to 3x3) with a taller tile showing the last ~4 highlights. Uses a cheap capped `get_highlights` fetch per tile, only for visible tiles, with an in-flight guard, refreshed on `conversation_update`. Click opens the session full-width; Esc goes back.
- Watching N full `SessionView`s live at once is **not** in this plan (memory/perf cost). Revisit after using the grid.

### Later (not in this plan)
Herald announcing "<session> needs you" for sessions not on screen, and a waiting-count badge on the app icon. Both are listed in todo.md when we commit.

### Files
- Daemon: `src/watcher.ts`, `src/handlers/session.ts`, `src/handlers/input.ts`, `src/types.ts`, `src/herald/session-source.ts` (shared derivation), tests alongside.
- Web: `types/index.ts`, `components/Dashboard.tsx`, `components/MobileDashboard.tsx`, `components/SessionView.tsx`, `components/QuestionBlock.tsx` (compact mode), new `components/mission/{MissionControl,SessionTile,NeedsYouChip}.tsx`, new `services/{sendChoice,missionOrder,lastViewed,nextWaiting}.ts`, `components/ShortcutHelpOverlay.tsx`, CSS next to the existing mobile styles (project colors: amber `#f59e0b` for needs-you).

### Verification
- TDD inner loop with `bin/test --fast`. Vitest for `nextWaiting`, `missionOrder`, `lastViewed`, tile rendering per status and prompt kind, and a stale reply.
- End to end on the **probe instance (9888)** with 4 disposable Claude sessions on a private tmux server (`tmux -L mc-probe`). Make one ask an AskUserQuestion, one ask for a permission, one keep working, and one sit idle. Check the summary fields over WS, answer from a tile, and confirm the session continues. Then stop the probe and kill the private tmux server.
- `bin/test` full gate in the background before commit.
- Real phone check (needs a build with the user's OK, and a daemon restart with the user's OK, since the daemon serves `web/dist`): 4 live sessions, answer from a tile, tap in, Back returns to the same scroll spot, the chip jumps to the next waiting session, Back still lands on the overview.

### Execution
Run as one general-purpose agent per phase pair: (1) daemon Phase 1, then (2) web Phases 2-3 once Phase 1's protocol is merged. Phase 4 runs after the user has lived with the phone version for a bit.

### As built (phases 1-3)
- Daemon: shared `daemon/src/pending-prompt.ts` (summary + Herald use one derivation); `send_choice` `expectSignature` -> `stale_prompt`; `selectedLabels` resolved against the live on-screen box (fails closed). Safety fix: approval answers were positional against a hard-coded 3-option list while Claude Code 2.1.317 shows 4, so No/Reject picked "Yes, and switch to auto mode".
- Still positional: ExitPlanMode Approve and batch-approve (index 0). Pane-only AUQ questionCount unknown.

---

## Item: Open leftovers from archived plans
**Status:** planned

Shipped items live in `plans-archive/` (2026-02, 2026-06, 2026-10). The still-open pieces are kept below verbatim.

### Voice Front Layer: remaining
Phases 3-5 (phone/earbud native audio, device handoff, always-listening) and the Phase 2 items Discord mic hiding and audio ducking are still open (see `plans-archive/2026-10.md`, "Voice Front Layer").

#### Planned: custom "Herald" wake word
**Status:** planned
- Train an openWakeWord model on this box's CPU from synthetic clips (Kokoro and Piper voices saying
  "Herald" / "Hey Herald", varied speed, pitch, room noise) plus negative data (similar words,
  "Harold", everyday speech). Expect a few hours of CPU: run it as an overnight job through a
  `bin/` script (e.g. `bin/herald-voice train-wake`), resumable, nice'd.
- Load it with `HERALD_WAKE_MODELS=/path/hey_herald.onnx`; add its Whisper spellings to
  `WAKE_NAMES` in `daemon/src/herald/voice/wake-phrase.ts` (and the web `voiceCommands.ts` names).
- Keep "hey jarvis" loaded as a fallback option (setting to pick either or both).


### Packaging: push relay
Still planned (see `plans-archive/2026-10.md`, "Packaging for friends & devs", Phase 3).

**Push relay** (`relay/`, small Node service on hexinas behind HAProxy, `push.cush.rocks`):
- Holds the one Firebase service account. Daemons never get FCM credentials.
- Registration: daemon generates an Ed25519 key pair on first use, `POST /v1/daemons` with its
  public key -> relay id. Devices register their FCM/APNs token with their daemon (as today); the
  daemon sends `POST /v1/push {deviceToken, title, body, data}` signed with its key (timestamp +
  nonce, 60 s skew).
- Abuse limits: per daemon 60 pushes/hour, 500/day; per device token 30/hour; at most 20 device
  tokens per daemon; registration rate-limited per IP (5/day); unknown or revoked keys refused; an
  admin can ban a daemon id.
- Privacy: payload carries the session name and at most a 100-character preview; daemon setting
  `push_preview: false` sends only "Session needs input"; the relay logs counts, not bodies, and
  keeps no payloads. PRIVACY.md updated.
- Self-hosters keep `fcm_credentials_path` (direct FCM wins over the relay).

**Secrets.** Daemon reads secrets from env first (`ANTHROPIC_API_KEY`, `COMPANION_HERALD_*`), then
`~/.companion/secrets.env` (0600, `KEY=value`), then config. `install-secrets` keeps cush-tools as an

### Subagent visibility: LLM rollup
On-demand LLM rollup (phase 3) is still planned; see `plans-archive/2026-10.md`, "Subagent visibility".

