# Implementation Plan

## 1. Beef Up New Project Wizard
**Status:** done

### Requirements
- Back-and-forth discussion to help choose stack before template selection
- Scaffold a v1 of the app (not just boilerplate — actually plan the project)
- Option to create a private GitHub repo during project creation
- Generate CLAUDE.md with project-specific instructions and custom slash commands
- Smarter template recommendations based on user description

### Current State
- Mobile `NewProjectScreen.tsx` has a 5-step wizard: Details → Template → Options → Creating → Done
- 7 templates with scoring system (`daemon/src/scaffold/scorer.ts`)
- Templates support `{{projectName}}` and `{{projectDescription}}` variables
- GitHub repo creation already works via `gh CLI`
- Web client has NO project creation UI (only `NewSessionPanel` for existing dirs)

### Files to Modify
- `app/src/screens/NewProjectScreen.tsx` — Add discussion step, CLAUDE.md generation step
- `daemon/src/scaffold/generator.ts` — Add CLAUDE.md + `.claude/commands/*.md` generation after scaffolding
- `daemon/src/scaffold/templates.ts` — Add `claudeMd` and `commands` template content per stack
- `daemon/src/websocket.ts` — Add `generate_claude_md` endpoint (or fold into scaffold_create)
- `web/src/components/NewProjectPanel.tsx` (new) — Web version of project creation

### Implementation Steps

1. **Add "Discuss" step before template selection** (mobile)
   - New wizard step between Details and Template
   - User describes what they want to build in a freetext area
   - Send description to daemon for template scoring
   - Show AI-suggested template order with match explanations
   - User can refine description or skip to template selection

2. **Generate CLAUDE.md per project**
   - Each template gets a `claudeMd` field with project-specific instructions
   - Content includes: project structure overview, build/test commands, coding conventions
   - Generate standard slash commands tailored to the stack:
     - `/up` — start dev server/services (e.g., `npm run dev`, `uvicorn main:app`, `go run .`)
     - `/down` — stop services
     - `/todo` — quick-capture task to todo.md
     - `/plan` — process todo items into implementation plans
     - `/work` — implement planned items with TDD
     - `/test` — run test suite (e.g., `npm test`, `pytest`, `go test ./...`)
   - Commands are `.claude/commands/*.md` files, each with a prompt template
   - Written to project root during scaffolding

3. **Improve scaffold flow**
   - After template creation, generate CLAUDE.md as a separate step (visible in progress)
   - Optionally run initial `claude` session to analyze and refine the scaffold
   - Show CLAUDE.md preview in the "Done" step

4. **Port to web client**
   - Create `NewProjectPanel.tsx` component for web
   - Same wizard flow: description → template → options → create
   - Reuse all daemon endpoints (same WebSocket protocol)

### Tests Needed
- Template scoring with various descriptions returns sensible ordering
- CLAUDE.md generated correctly for each template type
- GitHub repo creation still works
- Web project creation panel renders and creates projects
- Progress updates flow correctly during multi-step scaffold

---

## 2. Allow Multiple Sessions for Same Folder (Git Worktree)
**Status:** done

### Requirements
- Explicit worktree creation: user clicks "New Session" and chooses worktree mode
- Two sessions can edit the same project concurrently without conflicts
- Git worktree manages separate working directories branching from the same repo
- Dashboard shows worktree sessions grouped under the parent project
- Cleanup when worktree session is killed

### Current State
- Sessions are identified by encoded path: `/Users/foo/bar` → `-Users-foo-bar`
- Only 1:1 mapping between tmux session and project path
- `TmuxManager.createSession(name, workingDir)` creates tmux session in a directory
- `SessionWatcher` matches conversation files by encoded path to tmux sessions
- No git worktree support exists anywhere in the codebase

### Key Constraint
Git worktrees create a new directory (e.g., `/Users/foo/bar-worktree-1`) that shares `.git` with the main repo. Because the directory path is different, the existing session ID system (`-Users-foo-bar-worktree-1`) naturally creates a separate conversation — no collision.

### Files to Modify
- `daemon/src/tmux-manager.ts` — Add `createWorktreeSession()` method
- `daemon/src/websocket.ts` — Add `create_worktree_session` endpoint
- `daemon/src/watcher.ts` — Track worktree relationships (optional grouping)
- `daemon/src/types.ts` — Add worktree metadata to session types
- `app/src/screens/NewProjectScreen.tsx` — Add "New worktree session" option
- `app/src/components/SessionPicker.tsx` — Show worktree sessions grouped
- `web/src/components/NewSessionPanel.tsx` — Add worktree creation option

### Implementation Steps

1. **Daemon: Git worktree management**
   - Add `createWorktreeSession(parentDir, branchName?)` to `TmuxManager`
   - Runs: `git worktree add ../project-wt-<timestamp> [-b <branch>]`
   - Creates tmux session in the new worktree directory
   - Tags with `COMPANION_APP=1` + `COMPANION_WORKTREE=<parentDir>`
   - Store worktree metadata in `tmux-sessions.json`

