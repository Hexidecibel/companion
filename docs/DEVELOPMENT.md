# Development

Building, testing, project structure, and management scripts.

## Project Structure

```
daemon/         # Node.js/TypeScript daemon (runs on server)
web/            # React + Vite + TypeScript client (all platforms)
desktop/        # Tauri 2.0 wrapper (desktop + Android + iOS)
bin/            # Management scripts (build, deploy, test, dev)
docs/           # Documentation
```

### Daemon (`daemon/`)

| Path | Purpose |
|------|---------|
| `src/index.ts` | Entry point, initializes all services |
| `src/watcher.ts` | Watches `~/.claude/projects/` for JSONL files |
| `src/parser.ts` | Parses JSONL, detects session state |
| `src/input-injector.ts` | Sends responses via `tmux send-keys` |
| `src/websocket.ts` | WebSocket server, auth, message routing |
| `src/push.ts` | Firebase push notifications |
| `src/escalation.ts` | 2-tier notification escalation |
| `src/mdns.ts` | Bonjour/mDNS discovery |
| `src/tool-config.ts` | Centralized tool configuration |

### Web Client (`web/`)

| Path | Purpose |
|------|---------|
| `src/App.tsx` | Screen routing |
| `src/components/Dashboard.tsx` | Main dashboard (responsive layout) |
| `src/components/MobileDashboard.tsx` | Mobile server/session list |
| `src/components/SessionView.tsx` | Conversation view + toolbar |
| `src/services/ServerConnection.ts` | Single server WebSocket connection |
| `src/services/ConnectionManager.ts` | Multi-server orchestrator |
| `src/services/storage.ts` | localStorage CRUD for servers |
| `src/services/push.ts` | FCM push registration |
| `src/context/ConnectionContext.tsx` | React context for connections |
| `src/utils/platform.ts` | Platform detection (browser, Tauri desktop, Tauri mobile) |
| `src/types/index.ts` | Shared TypeScript types |

### Tauri Wrapper (`desktop/`)

| Path | Purpose |
|------|---------|
| `src-tauri/tauri.conf.json` | Tauri configuration |
| `src-tauri/src/lib.rs` | Rust entry point, plugin registration |
| `src-tauri/plugins/tauri-plugin-fcm/` | Custom FCM/APNs plugin |
| `scripts/setup-android.sh` | Android project patches (FCM, cleartext, back nav) |

## Building

### Daemon

```bash
cd daemon
npm install
npm run build       # Compile TypeScript to dist/
npm test            # Run tests
```

### Web Client

```bash
cd web
npm install
npm run dev         # Vite dev server (proxies WS to localhost:9877)
npm run build       # Production build to web/dist/
npx tsc --noEmit    # Type check only
```

The daemon serves `web/dist/` at `http://<host>:9877/web`. After building, restart the daemon or it will pick up the dist directory on next start.

### Desktop App

```bash
cd desktop
npm install
npm run tauri dev    # Dev mode with hot reload
npm run tauri build  # Release build (.deb, .dmg, .msi, etc.)
```

### Android APK

```bash
cd desktop
cargo tauri android init                          # One-time setup
bash scripts/setup-android.sh                     # Patch for FCM + cleartext
cargo tauri android build --target aarch64        # Build APK
apksigner sign --ks debug.keystore \
  --ks-pass pass:android --key-pass pass:android \
  --out /tmp/companion.apk \
  src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
```

### iOS (requires macOS + Xcode)

```bash
cd desktop
cargo tauri ios init
cargo tauri ios build
cargo tauri ios build --export-method app-store-connect   # TestFlight
```

## Management Scripts

All scripts live in `bin/` and include usage headers and dependency checks.

| Script | Description |
|--------|-------------|
| `bin/companion` | Top-level CLI entry point (auto-builds on first run) |
| `bin/companion setup` | First-time wizard: creates config, generates token, prints connection info |
| `bin/companion start` | Start daemon (background) |
| `bin/companion start -f` | Start daemon in foreground (debugging) |
| `bin/companion stop` | Stop a running daemon |
| `bin/companion restart` | Restart via service manager |
| `bin/companion status` | Show running state, PID, sessions |
| `bin/companion logs` | Platform-aware log viewer |
| `bin/companion config` | View/set config values |
| `bin/companion autostart enable` | Install as system service (systemd / launchd) |
| `bin/companion autostart disable` | Remove system service |
| `bin/build` | Build daemon + web (alias for build-all) |
| `bin/build-all` | Build daemon + web |
| `bin/build-apk` | Full Android APK pipeline |
| `bin/deploy` | Build + restart daemon service |
| `bin/dev` | Start daemon + Vite dev server |
| `bin/test` | Run all tests, lint, typecheck |

## Testing

### Daemon

96 parser tests across 13 functions, plus integration tests:

```bash
cd daemon && npm test
```

### Web Client

Vitest + @testing-library/react + jsdom:

```bash
cd web && npx vitest
```

Includes ServerConnection tests (23) and ConnectionManager tests (14).

### Full Suite

```bash
bin/test    # Runs all tests, lint, and typecheck
```

## TLS Setup

For secure access over the internet:

```bash
# Generate self-signed cert
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout ~/.companion/key.pem \
  -out ~/.companion/cert.pem
```

Add to `~/.companion/config.json`:

```json
{
  "tls": true,
  "cert_path": "~/.companion/cert.pem",
  "key_path": "~/.companion/key.pem"
}
```

Restart the daemon after enabling TLS. Clients connect via `wss://` instead of `ws://`.

## Troubleshooting

### Connection timeout
- Check that the daemon is running: `bin/companion status`
- Verify the port isn't blocked by firewall: `sudo ufw allow 9877/tcp`
- Try connecting with TLS disabled first

### Invalid token
- Ensure the token in the app matches your config exactly
- Tokens are case-sensitive

### No messages showing
- Make sure the CLI is running in a tmux session created/adopted by Companion
- Sessions must be tagged with `COMPANION_APP=1` environment variable

### Daemon won't start
- Check logs: `bin/companion logs`
- Verify Node.js is installed: `node --version`
- Ensure port 9877 isn't in use: `lsof -i :9877`

### Push notifications not working
- Requires Firebase configuration (see [Notifications](NOTIFICATIONS.md))
- Only works on physical devices
- Check device notification permissions
- Check quiet hours / rate limit settings

### Windows
- The daemon requires tmux, which runs on Linux/macOS
- On Windows, install WSL 2 and run the daemon inside it
- Desktop/mobile apps connect to the daemon over the network
