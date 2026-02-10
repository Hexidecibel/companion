# Companion

A companion app for your AI coding CLI. Monitor and interact with coding sessions from your phone, browser, or desktop.

## Platforms

- **Android** — Tauri 2.0 mobile (APK in Releases)
- **iOS** — Tauri 2.0 mobile (TestFlight / IPA in Releases)
- **Web** — React + Vite SPA, served by the daemon at `http://<host>:9877/web`
- **macOS** — Tauri 2.0 desktop (.dmg in Releases)
- **Linux** — Tauri 2.0 desktop (.deb / .AppImage in Releases)
- **Windows** — Tauri 2.0 desktop (.msi in Releases)

All native apps share a single web codebase — one React + Vite + TypeScript project wrapped by Tauri for each platform.

## Features

### Real-Time Monitoring
- Live WebSocket updates from CLI coding sessions
- Multi-server, multi-session support with session switching
- Status indicators (waiting, working, idle)
- Sub-agent tracking with expandable tree view

### Conversation Viewer
- Markdown rendering (headings, tables, task lists, code blocks)
- Expandable tool cards with inputs/outputs and diff views
- Full-screen message viewer for long responses
- Text search with match highlighting and prev/next navigation
- Cross-session infinite scroll

### File & Artifact Viewer
- Tap any file path to open it in a built-in viewer
- Markdown, diff, and code rendering with line numbers
- Large outputs get "View full output" buttons
- Persistent file tab bar with per-session state

### Plan Viewer
- Detects plan files from ExitPlanMode/EnterPlanMode tool calls
- Inline plan cards with "View Plan" button
- Plan button in session header

### Interactive Terminal
- Raw tmux output with ANSI color rendering
- Send keystrokes directly to tmux (arrow keys, ctrl combos)
- Auto-scroll with scroll-position awareness
- SSH command display with tap-to-copy

### Parallel Work Groups
- Spawn multiple Claude Code sessions in parallel
- Each worker runs in its own git worktree on a dedicated branch
- Inline question answering for worker sessions
- Octopus merge of completed branches with conflict detection
- Dashboard cards with progress tracking and cancel/retry controls
- Push notifications for worker events

### Tmux Session Management
- Create, list, and switch sessions from the app
- Git worktree support for concurrent editing on the same repo
- Directory browser for project selection
- Session scoping via env var tagging

### Project Scaffolding
- Multiple stack templates (React, Node, Python, Go, Next.js, MUI)
- Auto-generated CLAUDE.md and slash commands per stack
- Git init and GitHub repo creation

### Push Notifications
- FCM push notifications when the CLI needs input
- 2-tier escalation: browser notifications immediately, push after configurable delay
- Consolidated batching of multiple pending events
- Quiet hours, per-session mute, rate limiting

### Auto-Approve
- Automatic approval of safe tool calls (Read, Glob, Grep, etc.)
- "Always Allow" option on pending approval prompts
- Configurable per-session

### Desktop App
- System tray with click-to-toggle and session count badge
- Close-to-tray behavior
- Native OS notifications
- Window state persistence and auto-launch on login
- Custom menu bar with keyboard shortcuts

### Mobile App
- Full-screen mobile dashboard with server/session cards
- Bottom action toolbar (terminal, auto-approve, mute, plan, history)
- Android back gesture navigation
- Safe area insets for edge-to-edge display
- FCM push via custom Tauri plugin

### Web Keyboard Shortcuts
- `Cmd/Ctrl+T` Toggle terminal
- `Cmd/Ctrl+F` Search messages
- `Cmd/Ctrl+1-9` Switch sessions
- `Cmd/Ctrl+Shift+A` Toggle auto-approve
- `Cmd/Ctrl+Shift+M` Toggle session mute

## Architecture

```
┌─────────────────┐
│  Mobile App     │◄──┐
│  (Tauri Android │   │
│   / iOS)        │   │                  ┌─────────────────┐
└─────────────────┘   │                  │     Daemon      │
                      ├── WebSocket ────►│    (Node.js)    │
┌─────────────────┐   │                  └──┬──────────┬───┘
│  Web Client     │◄──┤                     │          │
│  (React + Vite) │   │                     │   ┌──────▼──────┐
└─────────────────┘   │                     │   │  Coding CLI │
                      │                     │   │  (in tmux)  │
┌─────────────────┐   │                     │   └─────────────┘
│  Desktop App    │◄──┘                     │
│  (Tauri macOS / │                         │
│   Linux / Win)  │    Tauri wraps the      │
└─────────────────┘    web client for all   │
                       native platforms     │
```

