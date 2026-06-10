# NEXT_TIME — Global Concierge rollout

Continuation doc for finishing the **Global Concierge** feature. The code is
fully implemented and committed; this doc covers **deploying it to running
daemons and verifying it end-to-end across machines**. A fresh session working
only on this feature can pick up from here.

Approved plan: `/home/hexi/.claude/plans/purrfect-leaping-frost.md` (read for the
full design rationale).

---

## 1. Status

**Done (implemented + committed, all builds green):**
- Feature implemented across `daemon/`, `mcp/`, `web/`, and `concierge/`.
- Builds pass:
  - `cd daemon && npm run build`
  - `cd mcp && npm run build`
  - `cd web && npx tsc --noEmit`
- Committed on `main`.

**NOT done:**
- **Not deployed** to any running daemon (the live daemon is still running the
  pre-concierge build).
- **Not E2E-verified** — no cross-machine spawn/fan-out/aggregate run has been
  done yet. The "C" button has not been exercised against a real second daemon.

---

## 2. What the feature is

A per-server **"C" (concierge) button** in the Companion app spawns or attaches a
long-running concierge Claude session **hosted on that daemon's host**. You talk
to it once to build shared context; it then fans your request out to real,
resumable project sessions on **any connected daemon** via the `companion-remote`
MCP, waits for each to finish, and relays **one consolidated, per-project
attributed summary** (wait-and-aggregate). It answers status questions
mid-flight without blocking.

It also lands the **flaky-cross-machine-MCP fixes** that previously made
cross-machine routing unreliable:
- **Auto-derived `~/.companion/mcp-servers.json`** — the app pushes its known
  servers to the daemon (`concierge_sync_mcp`), which writes the MCP registry
  (`0o600`, always including a `local` loopback entry, preserving manual entries
  by name). No more hand-editing.
- **`remote_list_sessions`** — a cross-machine session resolver MCP tool that
  proxies each daemon's `get_sessions`; with `cwd` it returns `resolved` = the
  newest matching live sessionId (the cross-machine `bin/companion-sessions`).
- **Reliable dispatch handle** — `remote_dispatch` no longer races a 5s timeout
  to `null`; the resolve window is raised/clamped and a `resolveSessionByTmuxName`
  fallback plus the always-returned `tmuxSessionName` give a durable handle.

---

## 3. Deploy to THIS (local) daemon

The local daemon runs as a **systemd user service** whose `ExecStart` points
straight at the repo build output — it is **dev-from-repo**, not the
`/opt/companion` install:

```
~/.config/systemd/user/companion.service
  WorkingDirectory=/home/hexi/local/src/companion/daemon
  ExecStart=/usr/bin/node /home/hexi/local/src/companion/daemon/dist/index.js
```

So rebuilding the repo + restarting the service is all that's needed locally.

### Ordered steps

```bash
# from repo root: /home/hexi/local/src/companion

# 1. Rebuild the daemon (compiles to daemon/dist/index.js — what systemd runs)
cd daemon && npm run build && cd ..

# 2. Rebuild the WEB bundle the daemon serves.
#    GOTCHA — two web bundles, different vite bases:
#      npm run build         -> base /web/ -> web/dist        (daemon-served UI)  <-- THIS ONE
#      npm run build:desktop -> base /     -> web/dist-desktop (APK/desktop)
#    For the daemon UI you want plain `npm run build`.
cd web && npm run build && cd ..

# 3. Rebuild the MCP server. The concierge's rendered .mcp.json points at
#    <repoRoot>/mcp/dist/index.js, so this MUST be built or the spawned
#    concierge has no companion-remote tools.
cd mcp && npm run build && cd ..

# 4. Restart the running daemon (systemd user service — dev-from-repo)
systemctl --user restart companion
systemctl --user status companion --no-pager | head -5
```

After restart, reload the web UI — the **"C" button should appear** in each
server's action row (sidebar on desktop, mobile dashboard action row on mobile).

### If a daemon instead runs from the installed location

The project's documented install path is `/opt/companion` (systemd unit
`companion`), managed by `bin/companion`. The local box is NOT using that today,
but a freshly-set-up host might. For an installed daemon, prefer the
**scripts-first** path rather than raw systemctl:

