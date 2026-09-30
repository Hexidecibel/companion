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

### Daemon Restart Safety

**NEVER restart or stop the companion daemon without explicit user sign-off in the current conversation.** This applies to `systemctl --user restart/stop companion` and `bin/companion restart/stop/start`. `KillMode=process` now protects spawned tmux sessions across a restart, but restarting still drops in-flight debugging state — notably pending-AUQ tmux-pane scrape state that is NOT persisted to disk. A PreToolUse hook (`.claude/hooks/guard-daemon-restart.sh`) enforces this and blocks the commands. Only override after the user approves, by including `COMPANION_ALLOW_RESTART=1` in the command. Daemon *builds* (`npm run build`) are not affected.

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
# First-time setup (auto-builds daemon + web, creates config)
bin/companion setup

# Start daemon (background by default)
bin/companion start

# Start in foreground (for debugging)
bin/companion start -f

# Manage
bin/companion stop
bin/companion restart
bin/companion status
bin/companion logs

# Configure remote_capabilities (exec / dispatch / write) interactively
bin/companion enable-remote
```

**Note:** Each non-interactive `enable-remote` invocation (flags like `--dispatch`, `--write-root`, `--allowed-origin`, etc.) **replaces** the entire `remote_capabilities` block — it does not merge with the existing config. Specify the complete desired state on every call. Interactive mode (no flags) uses existing values as defaults and lets you edit from there.

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

Config path is resolved from `COMPANION_CONFIG` (preferred), falling back to `CONFIG_PATH` (legacy alias), then `~/.companion/config.json`. `remote_capabilities` may be set at the root of a legacy flat config, or per-listener in the `listeners: [...]` array form.

### Herald (conversational front layer) and daemon secrets

Herald's brain runs in the daemon (`daemon/src/herald/`). Config block `herald: {enabled, display_name, provider: 'openai_compatible'|'anthropic', base_url, model, echo_delay_ms, timeout_ms, max_tokens, state_dir}`. State lives in `~/.companion/herald/state.json` (override: `herald.state_dir` or env `COMPANION_HERALD_STATE_DIR`). Secrets never go in config.json or git: the anthropic provider reads `ANTHROPIC_API_KEY` from the daemon's environment only.

```bash
# Materialize secrets from .cush-secrets (Infisical) into ~/.companion/herald.env (chmod 600,
# outside the repo) and install a systemd drop-in (companion.service.d/secrets.conf) with
# EnvironmentFile=-~/.companion/herald.env. Runs daemon-reload; never restarts the daemon.
bin/companion install-secrets                    # --no-unit: env file only; --refresh-on-start: also
                                                 # re-run inject in ExecStartPre (failures never block start)

# Point Herald at Haiku in the live config (idempotent; preserves everything else):
bin/companion herald-provider anthropic          # [--model NAME] [--config PATH]

# Isolated test daemon from THIS checkout: port 9887, own HOME/config/state, mDNS off,
# no remote capabilities, key injected into that process's env only. Reads real sessions.
# The user talks to this one: its conversation is live history. Never probe it.
bin/herald-sandbox start|stop|status|logs|env

# Throwaway PROBE instance for automated checks: port 9888 (HERALD_SANDBOX_PORT overrides),
# own HOME/config/state under ~/.cache/companion-herald-sandbox-probe, same isolation, and a
# fresh conversation on every start. herald-probe.js targets it by default.
bin/herald-sandbox --instance probe start|stop|status|logs|env
node daemon/scripts/herald-probe.js [--reset] "Anything for me?"   # measures TTFT/latency;
                                                 # auto-CANCELS any proposed action
