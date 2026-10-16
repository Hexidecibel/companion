# @companion/mcp-remote

MCP server that exposes Companion daemons to Claude Code as tools. Phase 1 is
read-only: list configured daemons, read files, fetch conversations. Destructive
capabilities (exec, write, dispatch) arrive in later phases.

## Install

```bash
cd mcp
npm install
npm run build
```

## Configure

Create `~/.companion/mcp-servers.json`:

```json
{
  "version": 1,
  "servers": [
    {
      "name": "mac",
      "host": "100.64.0.3",
      "port": 9877,
      "token": "...",
      "useTls": true,
      "trustedNetwork": false
    }
  ]
}
```

- `useTls`: connect via `wss://` when true, otherwise `ws://`.
- `trustedNetwork`: opt-in to non-TLS on a non-loopback host (e.g. Tailscale).
  Without this, plaintext to a non-loopback target is refused.

`COMPANION_MCP_CONFIG` overrides the default config path.

## Register with Claude Code

```bash
claude mcp add companion-remote -- node /absolute/path/to/mcp/dist/index.js
```

## Tools

- `remote_list_servers()` — configured daemons with cached capabilities.
- `remote_read({ server, path })` — proxies to daemon `read_file`.
- `remote_get_conversation({ server, sessionId, mode? })` — proxies to
  `get_highlights` (default) or `get_full`.
- `remote_list_sessions({ server, cwd? })` — the daemon's live sessions; with
  `cwd`, `resolved` = the newest session in that project (or null).
- `remote_subagent_status({ server, session? })` — "where's it at?" for
  dispatched subagents, read-only (no `remote_capabilities` needed, same auth
  as `remote_list_sessions`). Proxies `subagent_rollup {facts: true}` and
  returns a deterministic `rollup` line ("3 of 5 done, 2 running. Bob is
  running tests (2 failing runs, 4 min).") plus `sessions[]`, each with its
  own rollup, running / total / failed counts and up to 8 agents (status,
  one-line description, elapsed / idle ms, activity, checklist step, tests,
  files touched, stuck headline, notification summary). Structured facts
  only, redacted daemon-side; no transcript text. `session` = a tmux session
  name or a conversation id; omit it for every session with running or
  recently finished (2 h) agents. Older daemons answer with the rollup line
  only (`sessions: []`), or an error asking for an update.

## Tests

```bash
npm test   # tsc + node --test dist/__tests__/*.test.js
```
