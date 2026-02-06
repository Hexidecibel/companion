# Companion

A mobile companion for your AI coding CLI. Daemon runs on a Linux server, watches coding sessions, and exposes a WebSocket API. Web client + Tauri wrapper provides desktop, Android, and iOS apps from a single codebase.

## Project Structure

```
daemon/         # Node.js/TypeScript daemon (runs on server)
web/            # React + Vite + TypeScript client (shared by all platforms)
desktop/        # Tauri 2.0 wrapper (desktop + mobile native builds)
```

## Daemon

**Install location:** `/opt/companion`
**Config:** `/etc/companion/config.json`
**Service:** `companion` (systemd)

### Key files
- `src/index.ts` - Entry point, initializes all services
- `src/watcher.ts` - Watches `~/.claude/projects/` for JSONL conversation files
- `src/parser.ts` - Parses JSONL, detects "waiting for input" state
- `src/input-injector.ts` - Sends responses via `tmux send-keys`
- `src/websocket.ts` - WebSocket server, auth, message routing
- `src/push.ts` - Firebase push notifications (optional)
- `src/escalation.ts` - 2-tier notification escalation (browser -> push)
- `src/mdns.ts` - Bonjour/mDNS discovery

### Commands
```bash
# Build
cd daemon && npm install && npm run build

# Install as service
sudo bash scripts/install.sh

# Manage
sudo systemctl start companion
sudo systemctl stop companion
sudo systemctl restart companion
sudo journalctl -u companion -f   # View logs
```

### Config options
```json
{
  "port": 9877,
  "token": "your-secret-token",
  "tls": false,
  "tmux_session": "claude",
  "code_home": "/home/user/.claude",
  "mdns_enabled": true
}
```

## Web Client

React + Vite + TypeScript SPA. Connects to multiple daemons simultaneously via WebSocket. Serves as the UI for all platforms (browser, desktop, Android, iOS).

### Key files
- `src/App.tsx` - Screen routing (status | servers | editServer)
- `src/services/ServerConnection.ts` - Single server WS connection
- `src/services/ConnectionManager.ts` - Multi-server orchestrator
- `src/services/storage.ts` - localStorage CRUD for servers
- `src/services/push.ts` - FCM push notification registration
- `src/context/ConnectionContext.tsx` - React context wrapping ConnectionManager
- `src/components/Dashboard.tsx` - Main dashboard (responsive: sidebar on desktop, card list on mobile)
- `src/components/MobileDashboard.tsx` - Mobile-optimized server/session list
- `src/components/SessionView.tsx` - Conversation view with bottom toolbar on mobile
- `src/utils/platform.ts` - Platform detection (browser, Tauri desktop, Tauri mobile)

### Commands
```bash
cd web && npm install
npm run dev             # Vite dev server (proxies WS to localhost:9877)
npm run build           # Production build to web/dist/
npm run typecheck       # Type check only
```

### Serving
The daemon serves `web/dist/` at `http://<host>:9877/web`. After building, restart the daemon or it will pick up the dist directory on next start. During development, use `npm run dev` and access via the Vite dev server directly.

## Desktop / Mobile (Tauri)

Tauri 2.0 wraps the web client as a native app for desktop (Linux, macOS, Windows) and mobile (Android, iOS).

### Key files
- `desktop/src-tauri/tauri.conf.json` - Tauri configuration
- `desktop/src-tauri/src/lib.rs` - Rust entry point, plugin registration
- `desktop/src-tauri/plugins/tauri-plugin-fcm/` - Custom FCM/APNs plugin
- `desktop/scripts/setup-android.sh` - Android project patches (FCM, cleartext, back nav)
- `desktop/google-services.json` - Firebase config (gitignored, place manually)
- `desktop/debug.keystore` - APK signing key (gitignored)