## Quick Start

### 1. Setup

```bash
git clone https://github.com/Hexidecibel/companion.git
cd companion
bin/companion setup
```

This auto-builds the daemon on first run, creates a config at `~/.companion/config.json` with a generated token, and prints connection info.

### 2. Start

```bash
bin/companion start
```

Or install as a system service so it starts automatically:

```bash
bin/companion autostart enable
```

### 3. Connect

1. Open the web client at `http://<your-server>:9877/web`
2. Or download the Android APK / iOS IPA / desktop app from [Releases](https://github.com/Hexidecibel/companion/releases)
3. Add your server's IP and the authentication token shown during setup
4. Create a new tmux session or adopt an existing one

## Configuration

Config file: `~/.companion/config.json` (created by `bin/companion setup`)

```json
{
  "port": 9877,
  "token": "your-secret-token",
  "tls": true,
  "tmux_session": "claude",
  "code_home": "~/.claude",
  "mdns_enabled": true,
  "push_delay_ms": 60000
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `port` | 9877 | WebSocket server port |
| `token` | (generated) | Authentication token |
| `tls` | true | Enable TLS encryption |
| `tmux_session` | "claude" | Default tmux session name |
| `code_home` | "~/.claude" | CLI config directory |
| `mdns_enabled` | true | Enable Bonjour/mDNS discovery |
| `push_delay_ms` | 60000 | Delay before sending push notifications |

## Service Management

```bash
bin/companion autostart enable    # Install as system service (systemd / launchd)
bin/companion autostart disable   # Remove system service
bin/companion start               # Start in foreground
bin/companion stop                # Stop a running daemon
bin/companion restart             # Restart via service manager
bin/companion status              # Show running state, PID, sessions
bin/companion logs                # Platform-aware log viewer
bin/companion config              # View/set config values
```

## Uninstalling

```bash
bin/companion autostart disable   # Remove system service
rm -rf ~/.companion               # Remove config
```

## Development

### Project Structure

```
daemon/         # Node.js/TypeScript daemon (runs on server)
web/            # React + Vite + TypeScript client (all platforms)
desktop/        # Tauri 2.0 wrapper (desktop + Android + iOS)
bin/            # Management scripts (build, deploy, test, dev)
```

### Daemon

```bash
cd daemon
npm install
npm run build
npm test
```

### Web Client

```bash
cd web
npm install
npm run dev       # Vite dev server
npm run build     # Production build to web/dist/
npx tsc --noEmit  # Type check
```

### Desktop App

```bash
cd desktop
npm install
npm run tauri dev    # Dev mode
npm run tauri build  # Build for current platform
```

### Android APK

```bash
cd desktop
bash scripts/setup-android.sh          # First-time Android setup
cargo tauri android build --target aarch64
# Sign: apksigner sign --ks debug.keystore --out /tmp/companion.apk <unsigned-apk>
```

### iOS (requires macOS + Xcode)

```bash
cd desktop
cargo tauri ios init
cargo tauri ios build --export-method app-store-connect
```

### Management Scripts

```bash
bin/companion    # Top-level CLI (auto-builds on first run)
bin/build        # Build daemon + web (alias for build-all)
bin/build-all    # Build daemon + web
bin/deploy       # Build + restart daemon service
bin/dev          # Start daemon + Vite dev server
bin/test         # Run all tests, lint, typecheck
bin/logs         # View daemon logs (platform-aware)
bin/status       # Show daemon status and info
bin/build-apk    # Full Android APK pipeline
```

## Troubleshooting

### Connection timeout
- Check that the daemon is running
- Verify the port isn't blocked by firewall
- Try connecting with TLS disabled first

### Invalid token
- Ensure the token in the app matches your config exactly
- Tokens are case-sensitive

### No messages showing
- Make sure the CLI is running in a tmux session created/adopted by Companion
- Sessions must be tagged with `COMPANION_APP=1` environment variable

### Daemon won't start
- Check logs for errors
- Verify Node.js is installed: `node --version`
- Ensure port 9877 isn't in use: `lsof -i :9877`

### Windows
- The daemon requires tmux, which runs on Linux/macOS
- On Windows, install WSL 2 and run the daemon inside it
- Desktop/mobile apps connect to the daemon over the network

## License

MIT
