# Companion - Task List

## Completed

### Core Features
- [x] Real-time session monitoring via WebSocket
- [x] Mobile input to send text/images to the CLI
- [x] Multi-server support with server list management
- [x] Push notifications (FCM) when the CLI is waiting for input
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

## Phase 5: Web Control Center & Configurable Push Notifications

The web client becomes the primary high-performance workspace for managing all Claude instances. Mobile remains the on-the-go fallback.

### 5.1 - Web Foundation & Framework
- [ ] Choose and set up web framework (React + Vite or similar) to replace vanilla JS
- [ ] Set up build tooling, dev server, TypeScript
- [ ] Multi-server connection manager - connect to multiple daemons simultaneously
- [ ] Server configuration persistence (localStorage) - add/edit/remove servers
- [ ] Authentication flow per server (token-based, same as today)
- [ ] Connection health monitoring - status indicators, auto-reconnect per server

### 5.2 - Multi-Server Dashboard
- [ ] Aggregated dashboard view - all servers, all sessions, one screen
- [ ] Session cards with server name, status (waiting/working/idle), last activity
- [ ] Sorting and filtering - by status, by server, by project
- [ ] Server health indicators (connected/disconnected/error) in sidebar or header
- [ ] Session count badges per server
- [ ] Click-through from dashboard to full session view

### 5.3 - Session View Feature Parity
- [ ] Full conversation renderer with role styling and timestamps
- [ ] Tool cards with expand/collapse, diff view, copy-to-clipboard, elapsed time
- [ ] Expand-all / collapse-all toggle
- [ ] Sub-agent visibility - indicator bar, detail modal with status/duration
- [ ] File viewer - click file paths to view content
- [ ] Quick reply chips for yes/no/options
- [ ] Scroll-to-bottom with new message indicator
- [ ] Queued message display with cancel
- [ ] Auto-approve toggle for safe tools
- [ ] Conversation archive - save, list, view, delete

### 5.4 - Control Center Power Features
- [ ] Tmux session management - list, create, kill sessions remotely
- [ ] Multi-pane / split view - watch multiple sessions side by side
- [ ] Keyboard shortcuts for navigation and common actions
- [ ] Command palette (Ctrl+K / Cmd+K) for quick actions
- [ ] Usage/stats view - API token usage and cost breakdown per server
- [ ] Image upload support (paste, drag-and-drop, file picker)

### 5.5 - Configurable Push Notifications
- [ ] Notification rules engine on daemon - define conditions for when to notify
- [ ] Rule types: waiting for input, errors, session completed, custom text match
- [ ] Per-server notification preferences (which servers notify you)
- [ ] Per-session notification preferences (mute/unmute individual sessions)
- [ ] Device management UI - see registered devices, remove old ones
- [ ] Browser notifications for the web client (Notification API + service worker)
- [ ] Enhanced mobile push - rules-based filtering applied before FCM/Expo send
- [ ] Notification history/log - see what was sent and when

### 5.6 - Daemon Endpoints for Control Center
- [ ] `manage_tmux` endpoint - list/create/kill tmux sessions
- [ ] `get_server_info` endpoint - server name, uptime, connected clients
- [ ] `get_notification_rules` / `set_notification_rules` endpoints
- [ ] `get_devices` / `remove_device` endpoints for device management
- [ ] `get_stats` endpoint - aggregated usage across sessions

---

## Phase 6: macOS Desktop App

The Tauri-based desktop app wraps the web client in a native shell. These tasks add native platform features that a browser tab can't provide.

### 6.1 - Essential (app feels broken without these)
- [ ] File/image upload - drag-and-drop from Finder, clipboard paste (Cmd+V), and native file picker
- [ ] Native macOS notifications - replace browser Notification API with Tauri `notification` plugin; integrate with Notification Center, Do Not Disturb, click-to-focus
- [ ] Window state persistence - remember size/position between launches (Tauri `window-state` plugin)

### 6.2 - Native Feel (makes it feel like a real Mac app)
- [ ] macOS menu bar - File (New Session, Close Window), Edit (standard), View (Reload, Zoom), Window (Minimize, Zoom, Bring All to Front)
- [ ] Menu keyboard shortcuts - Cmd+, for settings, Cmd+N new session, Cmd+1-9 switch sessions, Cmd+W close window (not quit)
- [ ] System tray / menu bar icon - background status indicator, click to show/hide window, badge count for waiting sessions
- [ ] Auto-launch on login - Tauri `autostart` plugin, toggle in settings

### 6.3 - Nice to Have
- [ ] Deep links - `companion://` URL scheme to open specific sessions from terminal or other apps
- [ ] Global hotkey - toggle window visibility from anywhere (e.g. Ctrl+Shift+C)
- [ ] Touch Bar support - session status indicators for older MacBook Pros
- [ ] Build pipeline - add desktop/Tauri builds to CI workflow
- [ ] Code signing and notarization for distribution outside App Store
- [ ] Auto-update - Tauri `updater` plugin for in-app updates

---

## Future / V2+ Ideas

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

### Daemon CLI
- Unified CLI for daemon management
  - `companion up` - Start daemon
  - `companion down` - Stop daemon
  - `companion status` - Show status, port, connected clients
  - `companion install` - Set up as system service (systemd on Linux, launchd on macOS)
  - `companion logs` - Tail daemon logs
  - `companion config` - Show/edit config
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