2. **Daemon: Worktree cleanup**
   - On `kill_tmux_session` for a worktree session:
     - Run `git worktree remove <path>` to clean up
     - Remove the worktree directory
     - Remove from session configs

3. **WebSocket endpoint: `create_worktree_session`**
   - Payload: `{ parentDir: string, branch?: string }`
   - Validates parent dir is a git repo
   - Creates worktree + tmux session
   - Returns: `{ sessionName, workingDir, branch }`

4. **UI: "New worktree session" option**
   - In session picker / new session panel, add "Branch session" button
   - Only visible when current session is a git repo
   - Prompts for branch name (optional, defaults to timestamp-based name)
   - Shows in session list with branch indicator

5. **Dashboard grouping** (optional enhancement)
   - Sessions from same git repo grouped visually
   - Show branch name next to session name
   - Indicator that sessions share a repo

### Tests Needed
- Creating a worktree session from an existing git repo
- Two worktree sessions can run concurrently without conversation collision
- Killing a worktree session cleans up the worktree directory
- Non-git directories don't show worktree option
- Session picker shows branch names for worktree sessions

---

## 3. Tmux Session Manager — Web to Mobile Parity
**Status:** done

### Requirements
- Full parity with web's TerminalPanel on mobile
- SSH command display with copy functionality
- Pause/resume auto-refresh
- All features the web terminal viewer has that mobile currently lacks

### Current State

**Web TerminalPanel** has:
- Polls `get_terminal_output` every 2s (150 lines)
- ANSI color rendering via `parseAnsiText()`
- Auto-scroll to bottom (pauses when user scrolls up)
- Pause/Resume toggle button
- Manual refresh button
- SSH command display with copy-to-clipboard
- Server `sshUser` + `host` for SSH command generation

**Mobile TerminalScreen** already has:
- Polls `get_terminal_output` every 2s
- ANSI color rendering via same `parseAnsiText()`
- Auto-scroll with pull-to-refresh
- Font size zoom buttons (8-20px)
- Auto-refresh toggle

**Gaps (mobile missing):**
- No SSH command display
- No copy SSH command functionality
- No pause button (has auto-refresh toggle but UX differs)
- No scroll-position-aware auto-scroll (web pauses auto-scroll when user scrolls up)

### Files to Modify
- `app/src/screens/TerminalScreen.tsx` — Add SSH command display, improve auto-scroll
- `app/src/types/index.ts` — Ensure `Server` type has `sshUser` field (may already exist)
- `app/src/screens/EditServerScreen.tsx` — Add SSH user field if not present
- `app/src/services/storage.ts` — Persist sshUser in server config

### Implementation Steps

1. **Add SSH user to mobile Server type**
   - Check if `sshUser` already exists on mobile `Server` type
   - If not, add `sshUser?: string` to `Server` interface
   - Add SSH user input field to `EditServerScreen.tsx`
   - Persist in AsyncStorage with other server fields

2. **Add SSH command display to TerminalScreen**
   - Props: pass `server` object (or `host` + `sshUser`) to TerminalScreen
   - Display SSH command at top: `ssh user@host -t 'tmux attach -t <session>'`
   - Add copy button using `Clipboard.setStringAsync()` from `expo-clipboard`
   - If no sshUser configured, show hint to set it in server settings

3. **Improve auto-scroll behavior**
   - Track scroll position: if user scrolls up, pause auto-scroll
   - Resume auto-scroll when user scrolls back to bottom
   - Match web's `isNearBottom` threshold (120px from bottom)
   - Show "scroll to bottom" indicator when not at bottom

4. **Polish parity**
   - Ensure pause/resume button matches web's UX
   - Add manual refresh button if not already present
   - Match toolbar layout: [Pause] [Refresh] [SSH command] [Zoom controls]

### Tests Needed
- SSH command renders correctly with server host + sshUser
- Copy button copies SSH command to clipboard
- Auto-scroll pauses when user scrolls up, resumes at bottom
- SSH user field saves and loads from server config
- TerminalScreen renders without sshUser (shows hint instead)

---

## 4. Parallel Work Groups
**Status:** done

### Overview

When `/work` finds multiple planned items in `plan.md`, it analyzes file overlap to detect which items can be implemented concurrently. For parallelizable items, it spawns independent Claude Code sessions — each in its own git worktree on a dedicated branch — and coordinates their lifecycle. A revised web dashboard groups these "worker" sessions under the originating "foreman" session, showing progress, surfacing questions inline, and providing merge controls when workers finish.

### Concepts

- **Work Group** — A set of related sessions spawned from a single `/work` invocation. Has one foreman and one or more workers.
- **Foreman** — The original session that analyzed the plan and spawned the group. Can continue working on sequential items while workers run.
- **Worker** — An independent Claude Code session running in a git worktree, focused on a single plan item. Commits to its own branch.
- **Worker Prompt** — A scoped version of the plan item injected into the worker session at startup.

### Requirements

