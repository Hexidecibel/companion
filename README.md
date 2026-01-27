# Claude Companion

Monitor and respond to Claude Code sessions from your phone.

## Get Started

### 1. Install the App

**Android:** Download APK from [EAS Builds](https://expo.dev/accounts/xludax/projects/claude-companion/builds)

### 2. Install the Daemon

On your Linux server where you run Claude Code:

```bash
git clone https://github.com/ccushman/claude-companion.git
cd claude-companion/daemon
npm install && npm run build
sudo bash scripts/install.sh
```

The installer creates a config at `/etc/claude-companion/config.json` with a generated token.

### 3. Run Claude in tmux

```bash
tmux new -s claude
claude
```

### 4. Connect the App

Open the app, tap "Add Server", enter:
- **Host:** Your server IP
- **Token:** From `/etc/claude-companion/config.json`

Done! You'll see the conversation and can respond from your phone.

## Features

- Real-time session monitoring
- Push notifications when Claude waits for input
- Multi-server and multi-session support
- Quick reply chips and slash commands (`/yes`, `/no`)
- File viewer for tapped paths
- Image support

## Web Interface

A browser-based client is available in `web/`. Open `web/index.html` in a browser or serve the files from your daemon server.

## Documentation

- [Technical Details](docs/TECHNICAL.md) - Configuration, TLS, Firebase, architecture
- [TASKS.md](TASKS.md) - Roadmap and task tracking
- [CLAUDE.md](CLAUDE.md) - Development patterns

## Quick Reference

```bash
# Daemon logs
sudo journalctl -u claude-companion -f

# Restart daemon
sudo systemctl restart claude-companion

# Check status
sudo systemctl status claude-companion
```

## License

MIT
