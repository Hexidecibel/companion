# Companion

A companion app for your AI coding CLI. Monitor and interact with coding sessions from your phone, browser, or desktop.

## Platforms

- **Android** - React Native / Expo (APK available in Releases)
- **Web** - React + Vite SPA, served by the daemon at `http://<host>:9877/web`
- **macOS Desktop** - Native Tauri v2 app with system tray, notifications, menu bar (.dmg in Releases)

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
- Persistent file tab bar (web) with per-session state
- APK download and install support on Android

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
- Expo push notifications when the CLI needs input
- Escalation model with configurable delays and rate limits
- Quiet hours scheduling
- Per-session mute synced between clients

### Auto-Approve
- Automatic approval of safe tool calls (Read, Glob, Grep, etc.)
- Configurable per-session

### macOS Desktop
- System tray with click-to-toggle and session count badge
- Close-to-tray behavior
- Native Notification Center integration
- Window state persistence
- Auto-launch on login
- Custom menu bar with keyboard shortcuts

### Web Keyboard Shortcuts
- `Cmd/Ctrl+T` Toggle terminal
- `Cmd/Ctrl+F` Search messages
- `Cmd/Ctrl+1-9` Switch sessions
- `Cmd/Ctrl+Shift+A` Toggle auto-approve
- `Cmd/Ctrl+Shift+M` Toggle session mute

## Architecture

```
┌─────────────────┐                    ┌─────────────────┐
│  Mobile App     │◄──  WebSocket  ───►│     Daemon      │
│  (React Native) │                    │    (Node.js)    │
└─────────────────┘                    └──┬──────────┬───┘
                                          │          │
┌─────────────────┐                       │   ┌──────▼──────┐
│  Web Client     │◄──  WebSocket  ───────┘   │  Coding CLI │
│  (React + Vite) │                           │  (in tmux)  │
└─────────────────┘                           └─────────────┘

┌─────────────────┐
│  macOS Desktop  │  Tauri v2 wrapper around the web client
│  (.app / .dmg)  │
└─────────────────┘
```

## Quick Start

### 1. Install the Daemon

```bash
git clone https://github.com/Hexidecibel/companion.git
cd companion/daemon
npm install && npm run build
bash scripts/install.sh
```

The installer will:
- Detect your OS and install dependencies (Node.js, tmux)
- Build and install the daemon
- Generate a secure authentication token
- Set up auto-start (systemd on Linux, launchd on macOS)

**Save the token shown at the end - you'll need it for the app.**

### 2. Connect

1. Open the web client at `http://<your-server>:9877/web`
2. Or download the Android APK / macOS .dmg from [Releases](https://github.com/Hexidecibel/companion/releases)
3. Add your server's IP and authentication token
4. Create a new tmux session or adopt an existing one

## Configuration

Config file location:
- **macOS**: `~/.companion/config.json`
- **Linux (with sudo)**: `/etc/companion/config.json`
- **Linux (without sudo)**: `~/.companion/config.json`

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

### macOS (launchd)

```bash
tail -f ~/Library/Logs/companion.log       # View logs
launchctl kickstart -k gui/$(id -u)/com.companion.daemon  # Restart
launchctl unload ~/Library/LaunchAgents/com.companion.daemon.plist  # Stop
launchctl load ~/Library/LaunchAgents/com.companion.daemon.plist    # Start
```

### Linux (systemd)

```bash
sudo journalctl -u companion -f    # View logs
sudo systemctl restart companion   # Restart
sudo systemctl stop companion      # Stop
sudo systemctl status companion    # Status
```

### CLI

```bash
companion status   # Show running state, PID, sessions
companion stop     # Graceful shutdown
companion config   # View/set config values
companion logs     # Platform-aware log viewer
```

## Uninstalling

```bash
cd companion/daemon
bash scripts/uninstall.sh
```

## Development

### Daemon

```bash
cd daemon
npm install
npm run build
npm test
```

### Mobile App

```bash
cd app
npm install
npx expo start
```

### Web Client

```bash
cd web
npm install
npm run dev       # Vite dev server
npm run build     # Production build to web/dist/
```

### macOS Desktop

```bash
cd desktop
npm install
npm run tauri dev    # Dev mode
npm run tauri build  # Build .dmg
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

## License

MIT
