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

## Planned
- CLI for daemon management (install, start, stop, config, status)
- Per-session mute on mobile (web already has it)

## Upcoming
- New project wizard updates: collect project description from user, use it to advise on stack, then scaffold a v1 of the app (planning with user as first thing in new project)
- Auto-approve sends "yes" too aggressively while processing - needs throttling or smarter detection of when approval is actually needed
- Allow multiple sessions for the same folder - will need to set up git worktree stuff if doing concurrent editing
- Beef up new project helper - let the assistant help choose language/stack with back-and-forth discussion, analyze project and order options by recommendation, option to create a private GitHub repo
- Move permissions into session (makes more sense in session settings)
- Installable actions/skills - introspect codebase and create custom skills
- Don't include token in QR code unauthenticated - force entry of token before showing QR
- Tmux session manager from web to mobile

## Deferred
(none)
