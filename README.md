# Claude Companion

A mobile companion app for [Claude Code](https://claude.ai/claude-code). Monitor and interact with your Claude Code sessions from your phone.

## Features

- **Real-time monitoring** - Watch Claude Code work from anywhere
- **Mobile input** - Send text and images to Claude Code
- **Push notifications** - Get notified when Claude needs input
- **Multiple servers** - Connect to multiple machines
- **Session switching** - Switch between tmux sessions
- **Secure** - TLS encryption and token authentication

## Architecture

```
┌─────────────────┐     WebSocket     ┌─────────────────┐
│  Mobile App     │◄──────────────────►│     Daemon      │
│  (React Native) │                    │    (Node.js)    │
└─────────────────┘                    └────────┬────────┘
                                                │
                                       ┌────────▼────────┐
                                       │  Claude Code    │
                                       │   (in tmux)     │
                                       └─────────────────┘
```

## Quick Start

### 1. Install the Daemon

**Option A: npm (recommended)**

```bash
npm install -g @hexidecibel/claude-companion
```

**Option B: From source**

```bash
git clone https://github.com/Hexidecibel/claude-companion.git
cd claude-companion/daemon
npm install && npm run build
bash scripts/install.sh
```

The installer will:
- Detect your OS and install dependencies (Node.js, tmux)
- Build and install the daemon
- Generate a secure authentication token
- Set up auto-start (systemd on Linux, launchd on macOS)

**Save the token shown at the end - you'll need it for the app!**

### 2. Start Claude Code in tmux

```bash
tmux new -s claude
claude
```

### 3. Connect from the App

1. Download the Claude Companion app
2. Add a new server with your machine's IP address
3. Enter the token from the installer
4. Connect and start monitoring!

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
git clone https://github.com/Hexidecibel/claude-companion.git
cd claude-companion/daemon
npm install
npm run build

# Run installer
bash scripts/install.sh
```

## Configuration

Config file location:
- **macOS**: `~/.claude-companion/config.json`
- **Linux (with sudo)**: `/etc/claude-companion/config.json`
- **Linux (without sudo)**: `~/.claude-companion/config.json`

```json
{
  "port": 9877,
  "token": "your-secret-token",
  "tls": true,
  "tmux_session": "claude",
  "claude_home": "~/.claude",
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
| `claude_home` | "~/.claude" | Claude Code config directory |
| `mdns_enabled` | true | Enable Bonjour/mDNS discovery |
| `push_delay_ms` | 60000 | Delay before sending push notifications |

## Service Management

### macOS (launchd)

```bash
# View logs
tail -f ~/Library/Logs/claude-companion.log

# Restart
launchctl kickstart -k gui/$(id -u)/com.claude-companion.daemon

# Stop
launchctl unload ~/Library/LaunchAgents/com.claude-companion.daemon.plist

# Start
launchctl load ~/Library/LaunchAgents/com.claude-companion.daemon.plist
```

### Linux (systemd)

```bash
# System-wide install
sudo journalctl -u claude-companion -f    # View logs
sudo systemctl restart claude-companion   # Restart
sudo systemctl stop claude-companion      # Stop
sudo systemctl status claude-companion    # Status

# User-level install
journalctl --user -u claude-companion -f
systemctl --user restart claude-companion
systemctl --user stop claude-companion
systemctl --user status claude-companion
```

## Uninstalling

```bash
cd claude-companion/daemon
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
- Make sure Claude Code is running in the tmux session
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

## License

MIT

## Contributing

Contributions welcome! Please read the contributing guidelines first.