```bash
# bin/companion auto-rebuilds daemon + web on restart (it runs build_web), then
# delegates to the node CLI. Use it instead of poking systemd directly.
bin/companion restart      # rebuilds web, restarts
bin/companion status
bin/companion logs
```

Note `bin/companion restart` rebuilds **web** but you must still build **mcp**
manually (`cd mcp && npm run build`) — the CLI doesn't know about the MCP package.

---

## 4. Updating OTHER daemons (cross-machine)

**Key point the user flagged:** a remote daemon does **NOT** strictly need the
new build just to be a **fan-out target**.

The basic cross-machine primitives the concierge uses to fan work out —
`remote_dispatch`, `remote_send_input`, `remote_get_conversation`, and
`get_sessions` (which the new `remote_list_sessions` tool proxies) — all already
exist in the **existing** remote daemon code. The new `remote_list_sessions` MCP
tool runs on **your** (concierge-host) side and only calls the remote daemon's
**existing** `get_sessions`. So an un-updated remote daemon can be dispatched
into and resolved against just fine.

A remote daemon needs the **new daemon build** only to use the **new security
features hosted on it**:
- **Per-origin tokens** — `origins[]` config + the `concierge_register_origin`
  WS message (app-minted per-concierge credentials).
- **`get_cert_fingerprint`** — the WS endpoint that lets the app pin that
  daemon's TLS cert.

### Steps to update a remote daemon

```bash
# On the remote machine (or push the build to it):
# 1. Pull/copy the new repo build to that host (git pull, or rsync the repo).
# 2. Rebuild + restart its companion service:
bin/companion restart        # installed-daemon path (rebuilds web, restarts)
#   or, if it's a dev-from-repo systemd user service like this box:
#     cd daemon && npm run build && systemctl --user restart companion

# 3. Ensure the DISPATCH capability is on (REQUIRED for the concierge to
#    dispatch into this daemon). enable-remote REPLACES the whole
#    remote_capabilities block — specify the full desired state each call:
bin/companion enable-remote --dispatch
```

**Also:** every remote daemon must be **added in the Companion app** (Servers
screen). That's how it lands in the auto-derived `~/.companion/mcp-servers.json`
on the concierge host when the concierge is opened — the app pushes its server
list, the daemon writes the registry.

---

## 5. Per-machine checklist — make a daemon concierge-ready

For each daemon you want the concierge to reach:

- [ ] **(a) Reachable + added in the app** — daemon up, added on the Servers
      screen (so it's in the pushed bootstrap list → auto-derived
      `mcp-servers.json`).
- [ ] **(b) Dispatch capability enabled** — `bin/companion enable-remote --dispatch`
      on that host (required for the concierge to spawn/route into it).
- [ ] **(c) TLS cert pinning (optional)** — for `wss://` hosts, fetch the cert
      fingerprint via `get_cert_fingerprint` and store it on the Server record
      (`certFingerprint`); the MCP client then pins on connect.
- [ ] **(d) Per-origin isolation (optional)** — register a per-concierge origin
      token (`concierge_register_origin` adds to `origins[]`) so this concierge
      authenticates as its own narrowed origin rather than the shared listener
      token.

(c) and (d) require the **new daemon build** on that host; (a) and (b) work
against the existing build.

---

## 6. E2E verification

Need **two daemons** (this box + a second machine), each set up and with
`enable-remote --dispatch`. Run in order:

1. **Auto-bootstrap** — click **"C"** on this box. Confirm
   `~/.companion/mcp-servers.json` now exists/updated with a `local` entry **and**
   an entry for the second daemon (no hand-editing). Re-click → returns
   `created:false`, same session, no duplicate tmux session.
2. **Resolver** — start a session on daemon B; from the concierge,
   `remote_list_sessions({ server:'B', cwd:<projectCwd> })` `resolved` matches
   `bin/companion-sessions --cwd <projectCwd>` run on B.
3. **Dispatch handle** — `remote_dispatch({ server:'B', resolveTimeoutMs:20000 })`
   returns a non-null sessionId; the fast-prompt case still yields a usable
   handle via the tmux-name fallback.
4. **Fan-out + wait-and-aggregate** — in ConciergeView, ask it to act on a
   project on B (and optionally a local project too). Confirm via highlights it
   resolved → sent/dispatched → polled `isWaitingForInput` → relayed **one**
   attributed consolidated summary. Cross-check with `bin/companion-sessions --json`
   on B.