**`/work` changes:**
- Detect 2+ planned items and analyze file overlap between them
- Present parallelization proposal to user via AskUserQuestion
- Call daemon API to spawn work group if approved
- Foreman can work sequential items while parallel workers run
- Foreman handles merge when all workers complete

**Daemon — WorkGroupManager service:**
- Create work groups: worktrees + tmux sessions + CLI startup + prompt injection
- Track work group lifecycle (active → merging → completed/failed)
- Persist state to disk (survives daemon restart)
- Detect worker completion via conversation status
- Merge branches on request
- Clean up worktrees after merge or cancellation

**Daemon — WebSocket endpoints:**
- `spawn_work_group` — Create group with task list, returns group ID + worker IDs
- `get_work_groups` — List all groups with worker status summaries
- `get_work_group` — Single group detail with per-worker status, activity, questions
- `merge_work_group` — Merge completed worker branches into foreman branch
- `cancel_work_group` — Kill all workers, remove worktrees, mark cancelled
- `retry_worker` — Restart a failed/errored worker
- `send_worker_input` — Send input to a specific worker (for answering questions from the group view)

**Web dashboard — sidebar grouping:**
- Sessions belonging to a work group nest under the foreman as a collapsible tree
- Foreman row shows mini progress bar (completed/total)
- Worker rows are indented, show status dot + current activity
- Clicking a worker selects it like any session (shows its conversation)
- Clicking the foreman shows its conversation + a Work Group Bar

**Web dashboard — Work Group Panel:**
- Accessible from the Work Group Bar in the foreman's session view
- Shows overall progress bar and worker cards
- Worker cards surface waiting questions inline (answer without drilling in)
- Merge/cancel controls at the bottom
- "View" button on each card navigates to that worker's conversation

**Mobile dashboard:**
- Work groups render as expandable cards (follows existing dashboard pattern)
- Worker cards within show status + inline questions
- Merge/cancel actions accessible from the group card

**Notifications:**
- Worker waiting for input → push notification naming the worker + question
- All workers complete → push notification "Work group ready to merge"
- Worker error → push notification with error summary

### `/work` Command Flow

```
User runs /work
  │
  ├─ Read plan.md → find all "Status: planned" items
  │
  ├─ If only 1 item → work as today (sequential TDD)
  │
  ├─ If 2+ items → analyze file overlap
  │   For each pair of items, compare "Files to Modify" lists
  │   Items with NO shared files → parallelizable
  │   Items with shared files → must be sequential
  │
  ├─ Present proposal via AskUserQuestion:
  │   "3 planned items found. 2 can run in parallel:
  │
  │    Parallel group:
  │      - auth-service (src/auth/*, tests/auth/*)
  │      - dashboard-ui (src/components/dashboard/*)
  │
  │    Sequential (shares src/auth/middleware.ts with auth-service):
  │      - user-api
  │
  │    [Parallelize] [Work sequentially] [Let me choose]"
  │
  ├─ If approved → curl daemon API:
  │   POST http://localhost:9877
  │   { "type": "spawn_work_group", "payload": {
  │       "name": "Feature: Auth System",
  │       "planFile": "/path/to/plan.md",
  │       "workers": [
  │         { "taskSlug": "auth-service", "planSection": "...", "files": [...] },
  │         { "taskSlug": "dashboard-ui", "planSection": "...", "files": [...] }
  │       ]
  │   }}
  │
  ├─ Daemon spawns workers, returns group ID
  │
  ├─ Foreman continues with sequential item (user-api)
  │   Works it normally via TDD
  │
  └─ After sequential work done, check worker status
      If all complete → merge
      If some still running → "Workers still running. Monitor from dashboard."
```

### Daemon: spawn_work_group Flow

```
Receive spawn_work_group request
  │
  ├─ For each worker in payload:
  │   ├─ git worktree add ../project-wt-<slug> -b parallel/<slug>
  │   ├─ tmux new-session -d -s companion-<slug>-<hash>
  │   ├─ Start claude in the session
  │   ├─ Wait for CLI ready (poll terminal output for prompt)
  │   └─ Inject worker prompt via sendKeys
  │
  ├─ Create WorkGroup record:
  │   { id, name, foremanSessionId, workers[], status: 'active', createdAt }
  │
  ├─ Persist to /etc/companion/work-groups.json
  │
  ├─ Start monitoring worker sessions via SessionWatcher events
  │
  └─ Return { groupId, workers: [{ sessionId, branch, worktreePath }] }
```

### Worker Prompt Template

Each worker receives a focused prompt scoped to its single task:

```
You are implementing one item from a parallel work plan. Other items are being
worked on simultaneously in separate sessions. Stay focused on your task only.

## Task: {{taskSlug}}

{{planSection}}

## Rules
- Only modify files listed in "Files to Modify" above
- Follow TDD: write tests first, then implement, then refactor
- Run type check: npx tsc --noEmit
- Commit with a descriptive message when done (do NOT push)
- If you need clarification, ask — someone is monitoring
- When finished, your final message should start with "TASK COMPLETE:"
  followed by a summary of what was done and commit SHAs
```

