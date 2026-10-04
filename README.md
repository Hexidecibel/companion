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

## Quick start (Docker)

The easiest way to run your own server. You need Docker with Compose v2 (Linux, or Docker Desktop on Mac/Windows).

```bash
git clone https://github.com/hexidecibel/companion.git && cd companion
cp .env.example .env        # set COMPANION_PROJECTS=/path/to/your/code (and PUID/PGID = id -u / id -g)
docker compose up -d        # pulls ghcr.io/hexidecibel/companion
```

Open `http://localhost:9877/web/`, choose **Pair with a code**, and type the code from `bin/docker pair-code` (or `docker compose logs companion`). The setup wizard does the rest. In the **Claude Code** step it can install Claude Code into the container for you. You can also run `docker compose run --rm companion setup-claude`. Then sign in once with `docker compose exec companion claude`, then `/login`.

Optional extras: Herald's local voice (`docker compose --profile voice up -d`), a private HTTPS address on your tailnet (`--profile tailscale`), and host networking so phones find the server under Nearby (Linux). All of it is in [docs/docker.md](docs/docker.md).

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
3. **Add server**: the apps list nearby servers (mDNS). Pick yours (or type its address) and either
   enter the 6-digit code the server shows (daemon log, `bin/companion pair`, or the app on a device
   you already signed in on) or approve the new device from that other device. For a remote setup,
   run `bin/companion pair --qr` (or Settings > Devices > Show pairing QR) and scan it: one device,
   single use, 10 minutes.
4. Create a new tmux session or adopt an existing one

Each device gets its own token; see and revoke them in Settings > Devices or with
`bin/companion devices list|revoke|rename`. The single `token` from the config file still works
(legacy, all-powerful): "Enter token manually" in Add server, and Settings > Devices offers
"Upgrade to a device token" for apps still using it.

## Configuration

Config file: `~/.companion/config.json` (created by `bin/companion setup`)

| Option | Default | Description |
|--------|---------|-------------|
| `port` | 9877 | WebSocket server port |
| `token` | (generated) | Legacy server token (prefer paired device tokens) |
| `name` | "Companion on <hostname>" | Display name (mDNS, pairing) |
| `pairing` | true | Allow new devices to pair (code, approval, QR) |
| `pairing_allow_public` | false | Allow code pairing from outside LAN / tailnet / localhost |
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
bin/companion pair [--qr]         # Approve / deny devices pairing, or print a pairing QR
bin/companion devices             # Paired devices: list | revoke | rename
```

## Uninstalling

```bash
bin/companion autostart disable   # Remove system service
rm -rf ~/.companion               # Remove config
```

## Documentation

| Doc | Description |
|-----|-------------|
| [Docker](docs/docker.md) | Run Companion with Docker Compose: first run, volumes, upgrades, backups, Tailscale, voice |
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