5. **Status-on-demand** — ask "status?" mid-flight → immediate, non-blocking
   per-target answer.
6. **Security** — per-origin token auth succeeds with the right `{origin,token}`
   and fails otherwise; per-origin capability narrowing denies a capability the
   origin doesn't have; cert pinning connects with the correct fingerprint and
   rejects (`CertPinMismatch`) when corrupted.

The **`/verify` skill** can drive this checklist once a second daemon is
reachable.

---

## 7. Open decisions / deferred items

**Picked defaults that can be revisited:**

1. **Per-origin auth is ADDITIVE, not strict.** When a listener has `origins[]`,
   a matching `{origin, token, !disabled}` authenticates with that origin's
   narrowed capabilities — but the **plain listener token still works** alongside
   it (backward compatible). To make it **strict** (reject the bare listener
   token once `origins[]` is configured), change the auth path in
   `daemon/src/websocket.ts` so that the presence of a non-empty `origins[]`
   disables the legacy listener-token fallback for that listener.
2. **Concierge-dir discovery order** (in `daemon/src/handlers/concierge.ts`,
   `resolveConciergeDir`): `config.concierge_dir` → walk up from `__dirname`
   looking for `<dir>/concierge/.mcp.json.template` → hardcoded fallback
   `/home/hexi/local/src/companion/concierge`. If you package/install the daemon
   somewhere the walk-up can't reach the repo, set `concierge_dir` in the daemon
   config explicitly.

**Deferred enhancements (not built):**
- **`wait_for_waiting` daemon push** — replace the concierge's polling loop with
  a daemon-side push when a target returns to `isWaitingForInput`. Removes the
  poll cadence/cap heuristics.
- **Token rotation** for per-origin tokens — currently mint-and-store; no
  rotation/expiry flow.

---

## 8. File map

**Daemon**
- `daemon/src/handlers/concierge.ts` (new) — `concierge_sync_mcp`,
  `concierge_open`, `concierge_register_origin`, `get_cert_fingerprint`;
  concierge-dir + MCP-entry resolution; spawn/attach + mcp-servers.json sync.
- `daemon/src/handlers/remote.ts` + `daemon/src/watcher.ts` — reliable dispatch
  (`resolveTimeoutMs` clamp, raised default, `resolveSessionByTmuxName` fallback).
- `daemon/src/websocket.ts` — per-origin auth (`origins[]` match + capability
  intersection, additive with legacy path).
- `daemon/src/cert-generator.ts` — `getCertFingerprint()` (sha256 of DER).
- `daemon/src/types.ts` — `origins?: OriginCredential[]` on
  `RemoteCapabilitiesConfig`.
- `daemon/src/config.ts` — `concierge_dir` config plumbing.
- `daemon/src/handler-context.ts`, `daemon/src/handlers/index.ts` — context +
  handler registration.

**MCP**
- `mcp/src/tools/remote_list_sessions.ts` (new) — cross-machine session resolver.
- `mcp/src/daemon-client.ts` — TLS cert pinning (`certFingerprint` →
  `fingerprint256` compare → `CertPinMismatch`).
- `mcp/src/config.ts` — `certFingerprint?` on `ServerConfig`.
- `mcp/src/errors.ts` — `CertPinMismatch`.
- `mcp/src/index.ts` — register `remote_list_sessions`.
- `mcp/src/tools/remote_dispatch.ts` — thread `resolveTimeoutMs`.

**Web**
- `web/src/components/ConciergeView.tsx` (new) — concierge session UI.
- `web/src/components/SessionSidebar.tsx`, `MobileDashboard.tsx` — "C" button.
- `web/src/components/Dashboard.tsx`, `web/src/App.tsx` — concierge screen +
  routing.
- `web/src/services/ConnectionManager.ts` — `getServersForMcpBootstrap()`.
- `web/src/types/index.ts` — `certFingerprint?` on `Server`.
- `web/src/utils/eventBus.ts` — concierge open event.

**Concierge**
- `concierge/CLAUDE.md` — cross-machine wait-and-aggregate routing rules.
- `concierge/projects.json` — per-project `server` (falls back to default).
- `concierge/.mcp.json.template` — `__MCP_DIST_INDEX__` placeholder rendered to
  `<repoRoot>/mcp/dist/index.js` (rendered `.mcp.json` is gitignored).
</content>
</invoke>
