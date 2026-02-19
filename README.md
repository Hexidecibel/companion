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
bin/companion start               # Start daemon (background)
bin/companion start -f            # Start in foreground (debugging)
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

## Documentation

| Doc | Description |
|-----|-------------|
| [Features](FEATURES.md) | Full feature catalog |
| [Session Controls](docs/SESSION-CONTROLS.md) | Conversation viewer, file viewer, terminal, keyboard shortcuts |
| [Notifications](docs/NOTIFICATIONS.md) | Push notifications, escalation, quiet hours |
| [Architecture](docs/ARCHITECTURE.md) | System design, WebSocket protocol, parser internals |
| [Development](docs/DEVELOPMENT.md) | Building, testing, project structure, troubleshooting |
| [Changelog](CHANGELOG.md) | Release history |

## Privacy

See [PRIVACY.md](PRIVACY.md). Companion is fully self-hosted — no telemetry, no analytics, no third-party data sharing.

## License

MIT
