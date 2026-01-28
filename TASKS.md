# Claude Companion - Task List

## Completed

### Core Features
- [x] Real-time session monitoring via WebSocket
- [x] Mobile input to send text/images to Claude
- [x] Multi-server support with server list management
- [x] Push notifications (FCM) when Claude is waiting for input
- [x] Android 13+ notification permission prompt
- [x] mDNS discovery for local daemons
- [x] Auto-reconnection with exponential backoff
- [x] TLS support for secure connections

### Session Management
- [x] Tmux session filtering - only show conversations from tmux projects
- [x] Multi-session support - switch between sessions on same server
- [x] Session activity alerts for other sessions needing attention

### UI/UX
- [x] Multi-Server Dashboard with connection status, session counts, waiting/working indicators
- [x] Dashboard session sorting (waiting > working > idle)
- [x] Dashboard last activity timestamps
- [x] Expandable tool cards with copy-to-clipboard, elapsed time, diff view
- [x] Expand-all/collapse-all for tool cards
- [x] Tool status (pending/completed) display
- [x] File viewer - tap file paths to view content full-screen
- [x] Quick reply chips for yes/no options
- [x] Slash commands (/yes, /no, /cancel, /switch)
- [x] Scroll-to-bottom button with new message indicator
- [x] Queued message display with cancel button
- [x] Auto-approve for safe tools (Read, Glob, Grep, WebFetch, WebSearch)
- [x] FlatList touch handling fix (keyboardShouldPersistTaps)

### Sub-Agent Visibility
- [x] SubAgentWatcher watches subagents/ directory
- [x] Sub-agent indicator bar in SessionView
- [x] Sub-agent modal with status, duration, description
- [x] Filter sub-agents by current session
- [x] Auto-cleanup stale agents

### Notification Preferences
- [x] Configurable notification settings per server
- [x] Instant vs delayed notifications
- [x] Quiet hours / Do Not Disturb schedule
- [x] Rate limiting (throttle notifications)

### Server Setup
- [x] QR code server setup (daemon serves QR, app scans)
- [x] Usage/stats page with API token usage and cost breakdown

### Web Interface
- [x] Web client for browser-based access
- [x] Real-time WebSocket connection
- [x] Responsive design for desktop/tablet

### Developer Experience
- [x] Sentry error tracking integration
- [x] /sentry skill for error investigation
- [x] /apk skill for local builds
- [x] EAS build configuration

### Settings & Preferences
- [x] Settings page safe area padding for bottom notch devices
- [x] Per-server enabled toggle to disable connection without deleting
- [x] Per-server autoApproveEnabled flag for permission bypass
- [x] Conversation archive (MVP) - save compacted summaries, list view, delete

---

## Pending

_Empty - all items from this round complete!_

---

## Future / V2 Ideas

### Conversation Archive - V2 Enhancements
- Full-text search across archived conversations
- Ability to export/share conversation history
- Filter by server/project

### Scheduled Agents (Phase 4)
- SchedulerService with node-cron integration
- AgentRunner for spawning and monitoring
- CRUD endpoints for scheduled agents
- Webhook endpoint support
- File watcher trigger support

### Platform Expansion
- iOS build and TestFlight distribution
- Web interface feature parity with mobile
  - File viewer with APK download support
  - Sub-agent visibility and modal
  - Session picker and multi-session support
  - Tool cards with expand/collapse, diff view
  - Quick reply chips for yes/no options
  - Scroll behavior and new message indicator

### Daemon CLI
- Unified CLI for daemon management
  - `claude-companion up` - Start daemon
  - `claude-companion down` - Stop daemon
  - `claude-companion status` - Show status, port, connected clients
  - `claude-companion install` - Set up as system service (systemd on Linux, launchd on macOS)
  - `claude-companion logs` - Tail daemon logs
  - `claude-companion config` - Show/edit config
- Could use commander.js or similar for CLI parsing
- Auto-detect platform for service installation

### Advanced Features
- Historical usage graphs
- Team collaboration - share agents, approval workflows
- Audit log for approvals and agent runs
- Cost tracking - estimate token usage per agent
- Pre-built agent templates (PR reviewer, test runner, etc.)
- MCP integration for scheduled agents

---

## Work Queue (Async Tasks)

_Empty - ready for new tasks!_

---

## Build Status

**Latest Commit:** 0a70157
- Sub-agent visibility
- Dashboard refinements
- Scroll fixes
- Tool card expand-all/collapse-all
