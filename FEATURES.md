# Claude Companion Features

High-level features of the Claude Companion mobile app and daemon.

## Real-Time Monitoring
- Live WebSocket updates from Claude Code sessions
- Multi-server, multi-session support
- Session status indicators (waiting, working, idle)
- Sub-agent visibility and tracking

## Mobile Input
- Send text and images to Claude from your phone
- Quick reply chips and slash commands
- Message queuing when disconnected
- Multi-select question answering

## Dashboard
- Multi-server overview with connection status
- Session cards showing current activity
- Quick navigation to any session
- Server enable/disable toggles

## Conversation Viewer
- Markdown rendering with syntax highlighting
- Expandable tool cards with inputs/outputs
- Full-screen message viewer for long responses
- Diff view for file changes
- Activity counters (tokens, cache hits)

## Push Notifications
- FCM-based notifications when Claude needs input
- Quiet hours scheduling
- Per-server notification preferences
- Instant vs batched notification modes

## Tmux Session Management
- Create/list/switch tmux sessions from app
- Directory browser for project selection
- Session recreation for missing sessions
- Auto-detect Claude Code in tmux

## Project Scaffolding (New Project Wizard)
- Multiple stack templates (React, Node, Python, MUI)
- Git initialization option
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
- mDNS/Bonjour discovery
- TLS support for secure connections
- Token-based authentication

## Developer Tools
- Sentry error tracking integration
- Scroll behavior analytics
- Client error reporting
