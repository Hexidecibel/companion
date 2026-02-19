# Companion Features

High-level features of the Companion daemon, web client, and desktop/mobile apps.

## Cross-Platform Apps
- Single web codebase (React + Vite + TypeScript) powers all client platforms
- **Android** and **iOS** via Tauri 2.0 mobile (native WebView wrapper)
- **macOS**, **Linux**, and **Windows** desktop via Tauri 2.0
- **Web** — served directly by the daemon at `http://<host>:9877/web`
- Mobile-optimized layout with full-screen session list, bottom toolbar, safe area insets
- Desktop layout with sidebar + session view side-by-side

## Real-Time Monitoring
- Live WebSocket updates from CLI coding sessions
- Multi-server, multi-session support
- Multiple concurrent sessions per project directory with automatic disambiguation (terminal content matching, PID detection, process of elimination)
- Session mapping persistence across daemon restarts (`~/.claude/companion-session-mappings.json`)
- Event-driven compaction re-mapping when context compaction creates new JSONL files
- ExitPlanMode and AskUserQuestion detected as "waiting for input" (triggers status banner, push notifications)
- Session status indicators (waiting, working, idle)
- Sub-agent tracking with expandable tree view (status icons, activity, duration, message count)
- Click-to-view sub-agent conversation detail
- Running/completed agent sections with collapsible completed list
- Optimistic sent message display — messages appear immediately in chat before server acknowledgement, including terminal-mode sends
- Direct message sending (no queue) — messages send immediately regardless of session state

## Mobile Input
- Send text and images to the CLI from your phone
- Quick reply chips and slash commands
- Multi-question answering with per-question selection and "Other" freetext
- Multi-select checkbox UI for questions that allow multiple answers
- Undo history for recovering cleared or sent input

## Skill Browser & Slash Commands
- Type `/` in the input bar to see an autocomplete menu of skills, quick actions, and CLI built-ins
- Three sections: **Skills** (from `.claude/commands/`), **Quick Actions** (/yes, /no, /continue, /approve, /reject, /skip, /cancel), **CLI Built-ins** (/help, /clear, /compact, /status, /review)
- Keyboard navigation: Arrow keys, Enter/Tab to select, Escape to dismiss
- Quick actions send immediately; skills and built-ins insert the command for confirmation
- Skill Browser accessible from Settings: browse a catalog of 14 universal skills across 5 categories
- Install skills to project (`.claude/commands/`) or globally (`~/.claude/commands/`)
- Daemon scans installed skills and merges with built-in catalog
- Categories: Workflow, Development, Git, Operations, Search

## Dashboard
- Multi-server overview with connection status
- Grid/dashboard mode toggle for card-based monitoring view
- Split view — right-click a session to open side-by-side, close button on divider (desktop only)
- Session cards showing current activity and task progress
- Expandable task list per session with status indicators
- Task detail screen with full metadata and dependencies
- Kill sessions directly from dashboard with confirmation
- Create new sessions with redesigned wizard: unified path input, instant-create from recents, full-screen mobile sheet
- Quick navigation to any session
- Server enable/disable toggles
- Server cards disabled when no active sessions
- Mobile: full-screen scrollable server/session list with status badges
- Desktop: sidebar with session list + session view side-by-side

## Conversation Viewer
- Markdown rendering in assistant messages (headings, tables, task lists, code blocks with language labels, links)
- User messages rendered as plain text
- Compacted conversation rendering as markdown with expand/collapse toggle
- Expandable tool cards with inputs/outputs
- Smart tool card collapsing with tool name chips and grouping
- Skill tool cards: compact "Skill: {name}" header, collapsed by default, markdown-rendered output when expanded
- Line numbers and language labels on Write/Edit views
- Expandable diff view with "Show all" toggle (40-line default)
- Graceful fallback rendering for unknown tool types
- Full-screen message viewer for long responses
- Activity counters (tokens, cache hits)
- Inline auto-approve toggle in session header
- Text search across session history with match highlighting and prev/next navigation
- Cross-session infinite scroll (chains JSONL files by creation time)

## File & Artifact Viewer
- Open files referenced in conversation with a single tap/click
- Markdown files rendered with full formatting (headings, tables, lists, code blocks, links)
- Diff files rendered with color-coded additions/deletions/hunks
- Syntax highlighting for 22 languages via highlight.js (GitHub Dark theme)
- Code files rendered with line numbers, horizontal scroll, and sticky line numbers
- Progressive rendering for large files (3000 lines at a time with "Show more")
- Image file rendering (PNG, JPG, GIF, SVG, WebP, ICO) via base64
- Binary file detection with size display
- Fuzzy file finder (Cmd+P) with debounced search, keyboard navigation, match highlighting
- "Files" button in session header for quick access to file finder
- Large assistant messages (100+ lines) get "View full output in viewer" button
- Artifact viewer modal for inline content with copy-to-clipboard
- Persistent file tab bar (web) with per-session localStorage persistence
- File path detection in inline code and message text
- Navigate between files via tappable links within the viewer
- APK download and install support on Android

