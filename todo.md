# Todo

Quick capture for ideas and tasks. Run `/plan` to process into detailed plans.

---

## Done
- [done] Settings page: about area at bottom needs padding
- [done] Permissions bypass toggle - per-server setting
- [done] Server connection on/off toggle on dashboard
- [done] Conversation archive & search (MVP: no search yet)
- [done] Expandable session tasks on dashboard with task detail screen
- [done] Kill session from server dashboard
- [done] Create new session from server dashboard with recent projects
- [done] Server card disabled when no active sessions
- [done] More scrolling/chat window stability
- [done] Safe padding on edit server screen (and all screens)
- [done] Text overflowing bubble fix
- [done] Build info/date in about screen
- [done] Collapse tool windows into expandable cards with chips and grouping
- [done] Rich session task expansion card with task detail page
- [done] New project setup wizard with templates
- [done] Scroll to bottom of conversation on session switch
- [done] Fix in-app other-session notifications (shadowed variable)
- [done] Error boundary with Sentry bug reporting
- [done] Better write/edit viewer with line numbers and expanded limits
- [done] Debug auto-approve with composite dedup, logging, retry
- [done] Centralized tool config (daemon/src/tool-config.ts)
- [done] Graceful fallbacks for unrecognized tools/formats
- [done] Structured parser warnings for unknown tools and entry types
- [done] Terminal output viewer accessible from session header
- [done] Inline auto-approve toggle in session header
- [done] Populate features file
- [done] Disabled servers still connecting - block in wsService.connect() and auto-reconnect
- [done] Fix session switching regression - dead WebSocket detection and reconnection
- [done] Fix new session creation/attaching bugs (wrong chat, can't send)
- [done] Session header redesign - Ionicons, auto-approve header-only, instant notify session-only
- [done] Better waiting/idle distinction on dashboard - idle state, grayed out sessions
- [done] Change settings icon to a cog on server dashboard bottom left FAB
- [done] Show password in token field on Server edit screen
- [done] Fix AskUserQuestion multi-select and multiple questions
- [done] Improve sub-agents UX - click-to-view detail, better status, collapsible completed
- [done] iOS build
- [done] Desktop/web control center - notification escalation, browser notifications, terminal viewer, SSH connect, session muting
- [done] Per-session mute on mobile synced with web via daemon
- [done] Open files in user's editor of choice from web client (daemon open_in_editor endpoint)
- [done] Web: auto-scroll follow when at bottom + new text arrives
- [done] Web: don't disable input bar so aggressively — allow typing while assistant is working
- [done] CLI for daemon management (start, stop, status, config, logs, install)
- [done] Beef up project wizard - CLAUDE.md + .claude/commands generation per template
- [done] Git worktree support for multiple sessions on same project
- [done] Mobile terminal parity - SSH command display, copy, scroll-aware auto-scroll
- [done] Parallel Work Groups - daemon, web dashboard, mobile dashboard, push notifications, tests
- [done] Vibrant color refresh - blue/purple accents across mobile + web
- [done] Interactive terminal mode - toggle keyboard capture in terminal view, sends keys to tmux (arrow keys, enter, ctrl combos, printable chars), faster polling when active

## Planned
(none)

## In Progress
(none)

## Upcoming
- Persistent file tab bar in web SessionView -- service/hook/component scaffolded (web/src/services/openFiles.ts, hooks/useOpenFiles.ts, components/FileTabBar.tsx, CSS added) but wiring into SessionView causes a hard browser freeze on file open. Needs debugging -- possibly related to re-render cascade or FilePathContent regex interaction. Reverted SessionView to pre-tab-bar state.
- Plan viewer: Claude generates markdown plan files (via EnterPlanMode) that aren't visible in the web client or mobile viewer. Add ability to detect plan file references in conversation, link to them, and open a markdown viewer. Plans are .md files written to the scratchpad or project directory.
- Cross-session infinite scroll: Stitch together previous JSONL conversation files for the same project so the user can scroll back through the full project history, not just the current session. Watcher discovers sibling files sorted by creation time, parser chains backwards across file boundaries when load-more exhausts the current file.
- Interactive terminal mode for mobile: Port the web interactive terminal feature (keyboard capture, key mapping, send_terminal_keys) to the React Native mobile app terminal view. Would need a keyboard input overlay and the same key mapping logic.
- OpenAI Codex CLI parser: Add parser support for OpenAI Codex CLI conversation format so Companion can monitor and interact with Codex sessions alongside Claude sessions. Would need to discover Codex conversation files, parse their format, and translate into our internal message types.
- Remove client-side message queueing -- just send directly via tmux (tmux already buffers input natively). Current queue gets stuck when isWaitingForInput state is stale.

## Deferred
(none)
