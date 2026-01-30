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