## Plan Viewer
- Detect plan file references in conversation (ExitPlanMode/EnterPlanMode tool calls)
- Plan cards rendered inline for ExitPlanMode with "View Plan" button
- Approve/Reject buttons on pending plan cards (sends "yes"/"no" directly from app)
- Plan file path fallback for pending tools (uses latestPlanFile when tool output not yet available)
- Plan button in session header when a plan file is detected
- Plans open in the file viewer with full markdown rendering

## Push Notifications
- FCM-based push notifications when the CLI needs input
- 2-tier escalation: browser notifications immediately, push after configurable delay
- Consolidated notifications batching multiple pending events into one push
- Quiet hours scheduling
- Per-server notification preferences
- Per-session mute synced between web and mobile via daemon
- Rate limiting to prevent notification storms

## Tmux Session Management
- Create/list/switch tmux sessions from app
- Git worktree support: branch sessions for concurrent editing on the same repo
- Worktree cleanup on session kill
- Directory browser for project selection
- Session recreation for missing sessions
- Auto-detect the CLI in tmux
- Session scoping: only monitors sessions created/adopted by the app (env var tagging)
- Interactive terminal mode: keyboard capture sends keys directly to tmux (arrow keys, enter, ctrl combos)
- Faster polling when terminal is active

## Project Scaffolding (New Project Wizard)
- Multiple stack templates (React, Node, Python, Go, Next.js, MUI)
- Auto-generated CLAUDE.md with project-specific instructions
- Standard slash commands (.claude/commands/) tailored per stack: /up, /down, /todo, /plan, /work, /test
- Git initialization and GitHub repo creation
- Template variable interpolation
- Progress tracking during creation

## Conversation Archive
- Save completed conversation summaries
- Browse and search past conversations
- Per-server archive organization
- Clear all archives

## API Usage Analytics
- Token usage breakdown per session
- Cache hit/miss metrics
- Daily and monthly usage tracking

## Server Setup
- QR code scanning for quick setup
- Token-gated QR code page (enter token first, then see QR + web client link)
- mDNS/Bonjour discovery
- TLS support for secure connections
- Token-based authentication

## Terminal Output Viewer
- Raw tmux terminal output display with ANSI color rendering
- Unified input bar for both chat and terminal modes
- SSH command display with tap-to-copy (mobile) and click-to-copy (web)
- Scroll-position-aware auto-scroll: pauses when reading, resumes at bottom
- Auto-refresh polling with pause/resume toggle
- Horizontal scroll for long lines
- Font size zoom controls (mobile)
- Pull-to-refresh (mobile) and manual refresh button (web)
- Accessible from session header via button or Cmd+T shortcut
- Infinity scroll with offset-based paging for terminal history

## Auto-Approve System
- Automatic approval of safe tool calls (Read, Glob, Grep, etc.)
- "Always Allow" option on pending approval prompts
- Auto-expand pending tool approval cards
- Composite key deduplication to prevent duplicate approvals
- Fuzzy tmux session path matching
- Retry logic for failed approval sends
- Detailed logging for debugging approval flow

## Session Header
- Connection status dot in header (green/yellow/orange/red)
- Unified activity bar combining processing and agent status
- Agents bar togglable via session settings
- Long-press tooltips on all header icons
- Inline auto-approve toggle

## Connection Resilience
- Dead WebSocket detection via readyState verification
- Automatic reconnection on silent WiFi drops
- Session state recovery after reconnection
- Double-connect guard prevents orphaned sockets
- Exponential backoff reconnection with configurable max attempts

## Web Client Keyboard Shortcuts
- Cmd/Ctrl+P: Fuzzy file finder
- Cmd/Ctrl+T: Toggle terminal panel
- Cmd/Ctrl+F: Search messages in session
- Cmd/Ctrl+1-9: Switch to session by sidebar position
- Cmd/Ctrl+Shift+A: Toggle auto-approve
- Cmd/Ctrl+Shift+M: Toggle session mute
- j/k or Arrow keys: Navigate sessions in sidebar
- /: Focus input bar
- ?: Toggle shortcut help overlay
- Escape: Close modal/panel/search (priority-ordered)
- Auto-focus textarea on desktop (re-focuses after any blur)

