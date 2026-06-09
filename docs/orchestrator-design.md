# Orchestrator / Concierge Design

> Goal: one Claude you can **talk to inside the Companion app** (it shows up as a
> normal session) that **routes your requests to the right project's always-on
> Claude session** and **relays results back**. Three projects live on the same
> box — `android`, `ios`, `web&server` — each with its own always-on Claude
> running in its own tmux session.

This document designs the two shapes the user floated, recommends one (the
concierge, which the user chose), explains the routing mechanism, and documents
the runnable POC shipped alongside it (`bin/concierge`, `bin/companion-sessions`,
`concierge/`).

---

## The two shapes

### Shape A — Parent dispatcher (one Claude fans out to 3 projects)

```
            you (app / CLI)
                  |
            parent Claude  ── dispatches NEW sessions per request ──┐
                  |                                                  |
   remote_dispatch(android)   remote_dispatch(ios)   remote_dispatch(web)
        (spawn)                  (spawn)                 (spawn)
```

- **How you interact:** you talk to the parent Claude. For each request it
  *spawns* a fresh Claude session in the target project (`remote_dispatch`),
  waits for it, reads the result, returns it to you.
- **Where routing lives:** in the parent Claude's reasoning + its MCP tool calls.
- **How it targets sessions:** it creates them on demand (`remote_dispatch`
  with `cwd` = the project root). Each request is a new, short-lived session.
- **Pros:** stateless and simple; no long-running per-project sessions to babysit;
  natural fan-out (`Promise.all`-style) to several projects at once; clean audit
  trail (one session per task).
- **Cons:** throws away per-project context between requests — the android
  session that "knows" your build quirks is gone after each task; cold-start cost
  every time; doesn't match the user's stated model of *always-on* per-project
  sessions; the parent's own context window accumulates every project's output.
- **Failure modes:** a spawned session that hangs leaves an orphan tmux session;
  `sessionId` may be `null` if the JSONL doesn't resolve within 5s (the
  `remote_dispatch` contract), so the parent can lose the handle to a live child.
- **Cost to build:** lowest — `remote_dispatch` + `remote_get_conversation`
  already exist. ~0 new code. But it's the wrong interaction model for this user.

### Shape B — Concierge per server (a resident router that proxies)  ★ chosen

```
   you (Companion app)  ── type a message ──▶ concierge Claude session
                                                  (tmux: "concierge", watched
                                                   by the daemon → visible in app)
                                                        |
                          reads your message, decides which project(s)
                                                        |
              ┌─────────────────────┬───────────────────────────────┐
              ▼                     ▼                                ▼
        send_input ──▶        send_input ──▶                  send_input ──▶
        android session       ios session                     web&server session
        (tmux "android",      (tmux "ios",                    (tmux "web",
         always-on claude)     always-on claude)               always-on claude)
              │                     │                                │
              └──── concierge polls get_conversation, relays ◀───────┘
                            results back to you in-app
```

- **How you interact:** you talk to the **concierge** — a normal Claude session
  that the daemon already watches, so it appears in the Companion app like any
  other session. No web/app changes needed.
- **Where routing lives:** in the concierge's `CLAUDE.md` (routing rules) +
  its tool calls. The concierge is a long-lived Claude, so it can carry
  cross-project context ("you asked about the android version earlier…").
- **How it targets sessions:** the **3 project sessions already exist and stay
  up**. The concierge resolves each project to its live `sessionId` and uses
  `remote_send_input` to inject your request into that exact session, then
  polls `remote_get_conversation` to read the reply.
- **Pros:** matches the user's model exactly (talk in-app, always-on sessions,
  per-project context preserved); the concierge is itself just-another-session
  so it inherits all of Companion's UI, notifications, and controls for free;
  routing logic is editable plain-English in one `CLAUDE.md`.
