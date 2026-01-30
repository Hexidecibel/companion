# Companion

A mobile companion app for your AI coding CLI. Monitor and interact with your coding sessions from your phone.

## Features

- **Real-time monitoring** - Watch the CLI work from anywhere
- **Mobile input** - Send text and images to the CLI
- **Push notifications** - Get notified when the CLI needs input
- **Multiple servers** - Connect to multiple machines
- **Session switching** - Switch between tmux sessions
- **Secure** - TLS encryption and token authentication

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
```

## Quick Start

### 1. Install the Daemon

**Option A: npm (recommended)**

```bash
npm install -g @hexidecibel/companion
```

**Option B: From source**

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

**Save the token shown at the end - you'll need it for the app!**

### 2. Connect from the App

1. Download the Companion app
2. Add a new server with your machine's IP address
3. Enter the token from the installer
4. Connect and create a new project or session!

## Manual Installation

If the quick install doesn't work:

```bash
# Install prerequisites
# macOS:
brew install node tmux

# Ubuntu/Debian:
sudo apt install nodejs npm tmux

# Fedora/RHEL:
sudo dnf install nodejs tmux

# Clone and build
git clone https://github.com/Hexidecibel/companion.git
cd companion/daemon
npm install
npm run build

# Run installer
bash scripts/install.sh
```

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

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `port` | 9877 | WebSocket server port |
| `token` | (generated) | Authentication token |
| `tls` | true | Enable TLS encryption |
| `tmux_session` | "claude" | Default tmux session name |
| `code_home` | "~/.claude" | CLI config directory (also accepts `claude_home` for backward compatibility) |
| `mdns_enabled` | true | Enable Bonjour/mDNS discovery |
| `push_delay_ms` | 60000 | Delay before sending push notifications |

## Service Management

### macOS (launchd)

```bash
# View logs
tail -f ~/Library/Logs/companion.log

# Restart
launchctl kickstart -k gui/$(id -u)/com.companion.daemon

# Stop
launchctl unload ~/Library/LaunchAgents/com.companion.daemon.plist

# Start
launchctl load ~/Library/LaunchAgents/com.companion.daemon.plist
```

### Linux (systemd)

```bash
# System-wide install
sudo journalctl -u companion -f    # View logs
sudo systemctl restart companion   # Restart
sudo systemctl stop companion      # Stop
sudo systemctl status companion    # Status

# User-level install
journalctl --user -u companion -f
systemctl --user restart companion
systemctl --user stop companion
systemctl --user status companion
```

## Uninstalling

```bash
cd companion/daemon
bash scripts/uninstall.sh
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
- Make sure the CLI is running in the tmux session
- Check the session name in your config matches

### Daemon won't start
- Check logs for errors
- Verify Node.js is installed: `node --version`
- Ensure port 9877 isn't in use: `lsof -i :9877`

## Development

### Daemon

```bash
cd daemon
npm install
npm run build
npm run dev  # Watch mode
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

The daemon serves `web/dist/` at `http://<host>:9877/web` after building.

## License

MIT

## Contributing

Contributions welcome! Please read the contributing guidelines first.
