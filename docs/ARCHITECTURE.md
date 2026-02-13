# Architecture

System design, JSONL parsing, WebSocket protocol, and connection management.

## System Diagram

```
┌─────────────────┐
│  Mobile App     │◄──┐
│  (Tauri Android │   │
│   / iOS)        │   │                  ┌─────────────────┐
└─────────────────┘   │                  │     Daemon      │
                      ├── WebSocket ────►│    (Node.js)    │
┌─────────────────┐   │                  └──┬──────────┬───┘
│  Web Client     │◄──┤                     │          │
│  (React + Vite) │   │                     │   ┌──────▼──────┐
└─────────────────┘   │                     │   │  Coding CLI │
                      │                     │   │  (in tmux)  │
┌─────────────────┐   │                     │   └─────────────┘
│  Desktop App    │◄──┘                     │
│  (Tauri macOS / │                         │
│   Linux / Win)  │    Tauri wraps the      │
└─────────────────┘    web client for all   │
                       native platforms     │
```

## Components

### Daemon (`daemon/`)

Node.js/TypeScript service that runs on your server. Responsibilities:

- **Watcher** (`src/watcher.ts`): monitors `~/.claude/projects/` for JSONL conversation files using filesystem events
- **Parser** (`src/parser.ts`): reads JSONL files, extracts messages, detects session state (waiting, working, idle)
- **Input Injector** (`src/input-injector.ts`): sends user responses to the CLI via `tmux send-keys`
- **WebSocket Server** (`src/websocket.ts`): authenticates clients, routes messages, broadcasts updates
- **Push Service** (`src/push.ts`): sends FCM push notifications
- **Escalation** (`src/escalation.ts`): manages 2-tier notification escalation (browser -> push after delay)
- **mDNS** (`src/mdns.ts`): Bonjour/mDNS discovery for local network

### Web Client (`web/`)

React + Vite + TypeScript SPA. Serves as the UI for all platforms — browser, desktop, Android, and iOS. Key services:

- **ServerConnection** (`src/services/ServerConnection.ts`): manages a single WebSocket connection to one daemon
- **ConnectionManager** (`src/services/ConnectionManager.ts`): orchestrates connections to multiple daemons simultaneously
- **Storage** (`src/services/storage.ts`): localStorage CRUD for server configs (with Tauri plugin-store write-through on mobile)
- **Push** (`src/services/push.ts`): FCM push notification registration

### Tauri Wrapper (`desktop/`)

Tauri 2.0 wraps the web client as native apps for desktop (macOS, Linux, Windows) and mobile (Android, iOS). Includes:

- Custom FCM plugin (`src-tauri/plugins/tauri-plugin-fcm/`) for native push on Android/iOS
- System tray integration (desktop)
- Native OS notifications
- Window state persistence

## JSONL Parser

The daemon watches `~/.claude/projects/` for `.jsonl` conversation files. Each file contains one JSON object per line representing a conversation message.

### Session Detection

The parser extracts session state by analyzing conversation entries:

- **Waiting for input**: detected when the last message is from the assistant and contains no pending tool execution, or when `ExitPlanMode` / `AskUserQuestion` tool calls are pending
- **Working**: tool calls in progress, or assistant is generating
- **Idle**: conversation exists but no recent activity

### Session Disambiguation

Multiple CLI sessions can run in the same project directory, producing separate JSONL files. The daemon disambiguates them using:

1. **Terminal content matching**: compares recent conversation output against tmux pane content
2. **PID detection**: maps JSONL files to specific tmux panes by process ID
3. **Process of elimination**: narrows candidates when other methods are inconclusive

Session mappings persist across daemon restarts at `~/.claude/companion-session-mappings.json`.

### Conversation Chaining

When the CLI compacts context, it creates a new JSONL file. The parser chains these files by creation time to provide cross-session infinite scroll.

### Sub-Agent Tracking

When the CLI spawns Task agents, the parser builds a tree of parent-child relationships from `Task` tool calls. Each agent node tracks status, duration, and message count.

## WebSocket Protocol

Default port: **9877**

All messages are JSON with a `type` field. Client-to-server messages may include a `requestId` for request/response correlation.

### Authentication

```
Client: { "type": "authenticate", "token": "your-token" }
Server: { "type": "auth_success", "config": { ... } }
```

### Core Message Types

| Type | Direction | Description |
|------|-----------|-------------|
| `authenticate` | Client -> Server | Login with token |
| `subscribe` | Client -> Server | Start receiving updates for a session |
| `unsubscribe` | Client -> Server | Stop receiving updates |
| `get_highlights` | Client -> Server | Fetch conversation highlights |
| `get_full` | Client -> Server | Fetch full conversation |
| `get_status` | Client -> Server | Get session status |
| `get_server_summary` | Client -> Server | Lightweight summary of all sessions |
| `get_sessions` | Client -> Server | List active sessions |
| `send_input` | Client -> Server | Send text to the CLI |
| `send_image` | Client -> Server | Send image (base64) |
| `send_with_images` | Client -> Server | Send text + images together |
| `cancel_input` | Client -> Server | Cancel pending input |
| `ping` | Client -> Server | Keepalive |

### Session Management

