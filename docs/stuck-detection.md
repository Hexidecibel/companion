# Stuck-session detection

Moved verbatim from `CLAUDE.md` (2026-11-03) to keep the auto-loaded context small.

### Stuck-session detection (daemon)
Code in `daemon/src/stuck/` (`signals.ts` pure analysis, `normalize.ts` failure keys / pane reading, `detector.ts` state + guarded captures, `store.ts` settings), handlers in `daemon/src/handlers/stuck.ts`, plan in `plan.md`.
- **Protocol:** `daemon/src/stuck/protocol.ts` is mirrored byte-for-byte by `web/src/types/stuck.ts` (mirror test). Requests `stuck_list` / `stuck_snooze` / `stuck_dismiss` / `stuck_ask` / `stuck_interrupt` / `stuck_get_settings` / `stuck_set_settings`; GLOBAL event `stuck_update` (full visible list).
- **Deterministic and cheap:** analysis walks the current turn of the parsed transcript (`ToolCall.isError` comes from `tool_result.is_error`; `status` stays `completed`, an `error` status would fire error-detected escalations). Only while working; findings clear on idle / waiting / a new prompt / recovery.
- **Pane captures** (time-based signals only: no_progress, stalled_tool) go through `StuckDetector.capture`: in-flight dedupe per session, our own timeout on top of `defaultCapturePane`'s SIGKILL, liveness against the watcher's live list (no subprocess), at most 2 per tick, >= 2 min apart per session. Never add another capture path.
- **Herald:** one `stuck` inbox item per session (key = session + turn: tones once per turn, own `stuck` tone, never spoken), `[looks stuck]` briefing lines, tools `stuck_sessions` / `snooze_stuck`, banner actions through `relayAsk` and `HeraldService.proposeInterrupt` (echo tier). Quiet hours (escalation config) keep items off the inbox.
- **Settings:** `~/.companion/stuck/settings.json` (`COMPANION_STUCK_STATE_DIR`); snoozes and "not stuck" are memory only.
- **Live test:** the probe with `TMUX_TMPDIR=<short private dir>` and `TMUX` unset sees only an isolated tmux server (socket path must stay under 108 chars); Claude Code blocks `sleep N && cmd`, so make the failing test itself slow.