## Desktop App (Tauri 2.0)
- Native apps for macOS, Linux, and Windows wrapping the web client
- Custom menu bar: Companion, File, Edit, View, Window menus with keyboard shortcuts
- System tray icon: click to toggle window, right-click for Show/Quit menu
- Close-to-tray: closing the window hides to tray instead of quitting
- Tray tooltip shows count of sessions waiting for input
- Native OS notifications (macOS Notification Center, Linux libnotify)
- Window state persistence: remembers position and size across launches
- Auto-launch on login toggle in settings
- Builds to .app/.dmg (macOS), .deb/.AppImage (Linux), .msi (Windows)

## Mobile App (Tauri 2.0)
- Android APK and iOS IPA built from the same web codebase
- FCM push notifications via custom Tauri plugin (tauri-plugin-fcm)
- Safe area insets for edge-to-edge display on Android
- Android back gesture support (navigates session -> dashboard -> settings)
- Bottom action toolbar on mobile (terminal, auto-approve, mute, plan, history)
- Full-screen mobile dashboard replacing sidebar navigation
- Camera access for QR code scanning

## Daemon CLI
- `bin/companion` — top-level entry point, auto-builds daemon + web client when stale
- `companion start` — background start with PID file, already-running detection, 1-second liveness check
- `companion start -f` — foreground start for debugging
- `companion setup` — first-time wizard: creates config, generates token, prints connection info with QR code
- `companion autostart enable/disable` — manages systemd user service (Linux) and launchd agent (macOS)
- `companion status` — show running state, PID, tmux sessions, config summary
- `companion stop` — graceful shutdown via PID file
- `companion config` — view/set config values
- `companion logs` — platform-aware log viewing (macOS launchd / Linux journalctl / `~/.companion/daemon.log`)
- Robust build detection: only rebuilds when source files are newer than build output
- Platform-aware log locations: `~/Library/Logs/companion.log` (macOS), `~/.companion/daemon.log` (Linux)

## Parallel Work Groups
- Spawn multiple Claude Code sessions in parallel from `/work` command
- Each worker runs in its own git worktree on a dedicated branch
- Foreman session orchestrates workers and handles sequential items
- Worker lifecycle management: spawning, working, waiting, completed, error states
- Inline question answering: respond to worker questions without switching sessions
- Octopus merge of completed worker branches with conflict detection
- Cancel/retry controls for individual workers or entire groups
- Per-server toggle to disable parallel worker spawning
- Web dashboard: sidebar nesting with tree connectors and progress bars
- Web dashboard: WorkGroupPanel with worker cards, merge/cancel controls
- Mobile dashboard: expandable work group cards with worker sub-cards
- Push notifications for worker questions, errors, and group completion
- State persistence across daemon restarts
- Worker prompt injection with scoped task instructions

## Visual Theme
- Blue-to-purple gradient headers across all screens (mobile + web)
- Gradient primary action buttons (blue to purple)
- Tinted card backgrounds with accent left borders
- Purple focus glow on input fields (web)
- Gradient progress bars for tasks and work groups
- Purple accent text and gradient headings
- Centralized color system (web CSS variables)
- Consistent dark theme with vibrant accent hierarchy

## Developer Tools
- Sentry error tracking integration
- Error boundary with user feedback and bug reporting
- Centralized tool configuration (daemon/src/tool-config.ts)
- Structured parser warnings for unknown tools and entry types
- Build date and version info in settings
- Scroll behavior analytics
- Client error reporting
- Management scripts in `bin/` with usage headers and dep checks (companion, build, build-all, build-apk, deploy, dev, test)

## Away Digest
Summary card on the dashboard when returning after inactivity, showing what happened while you were away.

- "While you were away" banner with relative time and event summary
- Groups events by session: completed, waiting, errors
- Per-session rows with status icons and preview text
- Dismissible with fade-in animation
- 5-minute inactivity threshold to avoid noise
- Fetches from daemon notification history (persisted to disk)
- Works on both mobile and desktop dashboards

## Cost Dashboard
Full-screen usage and cost analytics with daily tracking and budget alerts.

- Stat cards: total cost today, this week, this month
- Daily usage bar chart (7-day or 30-day view)
- Per-model token breakdown (when Anthropic admin API key configured)
- Per-session cost estimates with USD amounts
- Configurable budget thresholds with push notification alerts
- Daemon-side daily snapshot persistence (90-day history)
- Accessible from settings navigation

## Usage Dashboard
Real-time utilization gauges using Claude Code OAuth credentials — no admin API key required.