### Detecting Worker Completion

Two signals that a worker is done:
1. **Conversation status**: `isWaitingForInput` is true AND the last assistant message starts with "TASK COMPLETE:"
2. **Fallback**: Worker session has been idle for >2 minutes after committing

The WorkGroupManager polls worker sessions every 5 seconds (or subscribes to SessionWatcher events) and updates group state accordingly.

### Merge Strategy

When merge is requested (via endpoint or foreman prompt):

```
1. cd to foreman's working directory (main repo)
2. Ensure clean working tree
3. Try octopus merge:
   git merge parallel/auth-service parallel/dashboard-ui --no-edit
4. If clean:
   - Commit merge
   - Mark group as completed
   - Clean up worktrees: git worktree remove <path> for each
   - Kill worker tmux sessions
   - Return { success: true, mergeCommit: sha }
5. If conflicts:
   - Abort: git merge --abort
   - Return { success: false, conflicts: [list of files] }
   - User can choose:
     a. Sequential merge (merge one at a time, resolve conflicts)
     b. Manual resolution (user handles it)
```

### Data Model

**New types in `daemon/src/types.ts`:**

```typescript
export interface WorkGroup {
  id: string;                        // UUID
  name: string;                      // Human-readable, e.g. "Feature: Auth System"
  foremanSessionId: string;          // Conversation session ID of foreman
  foremanTmuxSession: string;        // Tmux session name of foreman
  status: 'active' | 'merging' | 'completed' | 'failed' | 'cancelled';
  workers: WorkerSession[];
  createdAt: number;
  completedAt?: number;
  planFile?: string;                 // Absolute path to plan.md
  mergeCommit?: string;              // SHA after successful merge
  error?: string;                    // Error message if failed
}

export interface WorkerSession {
  id: string;                        // UUID
  sessionId: string;                 // Conversation session ID (encoded path)
  tmuxSessionName: string;           // Tmux session name
  taskSlug: string;                  // From plan item title
  taskDescription: string;           // Brief description for UI
  branch: string;                    // Git branch name: parallel/<slug>
  worktreePath: string;              // Absolute path to worktree dir
  status: 'spawning' | 'working' | 'waiting' | 'completed' | 'error';
  commits: string[];                 // Commit SHAs produced
  startedAt: number;
  completedAt?: number;
  lastActivity?: string;             // Current activity text
  lastQuestion?: WorkerQuestion;     // Latest unanswered question (for inline display)
  error?: string;
}

export interface WorkerQuestion {
  text: string;                      // The question text
  options?: { label: string }[];     // Choice options if multiple-choice
  timestamp: number;
}
```

### New File: `daemon/src/work-group-manager.ts`

Responsibilities:
- CRUD for work groups (in-memory Map + disk persistence)
- Spawn workers (calls TmuxManager + InputInjector)
- Monitor worker status (listens to SessionWatcher events)
- Merge branches (runs git commands)
- Clean up on cancellation/completion
- Reconstruct state on daemon restart (scan disk + tmux sessions)

Key methods:
```
createWorkGroup(payload) → WorkGroup
getWorkGroups() → WorkGroup[]
getWorkGroup(id) → WorkGroup
mergeWorkGroup(id) → MergeResult
cancelWorkGroup(id) → void
retryWorker(groupId, workerId) → void
sendWorkerInput(groupId, workerId, text) → void
```

State file: `/etc/companion/work-groups.json`

### Files to Modify

**Daemon (new):**
- `daemon/src/work-group-manager.ts` — New service: WorkGroupManager

**Daemon (modify):**
- `daemon/src/types.ts` — Add WorkGroup, WorkerSession, WorkerQuestion interfaces
- `daemon/src/websocket.ts` — Add 6 new endpoints (spawn, get, list, merge, cancel, retry, send_worker_input)
- `daemon/src/index.ts` — Initialize WorkGroupManager, wire to watcher events
- `daemon/src/watcher.ts` — Emit events that WorkGroupManager can subscribe to for worker completion detection

**Web (new):**
- `web/src/components/WorkGroupBar.tsx` — Summary bar in foreman's session view (like SubAgentBar)
- `web/src/components/WorkGroupPanel.tsx` — Full group view with worker cards, inline questions, merge controls
- `web/src/components/WorkerCard.tsx` — Individual worker status card with activity + inline question answering
- `web/src/hooks/useWorkGroups.ts` — Fetch and poll work group data

**Web (modify):**
- `web/src/types/index.ts` — Add WorkGroup, WorkerSession, WorkerQuestion types
- `web/src/components/SessionSidebar.tsx` — Nest worker sessions under foreman with collapsible tree + mini progress bar
- `web/src/components/SessionView.tsx` — Add WorkGroupBar between SubAgentBar and TaskList
- `web/src/components/Dashboard.tsx` — Handle work group navigation (clicking worker → session view, clicking group bar → panel)
- `web/src/styles/global.css` — Styles for work group sidebar nesting, worker cards, progress bars, merge panel