### Commands
```bash
# Desktop
cd desktop && npm run dev       # Dev with hot reload
cd desktop && npm run build     # Release build (.deb, .dmg, etc.)

# Android
cd desktop && cargo tauri android init          # One-time setup
cd desktop && bash scripts/setup-android.sh     # Patch for FCM
cd desktop && cargo tauri android build --target aarch64  # Build APK

# iOS (requires macOS + Xcode)
cd desktop && cargo tauri ios init              # One-time setup
cd desktop && cargo tauri ios build             # Build for device
cd desktop && cargo tauri ios build --export-method app-store-connect  # TestFlight
```

### APK Signing
```bash
apksigner sign --ks desktop/debug.keystore --ks-pass pass:android --key-pass pass:android \
  --out /tmp/companion-tauri.apk \
  desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
```

## Architecture

1. User runs the CLI in tmux: `tmux new -s claude && claude`
2. Daemon watches `~/.claude/projects/*.jsonl` for changes
3. Parses conversations, detects when the CLI is waiting for input
4. Broadcasts updates via WebSocket to connected apps
5. App can send text/images back, daemon injects via tmux
6. Escalation: browser notification (immediate) -> push notification (after configurable delay)

## WebSocket Protocol

**Port:** 9877 (default)
**Auth:** Token in `authenticate` message

Message types:
- `authenticate` - Login with token
- `subscribe` - Start receiving updates
- `get_highlights` / `get_full` - Fetch conversation
- `send_input` - Send text to the CLI
- `send_image` - Send image (base64)
- `register_push` - Register FCM token for push notifications

## Troubleshooting

```bash
# Check if daemon is running
sudo systemctl status companion

# View logs
sudo journalctl -u companion -f

# Check config
cat /etc/companion/config.json

# Test WebSocket manually
wscat -c ws://localhost:9877
```

---

## Implementation Patterns

### Adding a Daemon Endpoint

1. Add message handler in `daemon/src/websocket.ts` switch statement:
```typescript
case 'my_endpoint':
  const result = await this.handleMyEndpoint(message.payload);
  this.sendResponse(ws, message.type, result, message.requestId);
  break;
```

2. Add handler method:
```typescript
private async handleMyEndpoint(payload: unknown): Promise<{ success: boolean; payload?: unknown; error?: string }> {
  try {
    // Implementation
    return { success: true, payload: { data: 'result' } };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
```

3. Call from web client via `connectionManager.sendRequest(serverId, 'my_endpoint', { data })`.

### Adding Types

- **Web types:** `web/src/types/index.ts`
- **Daemon types:** `daemon/src/types.ts`
- Keep types in sync between web and daemon for shared interfaces

### Code Style

- **Colors:** Dark theme - `#111827` (bg), `#1f2937` (card), `#374151` (border), `#f3f4f6` (text), `#9ca3af` (secondary text)
- **Accent colors:** `#3b82f6` (blue), `#10b981` (green), `#f59e0b` (amber), `#ef4444` (red)
- **No emojis** in code unless user requests
- **Functional components** with hooks, no class components
- **localStorage** for persistence in web (with tauri-plugin-store write-through on mobile)
- **Console.log** for daemon logging (gets captured by journalctl)

### Hooks Pattern

Hooks in `web/src/hooks/`:
```typescript
export function useMyHook(param: string) {
  const [state, setState] = useState<MyType | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Setup, subscriptions
    return () => { /* cleanup */ };
  }, [param]);

  const doAction = useCallback(async () => {
    // Action logic
  }, [param]);

  return { state, loading, doAction };
}
```

### Testing Changes

1. **Daemon:** Run `npm run build && node dist/index.js` in `daemon/`
2. **Web:** Run `npm run dev` in `web/`, or `npm run build` for production
3. **Desktop:** Run `npm run dev` in `desktop/`
4. **Android:** `/apk` skill to build, sign, and install
5. **Type check:** `cd web && npx tsc --noEmit`

### Building

- **No builds without explicit user approval**
- APK build: `/apk` skill
- iOS build: `/ios` skill (requires macOS)
- Desktop: `cd desktop && npm run build`

---

## Task Workflow

See `TASKS.md` for current work queue. When working autonomously:

1. Read the task from TASKS.md work queue
2. Explore relevant existing code first
3. Implement incrementally, testing each step
4. Commit with descriptive message when complete
5. Update TASKS.md to mark completed
