# Technical Documentation

Detailed technical information for Companion.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Your Server (Linux/Ubuntu)                                 │
│  ┌─────────────────┐    ┌─────────────────────────────────┐ │
│  │ Coding CLI      │    │ companion-daemon                │ │
│  │ (in tmux)       │◄──►│ - Watches ~/.claude/ logs       │ │
│  │                 │    │ - WebSocket server (port 9877)  │ │
│  └─────────────────┘    │ - Detects "waiting for input"   │ │
│                         └─────────────┬───────────────────┘ │
└───────────────────────────────────────┼─────────────────────┘
                                        │ WebSocket
                    ┌───────────────────▼───────────────────┐
                    │  Companion Mobile App                 │
                    │  - Server list & switching            │
                    │  - Conversation view                  │
                    │  - Text input for responses           │
                    │  - Push notification handling         │
                    └───────────────────────────────────────┘
```

## Components

1. **Daemon** (`daemon/`) - Node.js service that runs on your server
2. **Mobile App** (`app/`) - React Native/Expo app for iOS/Android
3. **Web Client** (`web/`) - Browser-based interface (vanilla JS)

## QR Code Setup

The daemon serves a QR code for easy mobile app configuration:

1. Open a browser to `http://your-server:9877`
2. A QR code is displayed containing your server configuration
3. In the mobile app, tap "Add Server" then "Scan QR Code"
4. Point the camera at the QR code to auto-fill all settings

**Endpoints:**
- `/` - HTML page with QR code
- `/qr` or `/qr.png` - QR code as PNG image
- `/qr.json` - Raw configuration as JSON

## Daemon Configuration

Config file: `/etc/companion/config.json`

```json
{
  "port": 9877,
  "token": "your-secret-token",
  "tls": false,
  "tmux_session": "claude",
  "code_home": "/home/user/.claude",
  "mdns_enabled": true,
  "push_delay_ms": 60000
}
```

### Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `port` | WebSocket server port | `9877` |
| `token` | Authentication token for clients | (generated) |
| `tls` | Enable TLS encryption | `false` |
| `tmux_session` | Name of tmux session running the CLI | `claude` |
| `code_home` | Path to `.claude` directory (also accepts `claude_home` for backward compatibility) | `~/.claude` |
| `mdns_enabled` | Broadcast service via mDNS/Bonjour | `true` |
| `push_delay_ms` | Delay before sending push notification | `60000` |

## TLS Setup

For secure access over the internet:

```bash
# Generate self-signed cert
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/companion/key.pem \
  -out /etc/companion/cert.pem

# Update config
sudo nano /etc/companion/config.json
```

Add to config:
```json
{
  "tls": true,
  "cert_path": "/etc/companion/cert.pem",
  "key_path": "/etc/companion/key.pem"
}
```

Restart: `sudo systemctl restart companion`

## Push Notifications (Firebase)

For push notifications when the CLI is waiting:

1. Create project at https://console.firebase.google.com
2. Add Android app with package `com.companion.app`
3. Download service account JSON
4. Place at `/etc/companion/fcm-credentials.json`
5. Add to config: `"fcm_credentials_path": "/etc/companion/fcm-credentials.json"`
6. Restart daemon

### Notification Preferences

The app supports per-server notification settings:
- Instant vs delayed notifications
- Quiet hours (e.g., 10pm - 8am)
- Rate limiting/throttling

## WebSocket Protocol

**Default port:** 9877

### Message Types

| Type | Direction | Description |
|------|-----------|-------------|
| `authenticate` | Client → Server | Login with token |
| `auth_success` | Server → Client | Authentication succeeded |
| `list_sessions` | Client → Server | Request active sessions |
| `sessions` | Server → Client | List of sessions |
| `subscribe` | Client → Server | Subscribe to session updates |
| `get_highlights` | Client → Server | Fetch conversation highlights |
| `get_full` | Client → Server | Fetch full conversation |
| `conversation` | Server → Client | Conversation data |
| `update` | Server → Client | Real-time update |
| `send_input` | Client → Server | Send text to the CLI |
| `send_image` | Client → Server | Send image (base64) |
| `register_push` | Client → Server | Register FCM token |

## Network Considerations

### VPN / Wireguard

The app handles network changes gracefully:
- Automatic reconnection with exponential backoff
- Up to 10 reconnection attempts
- Manual "Retry" button when connection fails
- Connection state indicators (green/orange/red)

### Firewall

Allow port 9877 (or configured port):

```bash
# Ubuntu/Debian
sudo ufw allow 9877/tcp
```

## Daemon Management

```bash
# View logs
sudo journalctl -u companion -f

# Restart service
sudo systemctl restart companion

# Check status
sudo systemctl status companion

# Stop service
sudo systemctl stop companion
```

## Development

### Daemon

```bash
cd daemon
npm install
npm run dev    # Development with ts-node
npm run build  # Compile TypeScript
```

### Mobile App

```bash
cd app
npm install
npx expo start
```

### Building APK

```bash
npm install -g eas-cli
eas build --platform android --profile preview
```

## Troubleshooting

### Daemon won't start
- Check logs: `sudo journalctl -u companion -e`
- Verify config: `cat /etc/companion/config.json`
- Ensure the CLI home directory exists

### Can't connect from app
- Verify network connectivity
- Check daemon status: `sudo systemctl status companion`
- Test WebSocket: `wscat -c ws://server:9877`
- Check firewall settings

### Input not reaching the CLI
- Verify tmux session name matches config
- Check if session exists: `tmux list-sessions`
- Ensure daemon can send to tmux

### Push notifications not working
- Requires Firebase configuration
- Only works on physical devices
- Check device notification permissions
- Check quiet hours / rate limit settings

## Environment Variables

**App (app/.env):**
```bash
SENTRY_DSN=your-sentry-dsn  # Optional error tracking
```

**CLI Skills (.claude/secrets.env):**
```bash
SENTRY_API_TOKEN=your-sentry-api-token
SENTRY_ORG=your-sentry-org
SENTRY_PROJECT=your-sentry-project
```