bin/herald-sandbox --instance probe stop         # always stop it afterwards (verifies the port is free)
```

Both key and provider changes take effect only on the next daemon restart (needs explicit user sign-off). `bin/companion start` / `start -f` also source `~/.companion/herald.env` when it exists. The sandbox must use its own HOME: the daemon writes its PID file, audit log and push state under `$HOME/.companion`, so a second daemon sharing HOME would overwrite (and on exit delete) production's `daemon.pid`. It does still read the shared `code_home`; the script sets `COMPANION_SANDBOX=1` (implies `COMPANION_READONLY_SHARED_STATE=1`), so the sandbox never writes `~/.claude/companion-session-mappings.json` / `companion-sessions-snapshot.json`, never registers push devices or sends pushes, and never auto-approves tools. It reuses production's auth token (never printed). `HERALD_DEBUG_TOOLS=1` (on by default in the sandbox) logs tool calls and results, which include session text.

Herald also has read-only knowledge tools (`daemon/src/herald/knowledge/`): `search_infra` (`/mnt/hexinas/apps/INFRASTRUCTURE.md`), `cush_tools_help` (cush-tools docs + the cush-tools section of `~/.claude/CLAUDE.md`), `cush_status`, `search_project_notes` (CLAUDE/plan/todo/FEATURES/README of `~/local/src/*` projects with a CLAUDE.md or plan.md) and `search_memory` (`<code_home>/projects/*/memory/*.md`). All reads go through `knowledge/redact.ts` (path denylist + token redaction). `propose_cush_command` runs only `extend`/`close`/`serve`/`tunnel`/`drop` via execFile (tiers in `danger.ts` `classifyCushCommand`); everything else is refused in code. Paths derive from `code_home`; override with `HERALD_USER_HOME`, `HERALD_INFRA_DOC`, `HERALD_CUSH_TOOLS_DIR`, `HERALD_PROJECTS_ROOT`.


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
cd desktop && npm run android:build              # Build APK (auto-increments versionCode)

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

## Conversation Parser

The JSONL conversation parser has been extracted into a standalone package at `/home/hexi/local/src/claude-conversation-parser/`. The daemon still has its own copy in `daemon/src/parser.ts` (not yet wired to the package). When making parser changes, consider syncing to the standalone package.

## MCP Server (companion-remote)

Lives at `mcp/`. Exposes cross-daemon dispatch tools (`remote_list_servers`, `remote_read`, `remote_get_conversation`, `remote_dispatch`, `remote_send_input`, `remote_cancel`, `remote_exec`, `remote_write`) over stdio MCP. Consumed by any Claude Code session that registers it with `claude mcp add --scope user companion-remote -- node /home/hexi/local/src/companion/mcp/dist/index.js`.

Build: `cd mcp && npm install && npm run build`. Rebuild after changes — Claude Code re-invokes the stdio binary per session, so the next session picks up new output.

Full setup and tool reference: `mcp/README.md`. Daemon-side capability enablement (`remote_capabilities`) is covered in the Daemon config section above; flip caps per-host with `bin/companion enable-remote`.

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

## Foreman Mode (MANDATORY)

**You are a foreman. You do NOT do implementation work on the main thread. Ever.**

The main conversation thread is EXCLUSIVELY for: talking with the user, making decisions, giving status updates, and dispatching work. ALL implementation work — file reads, edits, writes, builds, tests, git operations, research — MUST be dispatched to subagents via the Task tool.

### Rules (non-negotiable)

1. **NEVER edit, write, or create files on the main thread.** Dispatch a `general-purpose` agent.
2. **NEVER run builds, tests, or git commands on the main thread.** Dispatch a `Bash` agent.
3. **NEVER do multi-file research on the main thread.** Dispatch an `Explore` agent.
4. **The ONLY tools the main thread should use are:** Task (to dispatch), AskUserQuestion (to clarify), and brief single-file Read/Grep when you need a quick answer to make a decision.
5. **Launch multiple agents in parallel** when tasks don't depend on each other.
6. **Give agents detailed, self-contained prompts** — they can't see our conversation. Include file paths, context, and exact instructions.
7. **Report back concisely** — when agents finish, summarize results to the user. Don't parrot full output.

### Why

The Companion app shows subagents in a real-time dispatch panel. The user can watch agents work while continuing to talk to you. This is the core UX of the app — you staying available while work happens in the background. If you do work on the main thread, the user is blocked waiting for you.

### Agent types for dispatch

- `general-purpose` — Full tool access. Use for: code changes, multi-step implementation, commit flows, anything requiring Read+Edit+Bash.
- `Bash` — Shell commands only. Use for: builds, tests, git operations, installs.
- `Explore` — Read-only codebase exploration. Use for: finding files, understanding architecture, researching patterns.
- `Plan` — Architecture planning. Use for: designing implementation approaches before coding.

### Skill flows (/commit, /apk, etc.)

When a skill is invoked, dispatch the ENTIRE skill flow to a `general-purpose` agent. Pass the full skill instructions as the agent's prompt. Do not execute skill steps on the main thread.

---

## Tracking Files

Four files track the lifecycle of work items:

| File | Purpose |
|------|---------|
| `todo.md` | Quick capture for ideas and tasks. Items are raw, unplanned. |
| `plan.md` | Detailed implementation plans with status, design, file lists, and steps. |
| `FEATURES.md` | Completed features — living changelog of what's been shipped. |
| `backlog.md` | Deferred ideas, long-term research, and items not in the daily workflow. |

**Flow:** `todo.md` (idea) -> `plan.md` (planned -> in-progress -> done) -> `FEATURES.md` (shipped)
**Deferred:** Items moved from `todo.md` to `backlog.md` when not prioritized.

When committing (`/commit`), update all three:
1. Remove completed items from `todo.md`
2. Set status to `done` in `plan.md` (clear done plans when all complete)
3. Add/update entries in `FEATURES.md`
