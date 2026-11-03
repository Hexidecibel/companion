# Companion

A mobile companion for your AI coding CLI. Daemon runs on a Linux server, watches coding sessions, and exposes a WebSocket API. Web client + Tauri wrapper provides desktop, Android, and iOS apps from a single codebase.

Foreman rules: see global ~/.claude/CLAUDE.md.

## Project Structure

```
daemon/         # Node.js/TypeScript daemon (runs on server)
web/            # React + Vite + TypeScript client (shared by all platforms)
desktop/        # Tauri 2.0 wrapper (desktop + mobile native builds)
mcp/            # companion-remote MCP server
voice/          # herald-voice Python service (TTS/STT/wake word)
docs/           # detail docs (see Docs index below)
```

## Docs index (read the doc before touching that area)

| Doc | Read this when... |
|-----|-------------------|
| `docs/herald.md` | touching Herald: brain/providers, secrets, sandbox/probe instances, knowledge tools, session actions, babysitter, voice service, voice commands, triggers + tokens, multi-device speaking, "show me", volume/stop, audio layer (AEC/VAD/devices), diagnostics, production deploy of Herald |
| `docs/codex.md` | Codex CLI sessions, Codex vs Claude isolation, trust / start-up prompts, Codex probes |
| `docs/profiles.md` | account profiles (several Claude/Codex logins), one-tap login flow, profile probes |
| `docs/stuck-detection.md` | stuck-session detection (signals, pane captures, Herald stuck items) |
| `docs/code-review-2.md` | Code Review 2.0 operational rules (GitRunner, ledger, events, reverts); design plan is `docs/code-review-2-plan.md` |
| `docs/desktop-mobile.md` | Tauri desktop/Android/iOS: key files, build commands, native Herald shortcuts/passthrough, signing, auto-update, Android sideload updates, iOS TestFlight banner, APK signing |
| `docs/implementation-patterns.md` | adding a daemon endpoint, adding shared types, web hooks pattern |
| `docs/docker.md` | user-facing Docker guide (compose, pairing, volumes) |
| `docs/herald-real-device-checklist.md` | real-device voice testing |
| `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`, `docs/NOTIFICATIONS.md`, `docs/SESSION-CONTROLS.md`, `docs/orchestrator-design.md` | older architecture / dev / notification / session-control background |

## Daemon

**Install:** runs from this checkout (`daemon/dist`), not a system install.
**Config:** `~/.companion/config.json` (see Config below).
**Service:** systemd **user** unit `companion`: `systemctl --user status companion`, logs `journalctl --user -u companion -f` (or `bin/companion status|logs`). No `sudo`.

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
- `src/handlers/*.ts` - request handlers per area, registered in `handlers/index.ts`

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

### Config
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

Config path is resolved from `COMPANION_CONFIG` (preferred), falling back to `CONFIG_PATH` (legacy alias), then `~/.companion/config.json`.

**First run / setup mode:** with no config file the daemon writes one with `setup_complete: false` and serves the setup wizard (web app) until it is finished; an existing config without that key is never in setup mode. Secrets can live in `~/.companion/secrets.env` (0600; the wizard writes the Anthropic key there; the environment always wins). Setup code: `daemon/src/setup/` (protocol mirrored to `web/src/types/setup.ts`), web: `web/src/components/setup/`. End-to-end test of a true first run: `bin/e2e-setup-wizard [out-dir]` (needs `PLAYWRIGHT_CORE`; uses `bin/herald-sandbox --fresh` on port 9573 with a private tmux server). `remote_capabilities` may be set at the root of a legacy flat config, or per-listener in the `listeners: [...]` array form.

### Sandbox / probe / test safety (essentials; detail in docs/herald.md)

