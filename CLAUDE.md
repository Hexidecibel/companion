# Claude Companion

A mobile companion for Claude Code. Daemon runs on a Linux server, watches Claude Code sessions, and exposes a WebSocket API. React Native app connects to monitor and respond from your phone.

## Project Structure

```
daemon/         # Node.js/TypeScript daemon (runs on server)
app/            # React Native/Expo mobile app
```

## Daemon

**Install location:** `/opt/claude-companion`
**Config:** `/etc/claude-companion/config.json`
**Service:** `claude-companion` (systemd)

### Key files
- `src/index.ts` - Entry point, initializes all services
- `src/watcher.ts` - Watches `~/.claude/projects/` for JSONL conversation files
- `src/parser.ts` - Parses JSONL, detects "waiting for input" state
- `src/input-injector.ts` - Sends responses via `tmux send-keys`
- `src/websocket.ts` - WebSocket server, auth, message routing
- `src/push.ts` - Firebase push notifications (optional)
- `src/mdns.ts` - Bonjour/mDNS discovery

### Commands
```bash
# Build
cd daemon && npm install && npm run build

# Install as service
sudo bash scripts/install.sh

# Manage
sudo systemctl start claude-companion
sudo systemctl stop claude-companion
sudo systemctl restart claude-companion
sudo journalctl -u claude-companion -f   # View logs
```

### Config options
```json
{
  "port": 9877,
  "token": "your-secret-token",
  "tls": false,
  "tmux_session": "claude",
  "claude_home": "/home/user/.claude",
  "mdns_enabled": true
}
```

## Mobile App

React Native + Expo app. Connects to daemon via WebSocket.

### Key files
- `src/services/websocket.ts` - WebSocket client, reconnection logic
- `src/services/storage.ts` - AsyncStorage for servers/settings
- `src/hooks/useConnection.ts` - Connection state management
- `src/screens/ServerList.tsx` - Server management UI
- `src/screens/SessionView.tsx` - Conversation view

### Commands
```bash
cd app && npm install
npx expo start          # Dev mode
eas build --platform ios    # Production build
```

## Architecture

1. User runs Claude Code in tmux: `tmux new -s claude && claude`
2. Daemon watches `~/.claude/projects/*.jsonl` for changes
3. Parses conversations, detects when Claude is waiting for input
4. Broadcasts updates via WebSocket to connected apps
5. App can send text/images back, daemon injects via tmux

## WebSocket Protocol

**Port:** 9877 (default)
**Auth:** Token in `authenticate` message

Message types:
- `authenticate` - Login with token
- `subscribe` - Start receiving updates
- `get_highlights` / `get_full` - Fetch conversation
- `send_input` - Send text to Claude
- `send_image` - Send image (base64)
- `register_push` - Register FCM token for push notifications

## Troubleshooting

```bash
# Check if daemon is running
sudo systemctl status claude-companion

# View logs
sudo journalctl -u claude-companion -f

# Check config
cat /etc/claude-companion/config.json

# Test WebSocket manually
wscat -c ws://localhost:9877
```
