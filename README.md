# Claude Companion

A mobile app + server daemon that keeps you connected to Claude Code sessions across multiple servers, with push notifications and a clean mobile interface.

## Overview

Claude Companion consists of two components:

1. **Daemon** (`daemon/`) - A Node.js service that runs on your Linux server, watches Claude Code sessions, and serves data over WebSocket
2. **Mobile App** (`app/`) - A React Native app for iOS/Android that connects to your daemons and lets you monitor and respond to Claude

## Quick Start

1. **Get the app:** Download APK from [EAS Builds](https://expo.dev/accounts/xludax/projects/claude-companion/builds)
2. **Install daemon:** See [Daemon Installation](#daemon-installation-linuxubuntu) below
3. **Connect:** Add your server in the app using the token from installation

## Features

- **Real-time session monitoring** - See Claude's prompts and responses as they happen
- **Mobile input** - Respond to Claude directly from your phone
- **Push notifications** - Get alerted when Claude is waiting for input
- **Multi-session support** - Switch between multiple tmux sessions on the same server
- **Slash commands** - Quick actions like `/yes`, `/no`, `/cancel`, `/switch`
- **Quick reply chips** - One-tap responses when Claude is waiting
- **File viewer** - Tap file paths to view content in full-screen
- **Session activity alerts** - Get notified when other sessions need attention
- **Multi-server support** - Connect to Claude Code sessions on multiple machines
- **Image support** - Send screenshots and images to Claude
- **Auto-reconnection** - Handles network changes gracefully (great for VPN/Wireguard)
- **mDNS discovery** - Automatically find daemons on your local network

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Your Server (Linux/Ubuntu)                                 │
│  ┌─────────────────┐    ┌─────────────────────────────────┐ │
│  │ Claude Code     │    │ claude-companion-daemon         │ │
│  │ (in tmux)       │◄──►│ - Watches ~/.claude/ logs       │ │
│  │                 │    │ - WebSocket server (port 9877)  │ │
│  └─────────────────┘    │ - Detects "waiting for input"   │ │
│                         └─────────────┬───────────────────┘ │
└───────────────────────────────────────┼─────────────────────┘
                                        │ WebSocket
                    ┌───────────────────▼───────────────────┐
                    │  Claude Companion Mobile App          │
                    │  - Server list & switching            │
                    │  - Highlights / Full details views    │
                    │  - Text input for responses           │
                    │  - Push notification handling         │
                    └───────────────────────────────────────┘
```

## Daemon Installation (Linux/Ubuntu)

### Quick Install

```bash
cd daemon
npm install
npm run build
sudo bash scripts/install.sh
```

The installer will:
- Set up the daemon in `/opt/claude-companion`
- Create a config file at `/etc/claude-companion/config.json`
- Generate a random authentication token
- Create and start a systemd service

### Configuration

Edit `/etc/claude-companion/config.json`:

```json
{
  "port": 9877,
  "token": "your-secret-token",
  "tls": false,
  "tmux_session": "claude",
  "claude_home": "/home/user/.claude",
  "mdns_enabled": true,
  "push_delay_ms": 60000
}
```

**Important settings:**
- `token` - Authentication token (share this with the mobile app)
- `tmux_session` - Name of the tmux session running Claude Code
- `claude_home` - Path to your `.claude` directory
- `tls` - Enable for secure internet access (requires certs)

### TLS Setup (Optional)

For secure access over the internet:

```bash
# Generate self-signed cert
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/claude-companion/key.pem \
  -out /etc/claude-companion/cert.pem

# Update config
sudo nano /etc/claude-companion/config.json
# Set: "tls": true, "cert_path": "/etc/claude-companion/cert.pem", "key_path": "/etc/claude-companion/key.pem"

# Restart
sudo systemctl restart claude-companion
```

### Management Commands

```bash
# View logs
sudo journalctl -u claude-companion -f

# Restart service
sudo systemctl restart claude-companion

# Check status
sudo systemctl status claude-companion

# Stop service
sudo systemctl stop claude-companion
```

## Mobile App Setup

### Download Pre-built APK (Android)

Download the latest APK directly:

**Latest Build:** https://expo.dev/accounts/xludax/projects/claude-companion/builds

Or scan this QR code from the Expo build page to install on your Android device.

### Development

```bash
cd app
npm install
npx expo start
```

Scan the QR code with Expo Go on your phone, or run on a simulator.

### Building for Production

```bash
# Install EAS CLI
npm install -g eas-cli

# Build for Android (APK for direct install)
eas build --platform android --profile preview

# Build for iOS
eas build --platform ios
```

### App Configuration

1. Open the app
2. Tap "Add Server"
3. Enter:
   - **Name**: A friendly name for this server
   - **Host**: Server IP or hostname (e.g., `192.168.1.100`)
   - **Port**: `9877` (default)
   - **Token**: The token from daemon installation
   - **Use TLS**: Enable if you configured TLS on the daemon
4. Tap "Save"

The app will connect automatically when you tap on the server.

## Usage

### Running Claude Code with the Daemon

1. Start a tmux session named `claude` (or whatever you configured):
   ```bash
   tmux new -s claude
   ```

2. Run Claude Code in the session:
   ```bash
   claude
   ```

3. The daemon will automatically detect the session and make it available to the mobile app.

### Responding from Mobile

1. Open the app and connect to your server
2. You'll see the conversation with Claude
3. When Claude asks a question, type your response and tap "Send"
4. The daemon will inject your response into the tmux session

### Push Notifications

When Claude finishes a task and is waiting for input:
1. The daemon waits 60 seconds
2. If you haven't responded, it sends a push notification
3. Tap the notification to open the app and respond

## Network Considerations

### VPN / Wireguard

The app handles network changes gracefully:
- Automatic reconnection with exponential backoff
- Up to 10 reconnection attempts before giving up
- Manual "Retry" button when connection fails
- Connection state indicators (green/orange/red)

### Firewall

Make sure port 9877 (or your configured port) is accessible:

```bash
# Ubuntu/Debian
sudo ufw allow 9877/tcp

# If using Wireguard, the port should already be accessible through the tunnel
```

## Troubleshooting

### Daemon won't start
- Check logs: `sudo journalctl -u claude-companion -e`
- Verify config: `cat /etc/claude-companion/config.json`
- Ensure Claude home directory exists

### Can't connect from app
- Verify network connectivity (can you ping the server?)
- Check if daemon is running: `sudo systemctl status claude-companion`
- Verify firewall settings
- Try the raw WebSocket: `wscat -c ws://server:9877`

### Input not reaching Claude
- Verify the tmux session name matches the config
- Check if tmux session exists: `tmux list-sessions`
- Ensure daemon has permission to send keys to tmux

### Push notifications not working
- Push requires Firebase configuration (see Push Setup section)
- Only works on physical devices, not simulators
- Check device notification permissions

## Push Notification Setup (Optional)

For push notifications, you need a Firebase project:

1. Create a project at https://console.firebase.google.com
2. Add an Android app with package name `com.claudecompanion.app`
3. Download the service account JSON
4. Place it at `/etc/claude-companion/fcm-credentials.json`
5. Update config: `"fcm_credentials_path": "/etc/claude-companion/fcm-credentials.json"`
6. Restart the daemon

## Development

### Daemon

```bash
cd daemon
npm install
npm run dev  # Run with ts-node for development
npm run build  # Compile TypeScript
```

### App

```bash
cd app
npm install
npx expo start  # Start Expo development server
```

## License

MIT