**`/work` command template (modify):**
- `daemon/src/scaffold/claude-commands.ts` — Update generateWorkCommand() with parallelization logic
- `.claude/commands/work.md` — Update local copy with parallel detection + daemon API calls

**Mobile (modify — later phase):**
- `app/src/screens/DashboardScreen.tsx` — Render work groups as expandable cards with worker sub-cards
- `app/src/types/index.ts` — Add matching types

### Web Dashboard UX Design

**Sidebar — Session tree with work group nesting:**

```
┌────────────────────────────────────┐
│ Companion                     ≡    │
│ ──────────────────────────────     │
│ All  Waiting  Working  Idle        │
│                                    │
│ ● dev-box                     3    │
│                                    │
│ ▼ companion                   2m   │
│   ██████░░░░ 2/3                   │
│   ├ ● auth-service            1m   │
│   │   Writing JWT tests            │
│   ├ ◐ user-api               30s   │
│   │   Waiting for input            │
│   └ ✓ dashboard-ui           45s   │
│       Done                         │
│                                    │
│   other-project   ○ idle      5h   │
│                                    │
└────────────────────────────────────┘
```

Key sidebar behaviors:
- Foreman row has a small inline progress bar below the session name
- Worker rows are indented with tree connector lines (├ └)
- Clicking foreman → shows foreman conversation + WorkGroupBar
- Clicking worker → shows worker conversation (with "← foreman" breadcrumb)
- Collapse/expand via clicking the ▼/▶ on the foreman row
- Status filter applies to workers too (filter "waiting" shows only user-api)
- Worker status dots follow same color scheme (amber=waiting, blue=working, gray=idle, red=error, green=completed)
- Completed workers use a checkmark (✓) instead of a dot

