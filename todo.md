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

## In Progress
- Fix session switching regression - dead WebSocket detection and reconnection
- Fix new session creation/attaching bugs (wrong chat, can't send)

## Upcoming
- Change settings icon to a cog on server dashboard bottom left FAB
- Beef up new project helper - let Claude help choose language/stack with back-and-forth discussion, analyze project and order options by recommendation, option to create a private GitHub repo
- Move permissions into session (makes more sense in session settings)
- Installable actions/skills - introspect codebase and create custom skills
- Multi-select bug in AskUserQuestion - selecting multiple options in Termux only submits first
- Evaluate sub-agents UX - not useful as-is, need click-to-view status, proper cleanup when done, or remove from session view entirely since they're always running
- Show password in token field on Server edit screen
- Don't include token in QR code unauthenticated - force entry of token before showing QR
- Session header redesign - icons look odd, auto-approve duplicated in header and session settings, instant notify duplicated in session settings and server settings, re-evaluate header and session settings for optimal layout/experience
- Better waiting/idle distinction on dashboard - finished sessions show "waiting" and rise to top over working ones, add "idle" state and gray out idle sessions

## Deferred
- iOS build (need Apple Developer account first)
- CLI for daemon management (current /up /down skills work fine)