- **9887** = the user's Herald sandbox (`bin/herald-sandbox start`). The user talks to it; its conversation is live history. **Never probe it.**
- **9888** = throwaway PROBE instance for automated checks: `bin/herald-sandbox --instance probe start|stop|...`; `node daemon/scripts/herald-probe.js` targets it. Always stop it afterwards.
- Sandboxes must use their own HOME (the script does this) and run with `COMPANION_SANDBOX=1`: never write production state (`~/.companion/*`, `~/.claude/companion-session-mappings.json`, `companion-sessions-snapshot.json`), never send pushes or auto-approve.
- Disposable test Claude/Codex sessions go on a PRIVATE tmux server (`env -u TMUX -u TMUX_PANE TMUX_TMPDIR=<short private dir>` or `tmux -L <name>`), never the default one (they would show up in the user's real session list). Socket path must stay under 108 chars. Clean up afterwards.
- Never run `codex` by hand in a throwaway git repo (it writes trust into `~/.codex/config.toml`); see docs/codex.md.
- Secrets never go in config.json or git (`ANTHROPIC_API_KEY` comes from the daemon env; `bin/companion install-secrets`).
- Other ports: **9889** herald voice service (127.0.0.1 only), **9890** Tailscale serve HTTPS front for 9887. (Not yet in `/mnt/hexinas/apps/INFRASTRUCTURE.md`; add them there.)

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

Detail: `docs/desktop-mobile.md`. Quick commands: `cd desktop && npm run dev` / `npm run build`; Android via the `/apk` skill; iOS via `/ios` (macOS/CI). Never `build:desktop` into `web/dist` (two bundles, different vite bases).

## Docker

`Dockerfile` (daemon + web, no Claude Code), `docker-compose.yml` (+ `docker-compose.host.yml` for mDNS; profiles `voice`, `tailscale`), `docker/` (entrypoint, PUID/PGID remap, setup-claude, root-exec wrappers), `voice/Dockerfile`. Ops through `bin/docker` (up, down, logs, pair-code, setup-claude, status, update, build, backup, restore); E2E with `bin/e2e-docker` (own compose project, throwaway volumes, never 9877/9878). The daemon detects the image via `COMPANION_CONTAINER=docker` (`daemon/src/container.ts`) and the wizard swaps in compose guidance. `GET /health` answers `{ok, version, setupComplete}` unauthenticated. CI: `.github/workflows/docker.yml` (build on PR/push; GHCR publish only via manual `workflow_dispatch` with `publish`). Guide: `docs/docker.md`.

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

Port 9877 (default); auth = token in the `authenticate` message. Core types: `authenticate`, `subscribe`, `get_highlights` / `get_full`, `send_input`, `send_image`, `register_push`. Feature protocols (`review`, `stuck`, `herald`, `profiles`, `setup`) live in `daemon/src/<area>/protocol.ts` and are mirrored byte for byte in `web/src/types/` (mirror tests): change both or neither, only add optional fields. Quick manual check: `wscat -c ws://localhost:9877`.

## Code Style

- **Colors:** Dark theme - `#111827` (bg), `#1f2937` (card), `#374151` (border), `#f3f4f6` (text), `#9ca3af` (secondary text)
- **Accent colors:** `#3b82f6` (blue), `#10b981` (green), `#f59e0b` (amber), `#ef4444` (red)
- **No emojis** in code unless user requests
- **Functional components** with hooks, no class components
- **localStorage** for persistence in web (with tauri-plugin-store write-through on mobile)
- **Console.log** for daemon logging (gets captured by journalctl)

## Testing Changes

1. **Daemon:** Run `npm run build && node dist/index.js` in `daemon/`
2. **Web:** Run `npm run dev` in `web/`, or `npm run build` for production
3. **Desktop:** Run `npm run dev` in `desktop/`
4. **Android:** `/apk` skill to build, sign, and install
5. **Type check:** `cd web && npx tsc --noEmit`
6. **Full test gate:** `bin/test` (also builds web)

### Building

- **No builds without explicit user approval**
- APK build: `/apk` skill
- iOS build: `/ios` skill (requires macOS)
- Desktop: `cd desktop && npm run build`

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
