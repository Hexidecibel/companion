# Companion - Task List

## Work Queue (Async Tasks)

_(empty — add new tasks here)_

---

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
- [x] Multiple sessions in same project directory - terminal content matching disambiguation
- [x] Session activity alerts for other sessions needing attention

### UI/UX
- [x] Multi-Server Dashboard with connection status, session counts, waiting/working indicators
- [x] Grid/dashboard mode toggle for card-based monitoring view
- [x] Split view via right-click context menu (desktop only)
- [x] Dashboard session sorting (waiting > working > idle)
- [x] Dashboard last activity timestamps
- [x] Expandable tool cards with copy-to-clipboard, elapsed time, diff view
- [x] Expand-all/collapse-all for tool cards
- [x] Tool status (pending/completed) display
- [x] File viewer - tap file paths to view content full-screen
- [x] Quick reply chips for yes/no options
- [x] Slash commands (/yes, /no, /cancel, /switch)
- [x] Scroll-to-bottom button with new message indicator
- [x] Queued message display with cancel button and auto-send
- [x] Auto-approve for safe tools (Read, Glob, Grep, WebFetch, WebSearch)
- [x] Unified terminal and chat input bar
- [x] Optimistic sent message display
- [x] Auto-focus textarea on desktop
- [x] Compacted conversation rendering as markdown with expand/collapse
- [x] Cross-session infinite scroll
- [x] Terminal infinity scroll with offset-based paging

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
- [x] Browser notifications (Notification API)
- [x] Per-session mute synced between web and mobile via daemon

### Server Setup
- [x] QR code server setup (daemon serves QR, app scans)
- [x] Usage/stats page with API token usage and cost breakdown

### Web Control Center (Phase 5 - Complete)
- [x] React + Vite + TypeScript framework
- [x] Multi-server connection manager
- [x] Server configuration persistence (localStorage)
- [x] Authentication flow per server
- [x] Connection health monitoring with auto-reconnect
- [x] Aggregated dashboard view
- [x] Full conversation renderer with role styling
- [x] Tool cards with expand/collapse, diff view, copy-to-clipboard
- [x] Sub-agent visibility
- [x] File viewer with syntax highlighting
- [x] Tmux session management (list, create, kill)
- [x] Keyboard shortcuts for navigation
- [x] Command palette (Cmd+K)
- [x] Image upload support (paste, drag-and-drop, file picker)

### Desktop App (Phase 6 - Complete)
- [x] macOS menu bar with keyboard shortcuts
- [x] System tray icon with click to toggle, badge count
- [x] Close-to-tray behavior
- [x] Window state persistence
- [x] Auto-launch on login toggle
- [x] Native OS notifications

### Parallel Work Groups
- [x] Worker spawning with git worktree isolation
- [x] Foreman orchestration
- [x] Inline worker question answering
- [x] Octopus merge with conflict detection
- [x] Per-server toggle to disable parallel workers
- [x] Sidebar nesting with progress bars
- [x] Push notifications for worker events

### Developer Experience
- [x] Sentry error tracking integration
- [x] /sentry skill for error investigation
- [x] /apk skill for local builds
- [x] EAS build configuration