- **Cons:** the project sessions must be running (the concierge can re-spawn
  them with `remote_dispatch` if not, but the happy path assumes they're up);
  relaying is **poll-based**, not event-driven (see Limitations); the concierge
  shares the box's single daemon — no isolation between projects.
- **Failure modes:** if a project session is busy/hung, `send_input` queues
  behind it; if the project session was restarted its `sessionId` changes, so the
  concierge must **re-resolve** sessionIds each turn (the POC does this); polling
  can relay a stale snapshot if it reads before the project finishes (mitigated by
  waiting for the project session to return to a "waiting for input" state).
- **Cost to build:** low — no new daemon endpoints. One setup script, one helper
  to resolve project→sessionId, and a routing `CLAUDE.md`. All shipped here.

---

## Recommendation: **Shape B, the concierge.**

The user explicitly chose the concierge interaction model (talk inside the app)
with always-on per-project sessions, and the plumbing already supports it with
**zero changes to the watched-session/web path**:

1. A new tmux session running `claude` is **automatically watched** by the daemon
   (it tails `~/.claude/projects/*.jsonl`) and surfaces in the app as a normal
   session — confirmed below. So the concierge "shows up in the app" for free.
2. The daemon's `send_input` already accepts a **`sessionId`** and resolves it to
   the correct tmux pane by matching the conversation's `projectPath` (cwd)
   against each tmux session's `workingDir` (`daemon/src/handlers/input.ts`
   `resolveTmuxSession`). So **3 distinct always-on sessions on one box are each
   individually addressable** — the daemon is not limited to the single
   `tmux_session` from config for injection.
3. `remote_send_input` / `remote_get_conversation` proxy exactly those daemon
   messages over loopback, gated by the **`dispatch`** capability — already
   enabled on this box's listener (port 9877).

Shape A is strictly easier to build but discards the always-on per-project
context that is the whole point. Shape B reuses the same primitives and fits the
model.

---

## Routing mechanism (the load-bearing decision)

**KEY QUESTION:** with 3 always-on sessions on one box (one daemon), how does the
concierge identify and send to each project's session?

We evaluated three options:

| Option | Mechanism | Verdict |
|---|---|---|
| (i) local `tmux send-keys` directly to named sessions | concierge shells out to tmux | works but bypasses the daemon entirely, no read-back of replies, no capability gating, fragile key-injection — **rejected** |
| (ii) companion-remote over the **loopback daemon** + per-session `sessionId` | reuses `remote_send_input` / `remote_get_conversation`, capability-gated | **chosen** |
| (iii) daemon already exposes list + send_input by sessionId | yes (`get_sessions` + `send_input`), but `get_sessions` is **not** exposed over MCP | used for *resolution* via a tiny helper, see below |

**Chosen: (ii) + a sliver of (iii).** The concierge talks to the **local daemon
over loopback** using the existing `companion-remote` MCP server. `send_input`
takes a `sessionId`, and the daemon resolves that to the right tmux pane by cwd —
so injecting into a *specific* project session Just Works. This reuses existing,
capability-gated machinery and never touches forbidden files.

The one gap: MCP exposes no "list sessions" tool, so the concierge can't discover
the live `sessionId` for each project through MCP alone. We close that with a
**tiny read-only helper, `bin/companion-sessions`**, that connects to the local
daemon, sends `get_sessions`, and prints `sessionId  tmuxName  projectPath`
lines. The concierge runs it via Bash to map **project → live sessionId** each
turn (sessionIds change when a project session restarts, so re-resolving every
turn is required for correctness).

`remote_exec` was considered for discovery but is **path-gated** by the daemon's
`allowedPaths` (here `/mnt/hexinas`), so it can't read `~/.claude/projects` —
hence the dedicated helper instead.

### Why a sessionId and not just a tmux name?

`remote_send_input` requires `sessionId` (the JSONL conversation uuid). The
daemon's `resolveTmuxSession` does:

```
listSessions() → if a tmux session is literally named <sessionId>, use it;
                 else look up the conversation's projectPath and find the
                 tmux session whose workingDir == that projectPath.
```

So as long as each project's always-on `claude` runs in a tmux session **whose
working directory is the project root**, the concierge can address it precisely
by the resolved sessionId. This is the contract `bin/companion-sessions` and the
routing prompt rely on.

---

## Data flow (recommended design)

```
1. You open Companion → see the "concierge" session (daemon watches its JSONL).
2. You type:  "tell the android project to bump the version"
       │
       ▼
3. Daemon injects your text into the concierge tmux session (normal send_input).
       │
       ▼
4. Concierge Claude reads it. Per concierge/CLAUDE.md it:
     a. runs  bin/companion-sessions  → resolves project→sessionId map
     b. decides target = android  (keyword/intent match)
       │
       ▼
5. Concierge calls MCP:
     remote_send_input({ server:"local", sessionId:<android>, input:"bump the version" })
       │  (daemon resolves sessionId→tmux "android" pane, injects)
       ▼
6. Android always-on Claude does the work, returns to "waiting for input".
       │
       ▼
7. Concierge polls:
     remote_get_conversation({ server:"local", sessionId:<android>, mode:"highlights" })
     until the android session is idle again, then extracts the latest reply.
       │
       ▼
8. Concierge writes a summary back into ITS OWN conversation → you read it in-app.
```