**Main content — WorkGroupBar (in foreman's session view):**

Appears between SubAgentBar and TaskList. Compact single-line bar (same pattern as SubAgentBar):

```
┌──────────────────────────────────────────────┐
│ ● 2/3 workers complete · 1 waiting    ›      │
└──────────────────────────────────────────────┘
```

Clicking opens the WorkGroupPanel.

**Main content — WorkGroupPanel (replaces conversation temporarily):**

```
┌──────────────────────────────────────────────┐
│ ← Back to conversation                       │
│                                              │
│ Work Group: Feature Auth System              │
│ Started 5m ago · 3 workers                   │
│                                              │
│ ██████████████░░░░░░░░ 2/3 complete          │
│                                              │
│ ┌─────────────────────────────────────────┐  │
│ │ auth-service                  ● working │  │
│ │ Writing test for JWT validation         │  │
│ │ 15 messages · 4 tool calls · 2m        │  │
│ │                                [View →] │  │
│ └─────────────────────────────────────────┘  │
│                                              │
│ ┌─────────────────────────────────────────┐  │
│ │ user-api                     ◐ waiting  │  │
│ │                                         │  │
│ │ "Which validation library should I use?"│  │
│ │ [zod] [joi] [yup] [Other...]            │  │
│ │                                         │  │
│ │ 8 messages · 1 tool call · 30s [View →] │  │
│ └─────────────────────────────────────────┘  │
│                                              │
│ ┌─────────────────────────────────────────┐  │
│ │ dashboard-ui                ✓ completed │  │
│ │ 2 commits · all tests passing           │  │
│ │ 22 messages · 8 tool calls · 3m         │  │
│ │                                [View →] │  │
│ └─────────────────────────────────────────┘  │
│                                              │
│ [Merge Completed]        [Cancel Group]      │
│                                              │
│ Merge will combine parallel/auth-service     │
│ and parallel/dashboard-ui into main.         │
│ user-api is still working.                   │
└──────────────────────────────────────────────┘
```

Key behaviors:
- **Inline question answering**: Worker cards that are waiting show the question + options directly in the card. Clicking an option sends input to that worker without navigating away.
- **"View →" button**: Navigates to that worker's conversation view (sets it as active session in sidebar).
- **Merge button**: Only enabled when at least 1 worker is completed. Can partial-merge completed workers while others continue.
- **Cancel button**: Confirmation dialog, then kills all workers + removes worktrees.
- **Worker card sort**: Waiting first, then working, then completed (same priority as sessions).
- **Auto-refresh**: Polls `get_work_group` every 5s to update status.
- **Completion state**: When all workers done, the panel shows a prominent merge section with branch summary.

**Worker conversation view — breadcrumb navigation:**

When viewing a worker's conversation, a breadcrumb appears above the session header:

```
┌──────────────────────────────────────────────┐
│ ← companion / auth-service                   │
│ ─────────────────────────────────────────── │
│ [mute] [auto-approve] [terminal] [archive]   │
│                                              │
│ (normal session view with messages...)        │
```

Clicking "← companion" returns to the foreman session. The breadcrumb only shows for sessions that are part of a work group.

### Implementation Steps

**Phase 1: Daemon foundation**

1. Add types to `daemon/src/types.ts` (WorkGroup, WorkerSession, WorkerQuestion)

2. Create `daemon/src/work-group-manager.ts`:
   - State management (Map<string, WorkGroup> + disk persistence)
   - `createWorkGroup()`: iterate workers, create worktree + session for each, inject prompt
   - `getWorkGroups()`, `getWorkGroup()`: read accessors
   - Worker status monitoring: subscribe to SessionWatcher events, detect completion
   - `mergeWorkGroup()`: git merge logic with conflict detection
   - `cancelWorkGroup()`: kill sessions, remove worktrees, update state
   - `retryWorker()`: recreate a single failed worker
   - Startup reconstruction: read disk state, verify against live tmux sessions

3. Wire into `daemon/src/index.ts`:
   - Instantiate WorkGroupManager
   - Pass watcher reference for event subscription

4. Add WebSocket endpoints in `daemon/src/websocket.ts`:
   - `spawn_work_group`, `get_work_groups`, `get_work_group`
   - `merge_work_group`, `cancel_work_group`
   - `retry_worker`, `send_worker_input`
   - Broadcast `work_group_update` on state changes

**Phase 2: Web dashboard**

5. Add types to `web/src/types/index.ts`

6. Create `web/src/hooks/useWorkGroups.ts`:
   - Poll `get_work_groups` every 5s per connected server
   - Return Map<serverId, WorkGroup[]>
   - Subscribe to `work_group_update` broadcasts for instant updates

7. Modify `web/src/components/SessionSidebar.tsx`:
   - For each server, check if any sessions belong to a work group
   - Group worker sessions under their foreman as indented children
   - Show mini progress bar on foreman row
   - Collapsible worker list (▼/▶ toggle)
   - Tree connector lines for visual hierarchy

8. Create `web/src/components/WorkGroupBar.tsx`:
   - Compact summary bar (follows SubAgentBar pattern)
   - Shows worker count, completion count, any waiting
   - Click handler to open WorkGroupPanel

9. Create `web/src/components/WorkerCard.tsx`:
   - Status badge, task slug, current activity
   - Message count, tool call count, duration
   - Inline question rendering + option buttons (for waiting workers)
   - "View →" button to navigate to worker session

10. Create `web/src/components/WorkGroupPanel.tsx`:
    - Back button to return to foreman conversation
    - Overall progress bar
    - List of WorkerCards sorted by status priority
    - Merge button (with confirmation, shows branch list)
    - Cancel button (with confirmation)
    - Auto-polls for updates

11. Modify `web/src/components/SessionView.tsx`:
    - Insert WorkGroupBar between SubAgentBar and TaskList
    - Manage panel state (show conversation vs. WorkGroupPanel)

12. Modify `web/src/components/Dashboard.tsx`:
    - Pass work group data through to sidebar and session view
    - Handle breadcrumb navigation (worker → foreman → worker)

13. Add styles to `web/src/styles/global.css`:
    - Sidebar tree nesting (indentation, connector lines)
    - Worker cards, progress bars, merge panel
    - Breadcrumb bar
    - Inline question rendering within cards

**Phase 3: `/work` command update**

14. Update `daemon/src/scaffold/claude-commands.ts` `generateWorkCommand()`:
    - Add parallel detection logic to the prompt template
    - Include file overlap analysis instructions
    - Add AskUserQuestion-based parallelization proposal
    - Add curl commands to call daemon API
    - Add foreman monitoring/merge instructions

15. Update `.claude/commands/work.md` (local copy):
    - Same changes as above for this project

**Phase 4: Mobile (follow-up)**

16. Add types to `app/src/types/index.ts`

17. Modify `app/src/screens/DashboardScreen.tsx`:
    - Render work groups as expandable cards
    - Worker sub-cards with inline questions
    - Merge/cancel actions

18. Add push notification integration for work group events

### Error Handling

- **Worker crashes mid-task**: Mark as error, other workers continue. Error card shows last error message. Retry button available.
- **Worker stuck (no activity >5min)**: Flag in UI with warning icon. User can view conversation, send input, or kill.
- **Merge conflicts**: Return conflicting file list. Offer sequential merge (one branch at a time with conflict resolution) or manual mode.
- **Daemon restart during active group**: Reconstruct from disk state + tmux session scan. Workers in tmux continue running; daemon reconnects to their conversation files.
- **Foreman dies**: Workers are independent sessions — they continue. Work group remains tracked by daemon. User can merge from dashboard without foreman.
- **Network loss to dashboard**: Standard reconnection. Work groups are server-side state, so dashboard recovers on reconnect.

### Tests Needed

- WorkGroupManager: create group with 2 workers, verify worktrees + sessions created
- WorkGroupManager: detect worker completion via conversation status
- WorkGroupManager: merge 2 completed worker branches cleanly
- WorkGroupManager: handle merge conflict (abort + return conflict list)
- WorkGroupManager: cancel group cleans up all worktrees and sessions
- WorkGroupManager: persist and restore state across restart
- WebSocket: spawn_work_group returns group ID + worker details
- WebSocket: get_work_group returns current status of all workers
- WebSocket: send_worker_input delivers text to correct worker session
- Web sidebar: worker sessions nest under foreman with correct indentation
- Web WorkGroupPanel: renders worker cards sorted by status priority
- Web WorkGroupPanel: inline question answering sends input to correct worker
- Web WorkGroupPanel: merge button triggers merge and shows result
- `/work` command: detects 2 parallelizable items with no file overlap
- `/work` command: detects sequential items due to shared files
- `/work` command: presents proposal and spawns group on approval

---

## 5. Vibrant Color Refresh — Mobile + Web
**Status:** done

### Overview

The app currently uses a flat, monochrome dark slate palette (`#111827` / `#1f2937` / `#374151`) with color only on status dots and action buttons. This refresh adds vibrant blue/purple accents throughout — gradient headers, tinted card backgrounds, colored borders, and richer visual hierarchy — while keeping the dark theme foundation. Both mobile app and web client get updated in sync.

### Color Direction

**Primary gradient:** Blue → Purple (`#3b82f6` → `#8b5cf6`)
**Secondary gradient:** Indigo → Violet (`#6366f1` → `#a78bfa`)
**Accent glow:** Subtle purple tints for card hover/active states
**Warm accent:** Keep amber (`#f59e0b`) and green (`#10b981`) for status — they pop nicely against blue/purple

### New Color Tokens

```
// Gradient anchors
--gradient-start: #3b82f6     (blue-500)
--gradient-end: #8b5cf6       (violet-500)
--gradient-subtle-start: #1e3a5f
--gradient-subtle-end: #2e1065

// Tinted card backgrounds
--card-bg-blue: #111c33       (very dark blue tint, replaces #1f2937 in key spots)
--card-bg-purple: #1a1033     (very dark purple tint)
--card-border-accent: #3b4f8a (muted blue border, replaces #374151 on key cards)

// Interactive
--button-gradient: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)
--button-hover: linear-gradient(135deg, #2563eb 0%, #7c3aed 100%)

// Text accents
--text-accent-blue: #60a5fa   (existing, used more)
--text-accent-purple: #a78bfa (existing, used more)
--text-accent-gradient: gradient text for titles
```

### Requirements
- Keep the dark theme base — this is accent enhancement, not a light mode
- Blue/purple gradient direction inspired by Linear, Discord, Vercel
- Both mobile app and web client updated
- All screens touched evenly — dashboard, session view, settings, terminal, archives, task detail, new project wizard, work group cards
- Status colors (green/amber/red) stay the same — they're semantic and already vibrant
- No gradient overload — use gradients on headers and primary buttons, tints on cards
- Web CSS variables make this systematic; mobile needs per-component updates

### Files to Modify

**Mobile App:**
- `app/src/screens/DashboardScreen.tsx` — Header gradient, server card tinted borders, session row accent backgrounds, summary bar gradient accents
- `app/src/screens/SessionView.tsx` — Header gradient, activity bar purple tint, user message bubble gradient, input bar accent border, modal header gradients
- `app/src/screens/SettingsScreen.tsx` — Section headers with accent color, toggle track colors, hint box purple left border
- `app/src/screens/TerminalScreen.tsx` — Header gradient, toolbar button accents, SSH bar gradient label
- `app/src/screens/ServerList.tsx` — Add button gradient, form accent borders
- `app/src/screens/EditServerScreen.tsx` — Save button gradient, QR button accent, section styling
- `app/src/screens/ArchiveScreen.tsx` — Archive item left accent border, header gradient
- `app/src/screens/TaskDetailScreen.tsx` — Status badge gradients, header gradient
- `app/src/screens/NewProjectScreen.tsx` — Step indicator gradient dots, template card selected gradient border, progress bar gradient, button gradients
- `app/src/components/ServerCard.tsx` — Card border-left gradient accent, name with subtle color
- `app/src/components/WorkGroupCard.tsx` — Card border gradient (blue→purple instead of green), progress bar gradient
- `app/src/components/StatusIndicator.tsx` — Keep as-is (status colors are semantic)
- `app/src/components/MessageBubble.tsx` — User bubble gradient background, assistant bubble subtle border
- `app/src/components/ToolCard.tsx` — Tool card header tint, chip colors

**Web Client:**
- `web/src/styles/variables.css` — Add new gradient and tint CSS variables
- `web/src/styles/global.css` — Header gradients, sidebar accent, card tints, button gradients, progress bar gradients, input focus glow
- `web/src/components/SessionSidebar.tsx` — Sidebar header gradient, active session highlight with blue/purple tint
- `web/src/components/StatusPage.tsx` — Server card borders, summary stats accent colors
- `web/src/components/SessionView.tsx` — Header gradient, message styling
- `web/src/components/WorkGroupPanel.tsx` — Panel header gradient, worker card tints
- `web/src/components/WorkGroupBar.tsx` — Bar gradient background
- `web/src/components/WorkerCard.tsx` — Card border accent
- `web/src/components/ServerForm.tsx` — Button gradients, input focus states
- `web/src/components/ServerList.tsx` — Card hover states with purple tint

### Implementation Steps

**Phase 1: Create shared color foundation**

1. **Web: Add gradient CSS variables to `variables.css`**
   - Add all new tokens listed above
   - Add gradient utility classes (`.gradient-header`, `.gradient-button`, `.gradient-text`)
   - Add card tint background variants

2. **Mobile: Create `app/src/theme/colors.ts`** (new file)
   - Central color constants file so mobile stops using scattered hex values
   - Export gradient configs for `expo-linear-gradient` (or `react-native-linear-gradient`)
   - Export tinted background colors, accent borders, text accent colors
   - All existing colors mapped to named constants

**Phase 2: Headers and navigation (high visual impact)**

3. **Mobile: Gradient headers on all screens**
   - Replace flat `#1f2937` header backgrounds with `LinearGradient` (blue→purple)
   - Screens: Dashboard, SessionView, Settings, Terminal, ServerList, EditServer, Archive, TaskDetail, NewProject
   - Header text stays white, icons stay white — gradient is the background
   - Subtle opacity so it's not overwhelming (maybe 85% opacity gradient over dark base)

4. **Web: Gradient headers**
   - Sidebar header gets subtle gradient
   - Main content header/toolbar gets gradient
   - Use CSS `background: linear-gradient(...)` on header elements

**Phase 3: Cards and content areas**

5. **Mobile: Tinted card backgrounds**
   - Server cards: Replace `#1f2937` with `#111c33` (dark blue tint) + left border gradient (2px blue→purple)
   - Session rows: Active session gets subtle blue tint background
   - Work group cards: Blue/purple border gradient instead of green
   - Task cards: Subtle purple tint on expanded task area
   - Archive items: Left accent border (thin gradient line)

6. **Web: Tinted cards and surfaces**
   - Sidebar session items: Active state uses purple-tinted background
   - Server cards on status page: Gradient left border
   - Worker cards: Blue tint backgrounds
   - Panel headers: Subtle gradient

**Phase 4: Buttons and interactive elements**

7. **Mobile: Gradient buttons**
   - Primary action buttons (Add Session, Save, Send, Create Project): Blue→purple gradient
   - Secondary buttons stay flat but get accent border color
   - Input bar "send" button: Small gradient
   - Toggle switches: Blue→purple track when enabled (instead of flat `#3b82f6`)

8. **Web: Gradient buttons and interactions**
   - Primary buttons: Gradient background
   - Input focus states: Purple glow border (`box-shadow` with violet)
   - Hover states on cards: Subtle purple tint transition

**Phase 5: Progress bars and indicators**

9. **Both: Gradient progress bars**
   - Task progress bars: Blue→green gradient fill (instead of flat green)
   - Work group progress: Blue→purple gradient fill
   - New project creation progress: Gradient fill
   - Step indicators: Active dot gets gradient background

**Phase 6: Text and detail accents**

10. **Mobile: Accent text colors**
    - Screen titles could use gradient text (via `MaskedView` + `LinearGradient`) — sparingly
    - Activity text: Use `#a78bfa` (purple) alongside existing `#60a5fa` (blue) for variety
    - Tool card headers: Purple accent instead of all blue
    - Section labels: Slightly tinted rather than pure gray

11. **Web: Accent text and details**
    - Gradient text on key headings (CSS `background-clip: text`)
    - Link hover colors: Shift toward purple
    - Code/tool labels: Purple accent chip backgrounds

**Phase 7: Conversation view specifics**

12. **Mobile: Message styling**
    - User message bubbles: Subtle blue→purple gradient background (replacing flat blue)
    - Assistant messages: Keep dark but add thin left border with gradient
    - Tool cards: Header area gets blue tint, expand/collapse chevron in accent color
    - Activity bar: Purple tint (instead of flat dark blue `#1e3a5f`)
    - Agents bar: Keep green (semantic) but slightly more vibrant

13. **Web: Message styling**
    - User messages: Gradient background
    - Tool cards: Accent border
    - Status banners: Richer colored backgrounds

### Notes

- `expo-linear-gradient` is already available in Expo — no new dependency needed for mobile gradients
- For gradient text on mobile, use `expo-masked-view` + `LinearGradient` — only use on 1-2 key headings, not everywhere
- Web gradient text via `background: linear-gradient(...); -webkit-background-clip: text; -webkit-text-fill-color: transparent;`
- Keep all status indicator colors (green/amber/red/gray) unchanged — they're semantic
- The goal is "vibrant accents" not "everything is gradient" — restraint is key
- Terminal screen keeps its GitHub-dark theme (`#0d1117`) — just the header gets gradient treatment

### Tests Needed
- Visual inspection on both iOS and Android (gradient rendering can differ)
- Web: Check all screens in Chrome and Firefox
- Dark mode only (no light mode considerations)
- Verify status colors still read clearly against new tinted backgrounds
- Verify text contrast ratios remain accessible on tinted cards
- Check `LinearGradient` performance on older devices (should be fine for static backgrounds)
