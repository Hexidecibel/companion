# Companion Features

High-level features of the Companion mobile app and daemon.

## Real-Time Monitoring
- Live WebSocket updates from CLI coding sessions
- Multi-server, multi-session support
- Session status indicators (waiting, working, idle)
- Sub-agent tracking with real-time status bar
- Click-to-view sub-agent conversation detail
- Running/completed agent sections with collapsible completed list

## Mobile Input
- Send text and images to the CLI from your phone
- Quick reply chips and slash commands
- Message queuing when disconnected
- Multi-question answering with per-question selection and "Other" freetext
- Multi-select checkbox UI for questions that allow multiple answers

## Dashboard
- Multi-server overview with connection status
- Session cards showing current activity and task progress
- Expandable task list per session with status indicators
- Task detail screen with full metadata and dependencies
- Kill sessions directly from dashboard with confirmation
- Create new sessions with recent project picker
- Quick navigation to any session
- Server enable/disable toggles
- Server cards disabled when no active sessions

## Conversation Viewer
- Markdown rendering with syntax highlighting
- Expandable tool cards with inputs/outputs
- Smart tool card collapsing with tool name chips and grouping
- Line numbers and language labels on Write/Edit views
- Expandable diff view with "Show all" toggle (40-line default)
- Graceful fallback rendering for unknown tool types
- Full-screen message viewer for long responses
- Activity counters (tokens, cache hits)
- Inline auto-approve toggle in session header

## Push Notifications
- FCM-based notifications when the CLI needs input
- Quiet hours scheduling
- Per-server notification preferences
- Instant vs batched notification modes

## Tmux Session Management
- Create/list/switch tmux sessions from app
- Git worktree support: branch sessions for concurrent editing on the same repo
- Worktree cleanup on session kill
- Directory browser for project selection
- Session recreation for missing sessions
- Auto-detect the CLI in tmux
- Session scoping: only monitors sessions created/adopted by the app (env var tagging)

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
- SSH command display with tap-to-copy (mobile) and click-to-copy (web)
- Scroll-position-aware auto-scroll: pauses when reading, resumes at bottom
- Auto-refresh polling with pause/resume toggle
- Horizontal scroll for long lines
- Font size zoom controls (mobile)
- Pull-to-refresh (mobile) and manual refresh button (web)
- Accessible from session header

## Auto-Approve System
- Automatic approval of safe tool calls (Read, Glob, Grep, etc.)
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

## Daemon CLI
- `companion status` — show running state, PID, tmux sessions, config summary
- `companion stop` — graceful shutdown via PID file
- `companion config` — view/set config values
- `companion logs` — platform-aware log viewing (macOS launchd / Linux journalctl)
- `companion install` — install as system service

## Developer Tools
- Sentry error tracking integration
- Error boundary with user feedback and bug reporting
- Centralized tool configuration (daemon/src/tool-config.ts)
- Structured parser warnings for unknown tools and entry types
- Build date and version info in settings
- Scroll behavior analytics
- Client error reporting
