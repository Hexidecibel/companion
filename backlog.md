# Backlog

Long-term ideas, deferred items, and research notes. Not part of the daily workflow.

---

## iOS Push Notifications
Implement native APNs plugin for tauri-plugin-fcm (currently no-op on iOS, Android only).
**Promoted to todo.md** — required for App Store release.

## OpenAI Codex CLI Parser
Add a parser/watcher for OpenAI's Codex CLI so Companion can monitor both Claude Code and Codex sessions. Users would choose their AI per session/project.

### Research (2026-02-11)
**Verdict: Feasible but risky — wait for format stability.**

Codex stores JSONL in `~/.codex/sessions/<provider>/<date>/<uuid>.jsonl`. Runs fine in tmux, input injection works identically. A `codex-parser.ts` + `codex-watcher.ts` could map Codex events into our existing types.

**Key blockers:**
- Rollout JSONL format is explicitly an "internal detail" — already broken once (PR #3380). Parser would need ongoing maintenance against a moving target.
- Approval detection is architecturally different — Codex uses JSON-RPC app-server protocol, not JSONL state.
- Sessions organized by date not project path — different discovery logic needed.
- ~2-4 days for basic implementation, ongoing maintenance cost.

**When to revisit:** Once OpenAI stabilizes/documents the format as a public API, or if user demand justifies the maintenance burden.

**References:**
- [openai/codex](https://github.com/openai/codex)
- [Codex CLI docs](https://developers.openai.com/codex/cli)
- [App-server protocol](https://developers.openai.com/codex/app-server/)

## Dispatch Mode — Background Agents with Chat-Ready Main Thread

When implementing a multi-file plan, the current workflow blocks the main conversation thread with sequential edits. The user can't chat, steer, or redirect until the work is done.

**Idea:** A "dispatch mode" where the companion:
1. Receives a plan (or generates one from a task)
2. Identifies parallelizable subtasks (e.g., daemon changes, CSS, component rewrites)
3. Spawns each subtask as a background agent (worktree-isolated where possible)
4. Keeps the main thread free for the user to chat, ask questions, reprioritize, or cancel subtasks mid-flight
5. Aggregates results back — shows diffs, merges worktrees, reports status

**Key design questions:**
- How to detect which subtasks are independent vs sequential (dependency graph from the plan)?
- How to present live progress to the user — task list widget? inline status messages?
- Should subtask agents get the full plan context or just their slice?
- Merge strategy when multiple agents edit the same file (rare if plan is well-structured)
- How does steering work — can the user say "skip the CSS part" or "change the approach for task 3" mid-flight?

**Why it matters:** Keeps the human-in-the-loop experience responsive. The user's time is the bottleneck, not the AI's — so the AI should never hold the conversation hostage during mechanical work.

**Rough scope:** ~3-5 days. Touches daemon (task orchestration), web (progress UI), and the CLI integration layer.
