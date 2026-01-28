# Todo

Quick capture for ideas and tasks. Run `/plan` to process into detailed plans.

---

## UI Fixes
- [done] Settings page: about area at bottom needs padding, spilling over into safe area

## Features
- [done] Permissions bypass toggle - per-server setting to match Claude's auto-approve mode
- [done] Server connection on/off toggle on dashboard - quick enable/disable per server
- [done] Conversation archive & search - save compacted convos, full-text search (MVP: no search yet)

## Daemon
- [skipped] CLI for daemon management - current /up /down skills work fine

## Dashboard
- [in-progress] Expandable session on dashboard to show running tasks beneath. With ability to click into task to see its current output in a new task screen
  - Backend done: task parser, types, WebSocket endpoint
  - TODO: Dashboard UI to show tasks

## Stability
- [done] More scrolling/chat window stability and tests. It is hard to use sometimes when lots of messages come through
  - Added React.memo to ConversationItem with custom comparison
  - useScrollBehavior hook already had good scroll position management

## UI Fixes (New)
- [done] Safe padding on edit server screen (and all screens)
- [done] Intermittent error with text overflowing bubble (long text escapes container bounds)

## Platform
- [deferred] iOS build (need Apple Developer account first)

## New
- Build info/date for APK somewhere in about screen
- Collapse multiple tool windows into one expandable card (to make reading easier, span less pages)
- Finish rich session task expansion card (with task detail page)
- Installable actions/skills - introspect codebase and create custom skills like /todo, /up, /down, /work
- [done] New project setup wizard - skill setup, git setup, language choice. Discuss project at high level and scaffold starting dir via Claude
- Populate features file with all current features (big highlights, not granular) - work command will keep it updated
- [done] Scroll to bottom of conversation on session switch
- [done] Fix in-app notifications - not seeing banner when other sessions have activity (bug: shadowed variable)
