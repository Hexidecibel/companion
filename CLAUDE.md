# Companion

A mobile companion for your AI coding CLI. Daemon runs on a Linux server, watches coding sessions, and exposes a WebSocket API. React Native app connects to monitor and respond from your phone.

## Project Structure

```
daemon/         # Node.js/TypeScript daemon (runs on server)
app/            # React Native/Expo mobile app
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

1. User runs the CLI in tmux: `tmux new -s claude && claude`
2. Daemon watches `~/.claude/projects/*.jsonl` for changes
3. Parses conversations, detects when the CLI is waiting for input
4. Broadcasts updates via WebSocket to connected apps
5. App can send text/images back, daemon injects via tmux

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

### Adding a New Screen (App)

1. Create screen file in `app/src/screens/`:
```typescript
import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
} from 'react-native';

interface MyScreenProps {
  onBack: () => void;
  // other props
}

export function MyScreen({ onBack }: MyScreenProps) {
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Load data
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My Screen</Text>
        <View style={styles.placeholder} />
      </View>
      <ScrollView style={styles.content}>
        {/* Content */}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111827' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: '#1f2937',
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  backButton: { paddingHorizontal: 4, paddingVertical: 4, minWidth: 60 },
  backButtonText: { color: '#3b82f6', fontSize: 17 },
  headerTitle: { color: '#f3f4f6', fontSize: 17, fontWeight: '600' },
  placeholder: { minWidth: 60 },
  content: { flex: 1 },
});
```

2. Add navigation in `App.tsx`:
```typescript
const [screen, setScreen] = useState<'dashboard' | 'myscreen'>('dashboard');
// Then render conditionally
```

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

3. Call from app via `wsService.sendRequest('my_endpoint', { data })`.

### Adding Types

- **App types:** `app/src/types/index.ts`
- **Daemon types:** `daemon/src/types.ts`
- Keep types in sync between app and daemon for shared interfaces

### Code Style

- **Colors:** Dark theme - `#111827` (bg), `#1f2937` (card), `#374151` (border), `#f3f4f6` (text), `#9ca3af` (secondary text)
- **Accent colors:** `#3b82f6` (blue), `#10b981` (green), `#f59e0b` (amber), `#ef4444` (red)
- **No emojis** in code unless user requests
- **Functional components** with hooks, no class components
- **AsyncStorage** for persistence in app
- **Console.log** for daemon logging (gets captured by journalctl)

### Services Pattern (App)

Services in `app/src/services/` are singletons:
```typescript
class MyService {
  private data: Map<string, Value> = new Map();

  async load(): Promise<void> { /* from AsyncStorage */ }
  async save(): Promise<void> { /* to AsyncStorage */ }

  getData(key: string): Value | undefined {
    return this.data.get(key);
  }
}

export const myService = new MyService();
```

### Hooks Pattern (App)

Hooks in `app/src/hooks/`:
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

1. **App:** Run `npx expo start` in `app/`, test on device/emulator
2. **Daemon:** Run `npm run build && node dist/index.js` in `daemon/`
3. **Type check:** `npx tsc --noEmit` in either directory

### Building

- **No EAS builds without explicit user approval**
- Local testing: `npx expo start`
- APK build: `/apk` skill or `eas build --platform android --profile preview`

---

## Task Workflow

See `TASKS.md` for current work queue. When working autonomously:

1. Read the task from TASKS.md work queue
2. Explore relevant existing code first
3. Implement incrementally, testing each step
4. Commit with descriptive message when complete
5. Update TASKS.md to mark completed
