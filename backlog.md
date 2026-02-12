# Backlog

Long-term ideas, deferred items, and research notes. Not part of the daily workflow.

---

## iOS Push Notifications
Implement native APNs plugin for tauri-plugin-fcm (currently no-op on iOS, Android only).

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
