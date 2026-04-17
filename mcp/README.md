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
