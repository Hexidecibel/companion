# Changelog

## v0.1.0 — Initial Public Release

The first release of Companion — a multi-platform app for monitoring and interacting with Claude Code sessions remotely.

### Platforms

- **Android** — React Native APK (sideload or Play Store)
- **iOS** — React Native via TestFlight / App Store
- **Web** — SPA served by the daemon at `http://<host>:9877/web`
- **macOS Desktop** — Native Tauri app (.dmg)
- **Windows / Linux** — Built via GitHub Actions on release tags

### Core Features

- **Real-Time Session Monitoring** — Watch Claude Code conversations update live via WebSocket
- **Multi-Server Support** — Connect to multiple daemons simultaneously
- **Send Input & Images** — Respond to prompts, send text, drag-and-drop images
- **Tool Approval** — Approve or deny pending tool calls from any device
- **Auto-Approve** — Configure safe tools (Read, Glob, Grep, etc.) to auto-approve per session
- **Ask User Questions** — Multi-select and multi-question support with option buttons

### Conversation & Navigation

- **Infinite Scroll** — Load older messages on demand
- **Search** — Full-text search across conversation messages (mobile and web)
- **Collapsible Tool Cards** — Grouped tool calls with expand/collapse, chip summaries
- **File & Artifact Viewer** — Tap file paths to view contents with syntax highlighting
- **Message Viewer** — Full-screen message view with markdown rendering
- **Plan Viewer** — Visual plan/todo progress tracking

### Session Management

- **Tmux Session Picker** — Switch between active coding sessions
- **Create New Sessions** — Start new Claude Code sessions with recent project history
- **Kill Sessions** — Stop sessions directly from dashboard
- **Git Worktree Support** — Branch sessions for parallel work on the same project
- **Session Muting** — Mute notifications per-session across all devices

### Terminal & Development

- **Interactive Terminal** — Full terminal emulator with ANSI color support (web and mobile)
- **Sub-Agent Tree** — Visual tree of spawned sub-agents with status tracking
- **Sub-Agent Detail View** — Drill into individual sub-agent activity

### Parallel Work Groups

- **Spawn Worker Sessions** — Launch parallel Claude Code workers from a plan
- **Work Group Dashboard** — Monitor all workers with live status
- **Auto-Merge** — Automatically merge completed worker branches

### Push Notifications

- **Firebase Cloud Messaging** — Push notifications when sessions need attention
- **Escalation System** — Configurable delays, rate limiting, quiet hours
- **Per-Event Control** — Toggle notifications for waiting, errors, completions, worker events
- **Device Management** — Register multiple devices per server

### Project Scaffolding

- **New Project Wizard** — Create projects from 7 templates (React, Next.js, Node/Express, Python/FastAPI, Go CLI, TypeScript Library, React MUI)
- **Template Scoring** — AI-powered template recommendations based on project description
- **CLAUDE.md Generation** — Auto-generated project instructions for Claude Code

### Desktop App (macOS)

- **Native Notifications** — macOS notification center integration
- **Window State Persistence** — Remembers window size and position
- **System Tray** — Tray icon with quick access menu
- **Auto-Launch** — Optional launch at login
- **Drag & Drop** — Drop files and images onto the input bar
- **Custom App Icon** — Companion branding in Dock and Finder

### Web Client

- **Keyboard Shortcuts** — Command palette, navigation shortcuts
- **Multi-Tab Sessions** — File tab bar for quick switching
- **Open in Editor** — Open files directly in your local editor
- **Terminal Viewer** — Embedded terminal with zoom controls

### Infrastructure

- **Daemon CLI** — `companion start|stop|status|config|logs` commands
- **QR Code Setup** — Scan to configure mobile app connection
- **TLS Support** — Optional encrypted WebSocket connections
- **mDNS Discovery** — Auto-discover daemons on local network
- **Sentry Integration** — Optional error tracking (only active with SENTRY_DSN)
- **CI/CD** — GitHub Actions for linting, testing, and cross-platform release builds
- **MIT License**

### API & Protocol

- **WebSocket API** — Full bidirectional communication protocol
- **REST Endpoints** — File browsing, usage stats, server info
- **Token Authentication** — Secure token-based auth for all connections