| Type | Direction | Description |
|------|-----------|-------------|
| `list_tmux_sessions` | Client -> Server | List all tmux sessions |
| `create_tmux_session` | Client -> Server | Create a new tmux session |
| `kill_tmux_session` | Client -> Server | Kill a tmux session |
| `switch_tmux_session` | Client -> Server | Switch active session |
| `recreate_tmux_session` | Client -> Server | Recreate a missing session |
| `create_worktree_session` | Client -> Server | Create session with git worktree |
| `list_worktrees` | Client -> Server | List git worktrees |
| `rename_session` | Client -> Server | Set friendly name for a session |

### Terminal

| Type | Direction | Description |
|------|-----------|-------------|
| `get_terminal_output` | Client -> Server | Fetch raw tmux output |
| `send_terminal_text` | Client -> Server | Type text into tmux |
| `send_terminal_keys` | Client -> Server | Send special keys (arrows, ctrl combos) |

### Notifications & Escalation

| Type | Direction | Description |
|------|-----------|-------------|
| `register_push` | Client -> Server | Register FCM token |
| `unregister_push` | Client -> Server | Unregister FCM token |
| `get_escalation_config` | Client -> Server | Get escalation settings |
| `update_escalation_config` | Client -> Server | Update escalation settings |
| `get_pending_events` | Client -> Server | Get pending notification events |
| `get_devices` | Client -> Server | List registered push devices |
| `remove_device` | Client -> Server | Remove a push device |
| `set_session_muted` | Client -> Server | Mute/unmute a session |
| `get_muted_sessions` | Client -> Server | List muted sessions |
| `get_notification_history` | Client -> Server | Fetch notification history |
| `get_digest` | Client -> Server | Get away digest |
| `send_test_notification` | Client -> Server | Send a test push |

### Tools & Approval

| Type | Direction | Description |
|------|-----------|-------------|
| `set_auto_approve` | Client -> Server | Enable/disable auto-approve for a session |
| `get_tool_config` | Client -> Server | Get tool configuration |

### Files & Code Review

| Type | Direction | Description |
|------|-----------|-------------|
| `read_file` | Client -> Server | Read a file from the server |
| `search_files` | Client -> Server | Fuzzy file search |
| `check_files_exist` | Client -> Server | Check if files exist |
| `download_file` | Client -> Server | Download a file (APK install, etc.) |
| `open_in_editor` | Client -> Server | Open file in server-side editor |
| `get_session_diff` | Client -> Server | Get git diff for code review |
| `browse_directories` | Client -> Server | Browse server directories |

### Usage & Analytics

| Type | Direction | Description |
|------|-----------|-------------|
| `get_usage` | Client -> Server | Get session token usage |
| `get_api_usage` | Client -> Server | Get API usage stats |
| `get_cost_dashboard` | Client -> Server | Get cost analytics |
| `get_oauth_usage` | Client -> Server | Get OAuth utilization data |
| `get_tasks` | Client -> Server | Get session task list |
| `get_agent_tree` | Client -> Server | Get sub-agent tree |
| `get_agent_detail` | Client -> Server | Get sub-agent conversation |

### Parallel Work Groups

| Type | Direction | Description |
|------|-----------|-------------|
| `spawn_work_group` | Client -> Server | Start parallel work group |
| `get_work_groups` | Client -> Server | List work groups |
| `get_work_group` | Client -> Server | Get work group detail |
| `merge_work_group` | Client -> Server | Octopus merge completed workers |
| `cancel_work_group` | Client -> Server | Cancel a work group |
| `retry_worker` | Client -> Server | Retry a failed worker |
| `send_worker_input` | Client -> Server | Answer a worker question |
| `dismiss_work_group` | Client -> Server | Dismiss a completed group |

### Project Scaffolding & Skills

| Type | Direction | Description |
|------|-----------|-------------|
| `get_scaffold_templates` | Client -> Server | List project templates |
| `scaffold_preview` | Client -> Server | Preview scaffold output |
| `scaffold_create` | Client -> Server | Create new project from template |
| `list_skills` | Client -> Server | List available skills |
| `install_skill` | Client -> Server | Install a skill |
| `uninstall_skill` | Client -> Server | Remove a skill |
| `get_skill_content` | Client -> Server | Read skill file content |

### Server Broadcasts

| Type | Direction | Description |
|------|-----------|-------------|
| `conversation_update` | Server -> Client | Real-time conversation update |
| `sessions` | Server -> Client | Session list update |
| `terminal_update` | Server -> Client | Terminal output update |
| `work_group_update` | Server -> Client | Work group state change |

## Connection Resilience

The web client handles network instability:

- **Dead socket detection**: periodic `readyState` checks catch silently dropped connections (e.g., WiFi roaming)
- **Automatic reconnection**: exponential backoff with configurable max attempts
- **Session state recovery**: re-subscribes to active sessions after reconnect
- **Double-connect guard**: prevents orphaned sockets when reconnection races with existing connections

## Multi-Server Management

The `ConnectionManager` maintains simultaneous WebSocket connections to multiple daemons. Each server has its own `ServerConnection` instance with independent auth, reconnection, and subscription state. The React `ConnectionContext` exposes a unified API for components to interact with any server.

## Authentication

Token-based authentication. On connect, the client sends an `authenticate` message with the server token. The daemon validates and responds with `auth_success` (including server config and capabilities like `gitEnabled`) or closes the connection.

Token rotation is supported via the `rotate_token` message.
