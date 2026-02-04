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
- [done] Remove client-side message queueing - replaced with direct tmux send, removed useMessageQueue/QueuedMessageBar

## Planned
- [done] Persistent file tab bar in web SessionView -- debug browser freeze, wire useOpenFiles hook, memoize FilePathContent (plan.md #6)
- [done] Plan viewer -- detect plan file references, render plan cards for ExitPlanMode, plan button in session header (plan.md #7)
- [done] Cross-session infinite scroll -- chain JSONL files by creation time, cross-file pagination in parser (plan.md #8)
- [done] Interactive terminal mode for mobile -- hidden TextInput + virtual key bar, reuse send_terminal_keys endpoint (plan.md #9)
- [deferred] OpenAI Codex CLI parser -- discover Codex conversation files, parse format, translate to internal types (plan.md #10)
- [done] Text search across session history -- search bar with match highlighting, prev/next navigation (plan.md #11)
- [done] Remove archive button from web session header (plan.md #12)
- [partial] Web/mobile parity -- clear history, dynamic version, clear all archives done; remaining: sub-agents tree view, mobile search, mobile plan viewer (plan.md #13)
- [done] macOS desktop app -- Tauri wrapper around web client (plan.md #14)
- [done] macOS desktop essential -- file upload in Tauri, native notifications, window state persistence (plan.md #16)
- [done] macOS desktop native feel -- custom menu bar, system tray icon, auto-launch on login (plan.md #17)
- [planned] macOS desktop nice-to-have -- global hotkey, deep links, code signing, auto-update (plan.md #18)
- [done] Web client keyboard shortcuts -- Cmd/Ctrl+T terminal, Cmd+K palette, Cmd+1-9 sessions, ? help overlay (plan.md #15)

## In Progress
(none)

## Upcoming
- File viewer still freezes on open
- [done] File/artifact viewer & markdown everywhere -- render assistant messages as formatted markdown on web/desktop, enhanced file viewer with breadcrumbs/search/virtualization, mobile file viewer upgrade, large output "view as artifact" button (plan.md #19)

## Deferred
- OpenAI Codex CLI parser (plan.md #10) -- roadmap item, not prioritized