- CSS conic-gradient gauge rings for 5-hour and 7-day utilization windows
- Color-coded thresholds: green (<50%), amber (50-75%), red (>75%) with glow effect
- Live countdown timers showing time until rate limit resets
- Subscription tier badge (MAX, Pro, etc.)
- Model-specific utilization bars (Opus, Sonnet, Cowork) when available
- Extra usage credit tracking card
- Collapsible cost breakdown section (reuses existing admin-key cost dashboard)
- Configurable threshold notifications (50%, 75%, 90%, 95%) with push escalation
- Daemon polls every 3 minutes with 3-minute cache; web auto-refreshes
- Graceful fallback when OAuth credentials not available

## Code Review Mode
Consolidated diff view of all files changed by a session, with approve/reject actions.

- Auto-triggers on session completion with review card in conversation
- Manual "Review" button in session header for mid-session review
- Git diff on server for accurate consolidated diffs
- JSONL Edit/Write fallback for non-git directories
- Per-file diff stats (insertions/deletions) with expandable diff view
- "Looks good" to dismiss or "Request changes" to send feedback
- Opens diffs in existing file viewer with full syntax highlighting
- Full-screen code review modal with keyboard navigation (j/k, arrows, Enter, Escape)
- File list panel with diff viewer side-by-side (stacked on mobile)
- Consolidated entry point: Review button and file changes summary both open the modal
- Auto-refresh on file changes: listens for `conversation_update` broadcasts to re-fetch diffs when Write/Edit tools complete

## Mobile Session Context Menu
Long-press or right-click on a mobile session to get a full context menu.

- Open in Split, Rename, Mute/Unmute, Kill Session actions
- Replaces old inline kill-confirm UI with proper ContextMenu component
- Matches desktop sidebar context menu feature parity

## Session Jump Hotkeys
Keyboard shortcuts for fast session switching on desktop.

- Hold Ctrl/Cmd+Alt to show numbered badges (1-9) on sidebar sessions
- Ctrl/Cmd+1-9 jumps to session by position (existing)
- Ctrl+Tab / Ctrl+Shift+Tab cycles through recently used sessions (MRU)
- Jump badges animate in with scale effect
- MRU list maintained per session (resets on page reload)
- Documented in shortcut help overlay (?)

## Session Renaming
User-assigned friendly names for sessions, replacing cryptic tmux session IDs.

- Right-click "Rename" in both desktop sidebar and mobile context menus
- Friendly names persisted on daemon at `~/.companion/session-names.json`
- Display friendly name everywhere: sidebar, mobile dashboard, session cards
- Falls back to tmux session name / project path if no friendly name set
- Real-time broadcast to all connected clients on rename
- Clear friendly name by entering empty string

## Git Integration Toggle
Configurable `git` boolean in daemon config that gates all git-dependent behavior.

- `"git": true/false` in daemon config (default: true)
- Daemon sends `gitEnabled` to web clients in auth response
- When disabled: code review shows JSONL file changes without diffs, worktree/work-group endpoints return errors/empty
- When enabled: code review filters out already-committed files (no remaining diff and tracked by git)
- Web UI hides parallel workers toggle and work group controls when git is disabled
- Backward compatible: older daemons without the field default to enabled

## Mobile Toolbar Layout
Split mobile session toolbar across header and footer to prevent overflow.

- View/action buttons (Files, Search, Plan, Review) moved to mobile header alongside Back button
- Operational buttons (Cancel, Notify, Auto, Tools, Terminal) remain in bottom bar
- Desktop layout unchanged — all buttons in header
- Reduces bottom bar from up to 8 buttons to max 5

## Tool Card Visibility Toggle
Per-session toggle to show or hide tool call cards in conversation view.

- "Tools: ON/OFF" button in bottom bar (mobile) and header (desktop)
- When hidden, tool cards are completely removed from the DOM for cleaner reading
- Pending tool cards always shown (require user action like approval)
- ExitPlanMode cards always shown regardless of toggle
- State persisted per session in localStorage

## Test Suite
Comprehensive automated tests for daemon parser and web client services.

- **Daemon parser:** 96 tests across 13 functions (parseConversationFile, detectWaitingForInput, extractHighlights, detectCurrentActivityFast, detectIdle, detectCurrentActivity, getSessionStatus, getPendingApprovalTools, detectCompaction, extractUsageFromFile, extractFileChanges, parseConversationChain, getRecentActivity)
- Inline JSONL fixture builders for readable, maintainable test data
- **Web client:** Vitest + @testing-library/react + jsdom infrastructure
- ServerConnection tests (23): connection lifecycle, auth handshake, reconnection, request/response matching, message handlers, config updates
- ConnectionManager tests (14): multi-server management, snapshots, connect/disconnect, change handlers