Fan-out: for a multi-project request ("bump the version everywhere"), step 4b
selects **all three** sessionIds; steps 5–7 run per target; step 8 relays a
consolidated summary.

### How routing decisions are made

The concierge reads your natural-language message and matches it against the
project table in `concierge/CLAUDE.md`:

- **Explicit project named** ("the android project", "ios", "the server") →
  route to that one.
- **Domain keywords** (apk/gradle/play store → android; xcode/testflight/ipa →
  ios; daemon/api/vite/postgres → web&server) → infer the project.
- **"everywhere" / "all" / a cross-cutting concern** → fan out to all three.
- **Ambiguous** → the concierge asks you a one-line clarifying question instead
  of guessing.

All routing is plain English in `concierge/CLAUDE.md`; edit that file to change
behavior — no code changes.

---

## One-time setup (what the user must do)

1. **Keep the 3 project sessions always-on**, each in its own tmux session whose
   **cwd is the project root**. Example:
   ```
   tmux new -s android -c /home/hexi/local/src/<android-project>   'claude'
   tmux new -s ios     -c /home/hexi/local/src/<ios-project>       'claude'
   tmux new -s web     -c /home/hexi/local/src/<web-project>       'claude'
   ```
   (Detach with `Ctrl-b d`.) The tmux **names** don't have to match the project
   labels — routing resolves by **cwd**, so the project roots are what matter.

2. **Edit `concierge/projects.json`** so each project's `cwd` is its real project
   root (these are the values `bin/companion-sessions` matches against to find the
   live sessionId). Update the labels/keywords too if you like.

3. **Ensure the local daemon has the `dispatch` capability** (already true on this
   box: listener `:9877` has `remote_capabilities.dispatch.enabled = true`). If
   not: `bin/companion enable-remote --dispatch …`.

4. **Add a `local` entry to `~/.companion/mcp-servers.json`** pointing at the
   loopback daemon (the `bin/concierge` script does this for you if it's missing):
   ```json
   { "name": "local", "host": "127.0.0.1", "port": 9877,
     "token": "<your daemon token>", "useTls": false, "trustedNetwork": true }
   ```

5. **Register companion-remote for the concierge session** — `bin/concierge`
   does this via a project-scoped `.mcp.json` in `concierge/`, so only the
   concierge gets the routing tools.

Then every morning: `bin/concierge` → open Companion → talk to the concierge.

---

## Limitations of the POC (be explicit)

- **Poll-based relay, not event-driven.** The concierge polls
  `remote_get_conversation` and waits for the target session to return to "waiting
  for input" before relaying. There's no push from project→concierge; a long task
  means the concierge polls for a while. Realtime relay would need a daemon-side
  subscribe bridge (out of scope; would touch watcher/websocket beyond what's
  owned here).
- **sessionIds are resolved per-turn by cwd.** If two always-on sessions share a
  cwd, resolution is ambiguous (daemon picks the most recently modified). One
  always-on session per project root is assumed.
- **No auth/identity between concierge and project sessions.** The concierge can
  inject into any session the daemon can address; capability gating is the only
  guard. Treat the concierge as fully trusted on this box.
- **Project sessions must already be running.** The concierge can re-spawn a dead
  project session with `remote_dispatch` (documented in its CLAUDE.md) but the
  happy path assumes they're up.
- **Config-driven placeholders.** `concierge/projects.json` ships with the
  android/ios/web labels but **placeholder cwds** the user must set — wrong paths
  silently fail to resolve, by design we surface that as "no session found for
  <project>" rather than guessing.
- **Loopback token.** `bin/concierge` reads the daemon token from
  `~/.companion/config.json` to seed the `local` MCP entry; if you rotate the
  token, re-run `bin/concierge` (or edit `mcp-servers.json`).
- **One box only.** This POC assumes all 3 projects + concierge are on one daemon.
  Cross-box concierge would add more `mcp-servers.json` entries and route by
  `server` name — the design extends cleanly but isn't built here.
