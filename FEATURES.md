# Companion Features

High-level features of the Companion daemon, web client, and desktop/mobile apps.

## Cross-Platform Apps
- Single web codebase (React + Vite + TypeScript) powers all client platforms
- **Android** and **iOS** via Tauri 2.0 mobile (native WebView wrapper)
- **macOS**, **Linux**, and **Windows** desktop via Tauri 2.0
- **Web** — served directly by the daemon at `http://<host>:9877/web`
- Mobile-optimized layout with full-screen session list, bottom toolbar, safe area insets
- Desktop layout with sidebar + session view side-by-side
- **Desktop auto-update** (Tauri updater): checks the daemon's own feed (`/updates/stable/latest.json`, no GitHub Releases) at startup and every 6 hours, downloads + verifies (minisign) in the background, then offers "Restart to update" in the app and tray; optional install-on-quit (Settings > Desktop). Versions are `1.0.<git commit count>`. Publish with `bin/companion publish-update --run <id|latest>`
- **Android in-app updates** (sideload): the app checks `/updates/stable/android.json` on launch and every 6 hours and shows "Update available (1.0.N)"; one tap downloads the APK, verifies its SHA-256 and that it is signed by the same certificate as the installed app, then opens the system installer (the user confirms; deep-links to "Install unknown apps" when needed). Publish with `bin/companion publish-update --apk <signed.apk>` (refuses an older or equal versionCode)
- macOS builds signed with Developer ID, notarized and stapled in CI when the `APPLE_DEVID_CERT_*` secrets exist (ad-hoc fallback otherwise); `bin/desktop-signing` manages the certificate and updater keys

## First-Run Setup Wizard
- **Install, open, follow the wizard**: a daemon started without a config generates one in setup mode (`setup_complete: false`; name = hostname; `COMPANION_PORT` / `COMPANION_NAME` / `COMPANION_MDNS` honoured) and prints the wizard address (`/web/`) instead of a token, on every start until setup is finished. Existing installs (no `setup_complete` key) are never in setup mode
- **First device without a code**: a browser on the server itself pairs with one click while no device is paired yet (loopback peer, no proxy headers, loopback Host, same-host Origin); everyone else pairs by code (printed in the log and `bin/companion setup` / `pair`), Nearby or QR
- Steps: Welcome, Pair, Name, Check your machine (node, tmux, git, Claude Code installed + signed in by credential-file presence only, Tailscale, voice service, disk, boot service, ports; per-item re-check, copyable fix commands), Claude Code, Projects (folder picker bounded to `$HOME`; `project_roots` also bound Herald's spawns), First session (started through the normal spawn path; trust-dialog and `/login` guidance until the conversation is detected), Your devices (devices list, pairing QR, "Get the apps" links from this server's update feed), Notifications (browser now; push relay described as coming soon), Herald (Anthropic key into `~/.companion/secrets.env` through a masked field, or a local OpenAI-compatible URL, or off; voice service install; device check), Remote access (Tailscale URL or options), Done (summary, restart note)
- Setup API only for a paired device or the listener token, only from localhost / LAN / tailnet (public and reverse-proxied clients refused); every write audit-logged; service installs (systemd user unit / launchd agent, herald-voice unit) run only after an explicit confirm and never restart the running daemon (`autostart enable --no-start`)
- **`~/.companion/secrets.env`** (0600, atomic writes): loaded by the daemon and `bin/companion` without overriding the environment (cush-tools / Infisical via `install-secrets` keeps working); values are never logged or sent back, only "set / not set"; Herald's brain hot-reloads after a key or provider change
- Re-runnable from Settings > Setup: lands on the first unfinished step; any step can be revisited from the rail. A new device joining a finished server gets the short device flow (pair, notifications, Herald device check)
- Config writes (wizard, token rotation) preserve every key they do not manage
- `bin/e2e-setup-wizard`: a true first run on a fresh sandbox (`bin/herald-sandbox --fresh`, private tmux server, stub `claude`) driven in headless Chrome with desktop + mobile screenshots

## Pairing & Devices
- **Pair instead of typing a token**: Add server lists nearby daemons (mDNS `_companion._tcp`; Android NSD, iOS NWBrowser, desktop mdns-sd) with a Paired badge; pick one, then enter the 6-digit code the server shows (journal, `bin/companion pair`, signed-in apps) or approve the device from one already signed in. "Enter token manually" stays as Advanced
- **Pairing QR / link** for remote setups: `bin/companion pair --qr` or Settings > Devices > Show pairing QR makes `companion://pair?...` (one device, single use, 10 minutes); the apps scan it or open it as a deep link (Android, iOS, macOS)
- **Per-device tokens** in `~/.companion/devices.json` (0600, salted SHA-256, constant-time verify); Settings > Devices and `bin/companion devices list|revoke|rename` show last seen, This device, rename, revoke. Revoking signs the device out at once
- "Approve new device?" prompt (name, platform, code) on every signed-in client; never by voice
- Limits: 5 wrong codes per request, 10 pending, per-IP throttle with backoff, daemon-wide suspension after 50 wrong codes; code pairing only from LAN / tailnet / localhost unless `pairing_allow_public`; `pairing: false` turns it off; every step audit-logged
- The legacy config token still works; Settings > Devices offers a one-tap "Upgrade to a device token"
- mDNS TXT carries only id, name, version, pairing/tls flags, port and LAN IPs (never secrets)

## Real-Time Monitoring
- **Stuck-session detection** ("Out4 looks stuck"): deterministic, no LLM, only while a session is WORKING. Flags the same failing test / compiler error / error output recurring (5 times in 30 min, numbers, paths and timestamps normalised; `| tail` exit codes do not hide failures), the same tool call with the same result again and again with no edit in between (5 in 15 min; polling commands exempt), an edit undone and redone on the same spot (4 moves in 30 min), no edit or new text for 30 min, and a tool call hanging with an unchanged screen (Bash 20 min). Builds, installs, test suites and subagents are exempt up to 90 min; a prompt on screen is the inbox's job. Findings clear on their own when the session recovers, finishes, or the user writes to it
- Stuck UI: amber "Stuck?" badge in the sidebar and mobile list; a dismissible banner in the session with the summary, expandable evidence (redacted), Ask what's wrong, Interrupt (Herald's cancellable countdown), Snooze 30m and Not stuck (quiet for the rest of that turn). Settings > Notifications: on/off, no-progress minutes, per-signal thresholds under Advanced; quiet hours keep it silent
- Herald knows: a stuck item in the inbox with its own soft tone on the active device (never spoken unasked; Gaming plays the tone only), "brief me" says "Out4 looks stuck: same test failing 6 times.", "is anything stuck?" / "what's Out4 stuck on?" (`stuck_sessions`), "ignore that for 30 minutes" (`snooze_stuck`), and ask / interrupt / show through the usual guarded actions
- Live WebSocket updates from CLI coding sessions
- Multi-server, multi-session support
- Multiple concurrent sessions per project directory with automatic disambiguation (terminal content matching, PID detection, process of elimination)
- Session mapping persistence across daemon restarts (`~/.claude/companion-session-mappings.json`); each mapping remembers the session identity (tmux creation time, pane pid, claude pid), so a reused tmux name or a restarted claude gets a fresh transcript instead of the old one
- Project paths with dots, underscores or spaces (`~/.cache/...`) link to their transcripts (Claude Code's project dir encoding: every non-alphanumeric becomes `-`)
- Event-driven compaction re-mapping when context compaction creates new JSONL files
- Conversation chains (infinite scroll across a session's transcripts) are ordered by each file's first entry with the live conversation always last; a short side transcript (e.g. `/login` run inside a live claude writes its own file) never takes over the mapping or renders after the newest message, and a command-only file adds no "Previous session" divider
- Slash commands run directly in the CLI (`/login`, `/model`, `/clear`) render as a quiet "Ran /login · Login successful" marker (short output only); `<local-command-caveat>`/stdout/stderr tags are never shown, and Herald does not treat them as prompts
- ExitPlanMode and AskUserQuestion detected as "waiting for input" (triggers status banner, push notifications)
- Pending multiple-choice AskUserQuestion prompts render as tappable options in the Chat view — these are buffered by Claude Code and never hit the session JSONL until answered, so the live tmux pane is scraped and surfaced as a synthetic live highlight
- Session status indicators (waiting, working, idle)
- Sub-agent tracking with expandable tree view (status icons, activity, duration, message count)
- Click-to-view sub-agent conversation detail
- Running/completed agent sections with collapsible completed list
- Optimistic sent message display — messages appear immediately in chat before server acknowledgement, including terminal-mode sends
- Direct message sending (no queue) — messages send immediately regardless of session state

## Mobile Input
- Send text and images to the CLI from your phone
- **File attachments (any type):** attach images or arbitrary files (PDF, text, JSON, CSV, etc.) — images send as `[image: ...]` markers, non-image files are uploaded to the daemon and referenced with a "Read the attached file at ..." instruction
- Non-image attachments render as a labeled file chip (name + size); images keep the thumbnail preview
- Mobile attach menu (Photo Library / Camera / Files) with distinct native pickers; desktop/browser uses a single file picker
- Attachment size cap enforced on both client and daemon (50 MB), with sanitized on-disk filenames (path-traversal safe)
- Quick reply chips and slash commands
- Multi-question answering with per-question selection and "Other" freetext
- Multi-select checkbox UI for questions that allow multiple answers with send-in-flight guard (buttons disabled, "Sending..." text during async submit)
- Undo history for recovering cleared or sent input
- **Native choice selection:** approval prompts and AskUserQuestion options send key sequences (arrow keys + Space/Enter) instead of text, matching the CLI's interactive selection UI
- Image paste and drag-and-drop in terminal mode (sends via normal image upload path)

## Skill Browser & Slash Commands
- Type `/` in the input bar to see an autocomplete menu of skills, quick actions, and CLI built-ins
- Three sections: **Skills** (from `.claude/commands/`), **Quick Actions** (/yes, /no, /continue, /approve, /reject, /skip, /cancel), **CLI Built-ins** (/help, /clear, /compact, /status, /review)
- Keyboard navigation: Arrow keys, Enter/Tab to select, Escape to dismiss
- Quick actions send immediately; skills and built-ins insert the command for confirmation
- Skill Browser accessible from Settings: browse a catalog of 14 universal skills across 5 categories
- Install skills to project (`.claude/commands/`) or globally (`~/.claude/commands/`)
- Daemon scans installed skills and merges with built-in catalog
- Categories: Workflow, Development, Git, Operations, Search

## Dashboard
- Multi-server overview with connection status
- Grid/dashboard mode toggle for card-based monitoring view
- Split view — right-click a session to open side-by-side, close button on divider (desktop only)
- Session cards showing current activity and task progress
- Expandable task list per session with status indicators
- Task detail screen with full metadata and dependencies
- Kill sessions directly from dashboard with confirmation
- Create new sessions with redesigned wizard: unified path input, instant-create from recents, full-screen mobile sheet
- Quick navigation to any session
- Server enable/disable toggles
- Server cards disabled when no active sessions
- Mobile: full-screen scrollable server/session list with status badges
- Desktop: sidebar with session list + session view side-by-side

## Conversation Viewer
- Markdown rendering in assistant messages (headings, tables, task lists, code blocks with language labels, links)
- User messages rendered as plain text
- Compacted conversation rendering as markdown with expand/collapse toggle
- Expandable tool cards with inputs/outputs
- Smart tool card collapsing with tool name chips and grouping
- Skill tool cards: compact "Skill: {name}" header, collapsed by default, markdown-rendered output when expanded
- Line numbers and language labels on Write/Edit views
- Expandable diff view with "Show all" toggle (40-line default)
- Graceful fallback rendering for unknown tool types
- Full-screen message viewer for long responses
- Activity counters (tokens, cache hits)
- Inline auto-approve toggle in session header
- Text search across session history with match highlighting and prev/next navigation
- Cross-session infinite scroll (chains JSONL files by creation time)

## File & Artifact Viewer
- Open files referenced in conversation with a single tap/click
- Markdown files rendered with full formatting (headings, tables, lists, code blocks, links)
- Diff files rendered with color-coded additions/deletions/hunks
- Syntax highlighting for 22 languages via highlight.js (GitHub Dark theme)
- Code files rendered with line numbers, horizontal scroll, and sticky line numbers
- Progressive rendering for large files (3000 lines at a time with "Show more")
- Image file rendering (PNG, JPG, GIF, SVG, WebP, ICO) via base64
- Binary file detection with size display
- Fuzzy file finder (Cmd+P) with debounced search, keyboard navigation, match highlighting, session-scoped project root
- "Files" button in session header for quick access to file finder
- Large assistant messages (100+ lines) get "View full output in viewer" button
- Artifact viewer modal for inline content with copy-to-clipboard
- Persistent file tab bar (web) with per-session localStorage persistence
- File path detection in inline code and message text
- Navigate between files via tappable links within the viewer
- APK download and install support on Android

## Plan Viewer
- Detect plan file references in conversation (ExitPlanMode/EnterPlanMode tool calls)
- Plan cards rendered inline for ExitPlanMode with "View Plan" button
- Approve/Reject buttons on pending plan cards (sends "yes"/"no" directly from app)
- Plan file path fallback for pending tools (uses latestPlanFile when tool output not yet available)
- Plan button in session header when a plan file is detected
- Plans open in the file viewer with full markdown rendering

## Push Notifications
- FCM-based push notifications when the CLI needs input
- **In-app notifications:** when the tab is focused, emits custom events so the sidebar shows inline indicators instead of suppressing silently
- **Session attention badges:** amber pulsing dot on sidebar sessions that transition to "waiting" while not actively viewed, clears when session is selected
- 2-tier escalation: browser notifications immediately, push after configurable delay
- Consolidated notifications batching multiple pending events into one push
- Quiet hours scheduling
- Per-server notification preferences
- Per-session mute synced between web and mobile via daemon
- Rate limiting to prevent notification storms

## Tmux Session Management
- Create/list/switch tmux sessions from app
- Git worktree support: branch sessions for concurrent editing on the same repo
- Worktree cleanup on session kill
- Directory browser for project selection
- Session recreation for missing sessions
- Auto-detect the CLI in tmux
- Session scoping: only monitors sessions created/adopted by the app (env var tagging)
- Interactive terminal mode: keyboard capture sends keys directly to tmux (arrow keys, enter, ctrl combos)
- Faster polling when terminal is active

## Project Scaffolding (New Project Wizard)
- Multiple stack templates (React, Node, Python, Go, Next.js, MUI)
- Auto-generated CLAUDE.md with project-specific instructions, tracking files workflow, task management, and interaction guidance
- Standard slash commands (.claude/commands/) tailored per stack: /up, /down, /todo, /plan, /work, /test
- Git initialization and GitHub repo creation
- Template variable interpolation
- Progress tracking during creation
- **Auto-kickstart sessions:** `scaffold_open_session` endpoint creates tmux session, polls for CLI readiness, then injects initial message describing the project and asking Claude to create a task list
- **File viewer on done screen:** clickable file names in the created-files tree open FileViewerModal for immediate inspection
- **Session selection fix:** passes tmux session name directly instead of unreliable path-based lookup

## Conversation Archive
- Save completed conversation summaries
- Browse and search past conversations
- Per-server archive organization
- Clear all archives

## API Usage Analytics
- Token usage breakdown per session
- Cache hit/miss metrics
- Daily and monthly usage tracking

## Server Setup
- QR code scanning for quick setup
- Token-gated QR code page (enter token first, then see QR + web client link)
- mDNS/Bonjour discovery
- TLS support for secure connections
- Token-based authentication

## Terminal Output Viewer
- Raw tmux terminal output display with ANSI color rendering
- Unified input bar for both chat and terminal modes
- SSH command display with tap-to-copy (mobile) and click-to-copy (web)
- Scroll-position-aware auto-scroll: pauses when reading, resumes at bottom
- Auto-refresh polling with pause/resume toggle
- Horizontal scroll for long lines
- Font size zoom controls (mobile)
- Pull-to-refresh (mobile) and manual refresh button (web)
- Accessible from session header via button or Cmd+T shortcut
- Infinity scroll with offset-based paging for terminal history

## Dispatch Panel (Subagents)
Prominent bottom drawer panel showing subagents as first-class UI, replacing the old modal-based SubAgent components.

- Auto-shows when agents spawn (runningCount 0 → >0, desktop only), auto-collapses ~3s after all agents finish
- Desktop: collapsed bar always visible when agents exist (status dot + count + expand arrow), click to reopen
- Two-line agent cards: Row 1 = status dot + slug + duration, Row 2 = description + message count + chevron
- Status dots: pulsing green = running, blue = completed, red = error
- Click-to-drill-down into agent conversation detail with back button
- Resizable via draggable divider (height persisted to localStorage)
- Mobile: collapsed bar at bottom → full-screen overlay on tap (no auto-maximize)
- Mobile dispatch overlay integrated with Android back gesture (swipe back closes overlay)
- Completed agents expire from tree after 5 minutes (was 30)
- Adaptive polling: 2s when agents running, 5s when idle
- CLAUDE.md instructions for dispatch mode included in all scaffold templates

## Tiled Agent Conversations
Dispatch panel shows agent conversations tiled side-by-side on desktop instead of card list + single detail view.

- Each tile independently fetches and renders its agent's conversation
- Status dot (green pulse/blue/red) + slug header per tile
- Equal-width tiles with min-width 280px, horizontal scroll for 5+ agents
- Auto-scrolls to latest messages
- Mobile unchanged: card list + detail overlay

## Permission Bypass Toggle
File-based permission bypass that works for all sessions and subagents in a project, replacing the old tmux-injection auto-approve.

- "Bypass: ON/OFF" button in session header (desktop) and bottom bar (mobile)
- Writes `.claude/settings.json` with `defaultMode: bypassPermissions` to the project directory
- Works for all Claude Code sessions and subagents in the project (file-based, not process-specific)
- Daemon endpoints: `set_bypass_permissions` and `get_bypass_permissions`
- Scaffold wizard includes "Bypass permission prompts" checkbox (default on)
- All 7 scaffold templates include `.claude/settings.json` with bypass enabled
- Keyboard shortcut: Cmd/Ctrl+Alt+Shift+A

## Auto-Approve System
- Automatic approval of safe tool calls (Read, Glob, Grep, etc.)
- "Always Allow" option on pending approval prompts
- Auto-expand pending tool approval cards
- Tool-ID-based deduplication: each unique tool use UUID is approved exactly once, preventing "yes" spam when tools remain pending
- Fuzzy tmux session path matching
- Retry logic for failed approval sends
- Detailed logging for debugging approval flow

## Session Header
- Connection status dot in header (green/yellow/orange/red)
- Unified activity bar combining processing and agent status
- Agents bar togglable via session settings
- Long-press tooltips on all header icons
- Inline auto-approve toggle

## Connection Resilience
- Dead WebSocket detection via readyState verification
- Automatic reconnection on silent WiFi drops
- Session state recovery after reconnection
- Double-connect guard prevents orphaned sockets
- Exponential backoff reconnection with configurable max attempts
- Zombie-socket detection on app resume: `checkAlive()` probes "connected" sockets that went silent while backgrounded and force-reconnects stale ones
- Outbound send queue: input composed during a brief reconnect window is queued (capped at 100) and delivered after re-auth instead of being dropped
- Tolerant liveness: 60s pong timeout with 2 missed-pong windows before a forced reconnect; daemon sends native WS pings every 30s so browsers auto-answer
- Backoff hardening: once-per-drop disconnect latch, and the attempt counter only resets after 30s of stable uptime so flapping links keep widening their backoff
- Non-blocking daemon I/O: tmux calls (async `execFile` with timeout + SIGKILL) and JSONL reads (`fs.promises`) no longer stall the event loop past the pong window

## Web Client Keyboard Shortcuts
- Cmd/Ctrl+P: Fuzzy file finder
- Cmd/Ctrl+T: Toggle terminal panel
- Cmd/Ctrl+F: Search messages in session
- Cmd/Ctrl+1-9: Switch to session by sidebar position
- Cmd/Ctrl+Shift+A: Toggle auto-approve
- Cmd/Ctrl+Shift+M: Toggle session mute
- j/k or Arrow keys: Navigate sessions in sidebar
- /: Focus input bar
- ?: Toggle shortcut help overlay
- Escape: Close modal/panel/search (priority-ordered)
- Auto-focus textarea on desktop (re-focuses after any blur)

## Desktop App (Tauri 2.0)
- Native apps for macOS, Linux, and Windows wrapping the web client
- Custom menu bar: Companion, File, Edit, View, Window menus with keyboard shortcuts
- System tray icon: click to toggle window, right-click for Show/Quit menu
- Close-to-tray: closing the window hides to tray instead of quitting
- Tray tooltip shows count of sessions waiting for input
- Native OS notifications (macOS Notification Center, Linux libnotify)
- Window state persistence: remembers position and size across launches
- Auto-launch on login toggle in settings
- Builds to .app/.dmg (macOS), .deb/.AppImage (Linux), .msi (Windows)
- Herald floating orb: no menu bar on Windows/Linux, shown only during Herald activity (plus a short linger), never when "Show floating orb" is off (Gaming profile default), self-heals after reloads, races and stuck flags; tray "Hide floating orb" / "Show floating orb"
- Herald "show me ... on my PC": device words resolve by each device's reported platform (OS, native vs browser), not just its label; asks "Which one, A or B?" on a tie and says "I don't see a PC connected." instead of falling back to the active device
- "Use Herald here? Take control": one dismissible nudge per session when Herald is used on a device that is not active

## Mobile App (Tauri 2.0)
- Android APK and iOS IPA built from the same web codebase
- FCM push notifications via custom Tauri plugin (tauri-plugin-fcm)
- Safe area insets for edge-to-edge display on Android
- Android back gesture support (navigates session -> dashboard -> settings)
- Bottom action toolbar on mobile (terminal, auto-approve, mute, plan, history)
- Full-screen mobile dashboard replacing sidebar navigation
- Camera access for QR code scanning

## Daemon CLI
- `bin/companion` — top-level entry point, auto-builds daemon + web client when stale
- `companion start` — background start with PID file, already-running detection, 1-second liveness check
- `companion start -f` — foreground start for debugging
- `companion setup` — first-time wizard: creates config, generates token, prints connection info with QR code
- `companion autostart enable/disable` — manages systemd user service (Linux) and launchd agent (macOS)
- `companion status` — show running state, PID, tmux sessions, config summary
- `companion stop` — graceful shutdown via PID file
- `companion config` — view/set config values
- `companion logs` — platform-aware log viewing (macOS launchd / Linux journalctl / `~/.companion/daemon.log`)
- Robust build detection: only rebuilds when source files are newer than build output
- Platform-aware log locations: `~/Library/Logs/companion.log` (macOS), `~/.companion/daemon.log` (Linux)

## Parallel Work Groups
- Spawn multiple Claude Code sessions in parallel from `/work` command
- Each worker runs in its own git worktree on a dedicated branch
- Foreman session orchestrates workers and handles sequential items
- Worker lifecycle management: spawning, working, waiting, completed, error states
- Inline question answering: respond to worker questions without switching sessions
- Octopus merge of completed worker branches with conflict detection
- Cancel/retry controls for individual workers or entire groups
- Per-server toggle to disable parallel worker spawning
- Web dashboard: sidebar nesting with tree connectors and progress bars
- Web dashboard: WorkGroupPanel with worker cards, merge/cancel controls
- Mobile dashboard: expandable work group cards with worker sub-cards
- Push notifications for worker questions, errors, and group completion
- State persistence across daemon restarts
- Worker prompt injection with scoped task instructions

## Visual Theme
- Blue-to-purple gradient headers across all screens (mobile + web)
- Gradient primary action buttons (blue to purple)
- Tinted card backgrounds with accent left borders
- Purple focus glow on input fields (web)
- Gradient progress bars for tasks and work groups
- Purple accent text and gradient headings
- Centralized color system (web CSS variables)
- Consistent dark theme with vibrant accent hierarchy

## Theme Presets
Switchable color themes with 5 curated presets, CSS variable architecture, and flash-free persistence.

- 5 theme presets: Midnight (default blue/purple), Ocean (teal/cyan), Forest (emerald/green), Warm (amber/orange), Rose (pink/magenta)
- Each preset overrides all CSS variables: backgrounds, text, accents, borders, gradients, focus glows
- Theme selector in Settings with color swatch preview cards and active indicator
- ThemeContext provider with `useTheme` hook for app-wide theme state
- Flash prevention: inline script in `<head>` reads localStorage and applies theme class before first paint
- Persists to localStorage (`companion_theme`); Tauri mobile also writes to tauri-plugin-store
- Phase 1 refactor: replaced ~67 hardcoded hex colors in global.css and ~40 inline style colors across 5 components with CSS variable references
- All themes maintain WCAG AA contrast ratios for text readability

## Developer Tools
- Sentry error tracking integration
- Error boundary with user feedback and bug reporting
- Centralized tool configuration (daemon/src/tool-config.ts)
- Structured parser warnings for unknown tools and entry types
- Build date and version info in settings
- Scroll behavior analytics
- Client error reporting
- Management scripts in `bin/` with usage headers and dep checks (companion, build, build-all, build-apk, deploy, dev, test)

## Away Digest
Summary card on the dashboard when returning after inactivity, showing what happened while you were away.

- "While you were away" banner with relative time and event summary
- Groups events by session: completed, waiting, errors
- Per-session rows with status icons and preview text
- Dismissible with fade-in animation and per-away-period persistence (won't re-show on subsequent re-focuses)
- 2-minute minimum away duration to avoid noise on brief tab switches
- Only shows for urgent events (waiting_for_input, error_detected, worker_waiting, worker_error)
- Fetches from daemon notification history (persisted to disk)
- Works on both mobile and desktop dashboards

## Cost Dashboard
Full-screen usage and cost analytics with daily tracking and budget alerts.

- Stat cards: total cost today, this week, this month
- Daily usage bar chart (7-day or 30-day view)
- Per-model token breakdown (when Anthropic admin API key configured)
- Per-session cost estimates with USD amounts
- Configurable budget thresholds with push notification alerts
- Daemon-side daily snapshot persistence (90-day history)
- Accessible from settings navigation

## Usage Dashboard
Real-time utilization gauges using Claude Code OAuth credentials — no admin API key required.

- CSS conic-gradient gauge rings for 5-hour and 7-day utilization windows
- Color-coded thresholds: green (<50%), amber (50-75%), red (>75%) with glow effect
- Live countdown timers showing time until rate limit resets
- Subscription tier badge (MAX, Pro, etc.)
- Model-specific utilization bars (Opus, Sonnet, Cowork) when available
- Extra usage credit tracking card
- Collapsible cost breakdown section (reuses existing admin-key cost dashboard)
- Configurable threshold notifications (50%, 75%, 90%, 95%) with push escalation
- Daemon polls every 3 minutes with 3-minute cache; web auto-refreshes
- Graceful fallback when OAuth credentials not available

## Code Review 2.0
"What changed since I looked?" across sessions, with risk flags, per-turn summaries, ask-why and safe reverts. Plan: `docs/code-review-2-plan.md`.

- **Transcript ledger:** turns and exact per-edit hunks from Claude Code's JSONL (`structuredPatch`), read incrementally from byte offsets (no subprocess per update, works outside git, survives `/clear` chains); subagent edits attributed to the turn that spawned them
- **"Since you looked" checkpoints** per session (persisted, multi-device, `updatedBy`); mark all reviewed or approve single turns (approvals stay reversible; mark all reviewed folds them in); global `review_summary` events at most once a second per session. A mark sticks: it is sent for the session it was made in even if you switch sessions, close the drawer or background the app inside the 5 s undo window, marks through the server's `computedAt` (no device clock skew), and re-bases the net view so nothing already shown comes back; a failed mark says so
- **Unattributed changes are their own count** (`unattributedFiles`): repo changes no transcript claims (shell commands, other programs) show as a quiet "N other" on the strip, never as the session's unreviewed files, are cleared by a mark, and changes another session's tools made are never listed as this session's
- Ledger reads are bounded per pass, not per lifetime: sessions with 100 MB+ of subagent transcripts keep attributing new edits
- **Free turn summaries** ("Fixed echo guard: 3 files, +42 -18") from the reply, prompt or files; optional Herald-polished gists (`review_polish_summaries`, one batched call, cached, metered)
- **Net "by file" view** via checkpoint snapshot trees (temp index, never touches the user's index or refs): renames, binary, mode changes, deletions, heat ordering, trivial collapse (whitespace / lockfile / generated), lazy hunks, and an **unattributed** section for Bash-made changes; gitignored and non-git files fall back to per-edit transcript hunks
- **Risk flags** (pure `classifyChangedFile`): migrations, CI / deploy scripts, env files, secrets (paths and secret-looking added lines), agent / git hook config, permissions, auth / security code, deletions, config, dependency changes, large rewrites, lockfiles, binary, outside project, other sessions touching the same file
- **Ask why** on any hunk: sends the hunk + turn context to the session (through Herald's ask-and-report when enabled, so the answer comes back in the Herald inbox); refuses while a choice prompt is on screen
- **Revert** a hunk (works outside git) or a whole file (to HEAD or the checkpoint): preview with the exact patch, echo (tap) vs hold-to-confirm tiers, tokens bound to the connection, CAS write with backup, 10-minute undo, audit log, "[Companion] I reverted ..." note to the session; refused in the sandbox, for staged files, other sessions' changes, binary / > 2 MB files
- **Live edit stream** (`review_watch` / `review_live`) for the drawer's live feed
- **Herald:** `review_changes` tool ("what did Out4 change?", grounded, risky first, at most three files named), high-risk changes as quiet inbox news (deduped 30 min, coalesced 20 s, resolved when you mark the session reviewed)
- **Bounded git everywhere:** one GitRunner (no shell, SIGKILL timeouts, dedupe, concurrency 3, breaker); legacy `get_session_diff` rebuilt on it (no more shell per file; untracked new files no longer dropped)
- Web client: change strip, review drawer (by turn / by file), inline edit chips (with tool cards hidden: a "3 files changed · +12 −3" row under the assistant message, expandable to per-file chips and hunks), risk badges, revert dialog with undo, live feed and risk tone (see the plan's web workstream). The drawer owns the keyboard while open: focus moves into it (Tab stays inside, focus returns on close), the composer never grabs focus back (and on phones never pops the keyboard), its shortcuts work, typing in its own fields stays text, and the j/k position has a visible ring

## Mobile Session Context Menu
Long-press or right-click on a mobile session to get a full context menu.

- Open in Split, Rename, Mute/Unmute, Kill Session actions
- Replaces old inline kill-confirm UI with proper ContextMenu component
- Matches desktop sidebar context menu feature parity

## Session Jump Hotkeys
Keyboard shortcuts for fast session switching on desktop.

- Hold Ctrl/Cmd+Alt to show numbered badges (1-9) on sidebar sessions
- Ctrl/Cmd+1-9 jumps to session by position (existing)
- Ctrl+Tab / Ctrl+Shift+Tab cycles through recently used sessions (MRU)
- Jump badges animate in with scale effect
- MRU list maintained per session (resets on page reload)
- Documented in shortcut help overlay (?)

## Session Renaming
User-assigned friendly names for sessions, replacing cryptic tmux session IDs.

- Right-click "Rename" in both desktop sidebar and mobile context menus
- Friendly names persisted on daemon at `~/.companion/session-names.json`
- Display friendly name everywhere: sidebar, mobile dashboard, session cards
- Falls back to tmux session name / project path if no friendly name set
- Real-time broadcast to all connected clients on rename
- Clear friendly name by entering empty string

## Git Integration Toggle
Configurable `git` boolean in daemon config that gates all git-dependent behavior.

- `"git": true/false` in daemon config (default: true)
- Daemon sends `gitEnabled` to web clients in auth response
- When disabled: code review shows JSONL file changes without diffs, worktree/work-group endpoints return errors/empty
- When enabled: code review filters out already-committed files (no remaining diff and tracked by git)
- Web UI hides parallel workers toggle and work group controls when git is disabled
- Backward compatible: older daemons without the field default to enabled

## Mobile Toolbar Layout
Split mobile session toolbar across header and footer to prevent overflow.

- View/action buttons (Files, Search, Plan, Review) moved to mobile header alongside Back button
- Operational buttons (Cancel, Notify, Auto, Tools, Terminal) remain in bottom bar
- Desktop layout unchanged — all buttons in header
- Reduces bottom bar from up to 8 buttons to max 5

## Tool Card Visibility Toggle
Per-session toggle to show or hide tool call cards in conversation view.

- "Tools: ON/OFF" button in bottom bar (mobile) and header (desktop)
- When hidden, tool cards are completely removed from the DOM for cleaner reading
- Pending tool cards always shown (require user action like approval)
- ExitPlanMode cards always shown regardless of toggle
- State persisted per session in localStorage

## Skeleton Loading Screens
Shimmer placeholder cards for loading states instead of spinners.

- Animated skeleton cards for dashboard, sidebar, and session views
- Shimmer gradient animation with CSS keyframes
- Replaces generic spinners with layout-aware placeholders matching final content shape

## Split Snap Layouts
Draggable divider with snap zones for split-view session arrangements.

- Snap zones at 33%, 50%, and 67% width splits
- Visual snap zone indicators appear when dragging near thresholds
- Smooth snapping animation with configurable dead zones
- Persistent split ratio per session in localStorage

## Vite Code Splitting
React.lazy loading for modals and routes to reduce initial bundle size.

- Main chunk reduced from 498 KB to 332 KB
- Lazy-loaded: modals, usage dashboard, and heavy route components
- Suspense boundaries with skeleton fallbacks during chunk loading

## WebSocket Handler Modules
Daemon websocket.ts split from monolithic 4,386-line file into focused handler modules.

- Main websocket.ts reduced to 522 lines (routing + connection management)
- 8 handler modules: files, input, notifications, session, skills, tmux, usage, workgroups
- Shared handler context type for consistent dependency injection
- No behavior changes — pure refactor

## Disconnected Server Persistence
Servers remain visible in sidebar when offline instead of disappearing.

- Disconnected servers shown grayed out in sidebar and dashboard
- Connection status indicators (green/yellow/red) reflect live state
- Server summary data cached from last successful connection
- Reconnection attempts continue in background

## Agent Dismissal
Dismiss completed agents from the dispatch panel with auto-reappear on new activity.

- Dismiss button on completed agent cards in dispatch panel
- Dismissed agents reappear if new activity is detected
- Dismiss state tracked per agent, resets on new messages
- Works in both desktop tiled view and mobile card list

## Standalone Conversation Parser
Extracted the JSONL conversation parser into a standalone npm package at `/home/hexi/local/src/claude-conversation-parser/`.

- 17 exported functions: parseConversationFile, extractHighlights, detectWaitingForInput, extractTasks, extractFileChanges, getSessionStatus, and more
- 10 exported types: ConversationMessage, ToolCall, SessionStatus, TaskItem, FileChange, etc.
- Ships with Claude Code tool definitions (approval requirements, display names, summary fields)
- Zero dependencies beyond Node.js built-ins and TypeScript
- Reusable across any project that needs to read Claude Code conversation logs

## Test Suite
Comprehensive automated tests for daemon parser and web client services.

- **Daemon parser:** 96 tests across 13 functions (parseConversationFile, detectWaitingForInput, extractHighlights, detectCurrentActivityFast, detectIdle, detectCurrentActivity, getSessionStatus, getPendingApprovalTools, detectCompaction, extractUsageFromFile, extractFileChanges, parseConversationChain, getRecentActivity)
- Inline JSONL fixture builders for readable, maintainable test data
- **Web client:** Vitest + @testing-library/react + jsdom infrastructure
- ServerConnection tests (23): connection lifecycle, auth handshake, reconnection, request/response matching, message handlers, config updates
- ConnectionManager tests (14): multi-server management, snapshots, connect/disconnect, change handlers

## UX Paper-Cut Round (2026-04-29)
Batch of 11 fixes targeting friction points across session view, dashboards, costs, and platform-specific behaviors. Net -786 lines across 19 files.

- **Blank chat on session open fixed** — `MessageList` filter moved into `useMemo([highlights, hideTools])`; `SessionView` `hideTools` refactored to derived-state-during-render (was a stale-frame `useEffect` resync)
- **Stale disconnect errors cleared on reconnect** — `ServerConnection` emits `onReconnect` (with `hasConnectedBefore` flag, no double-fetch on initial mount); `useConversation` subscribes and refetches → clears red error banners
- **Agent button moved to header** — relocated from `dispatch-collapsed-bar` to header right pill for visibility
- **Voice input removed entirely** — deleted `VoiceMode.tsx`, `useSpeechRecognition.ts`, `useTextToSpeech.ts`, `useVoiceMode.ts`, `ttsPrep.ts` (~240 CSS lines too); Android `RECORD_AUDIO` / `MODIFY_AUDIO_SETTINGS` permissions removed
- **Settings modal** — new `SettingsModal.tsx` triggered from header gear icon; houses Notify/Bypass/Tools toggles. Hooks still owned by SessionView, modal is presentational
- **Bars on one row** — WaitingIndicator + WorkGroupBar wrap in flex container, 50/50 desktop, stacked at ≤768px, hidden when empty
- **New session redesign** — `NewSessionPanel` rewritten with segmented Recent/Browse tabs; per-path scrollTop cache (Map ref) restores position on back-nav; last tab persisted per server in localStorage `new-session-tab:<serverId>`
- **Scroll-jump diagnostics (telemetry only)** — new `scrollDebugger.ts` singleton (500-event ring buffer, FIFO, CSV export, gated on `localStorage.scroll-debug-enabled === 'true'`); new `ScrollDebugPanel.tsx`; 8 record sites in `MessageList`; hotkey Cmd/Ctrl+Alt+Shift+D in SessionView
- **Copy/link context menu** — removed broken "Copy selection" (only copied first word; long-press drag-select branch and `selectedText` state were dead); added "Open Link" before "Copy link" for detected URLs
- **"What's New" / AwayDigest removed** — `AwayDigest.tsx` + `useAwayDigest.ts` + CSS + `companion_last_active` storage key all gone. Daemon `get_digest` endpoint kept (referenced by a test)
- **Cost dashboard pricing fix** — root cause: existing `claude-opus-4-6-20260210` entry had Opus-3-era pricing ($15/$75) which silently undercharged via partial-match. Added base names `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6` at correct rates ($5/$25 / $5/$25 / $3/$15); Haiku 4.5 corrected ($0.80/$4 → $1/$5); bidirectional segment-based partial-match; on miss: `console.warn` once + return zero rates (visible $0 instead of silent undercharge); tokenizer warning banner for Opus 4.7

## Cross-Daemon Dispatch (companion-remote MCP)
MCP server that lets Claude on one Companion box dispatch work to Claude on another, routed through each machine's daemon. See `mcp/` and `daemon/src/handlers/remote.ts`.

- `remote_dispatch` spawns a tmux session + Claude on a remote daemon and injects the prompt, returning `{ tmuxSessionName, sessionId }` once the JSONL file is observed
- **Prompt-readiness poll:** daemon polls `tmux capture-pane` for Claude's startup markers (prompt glyph, "for shortcuts", etc.) up to 10s before injection instead of using a fixed 500ms sleep — prevents lost keystrokes when the REPL hasn't finished initializing
- **`oneShot: true` mode:** launches `claude -p "<prompt>"` directly as the tmux window command so the session auto-terminates when Claude finishes responding — no zombie sessions for fire-and-forget prompts
- Read-only tools (`remote_read`, `remote_get_conversation`, `remote_list_servers`) and destructive tools (`remote_exec`, `remote_write`, `remote_send_input`, `remote_cancel`) gated per-daemon via `remote_capabilities` config
- Append-only audit log at `~/.companion/audit.log` with rotation, surfaced via `get_audit_log` handler
- Transport hardening: destructive ops refuse non-loopback / non-TLS connections unless explicitly marked `trustedNetwork`
- `bin/companion enable-remote` CLI for interactive capability configuration

## Mobile UX & Prompt-Handling Round (2026-06-09)
Batch of fixes across link handling, terminal-mode navigation/choices, multi-choice prompt detection, and mobile chat chrome, plus an orchestrator proof-of-concept.

- **Copy-link / Open-link reliability** — `cleanUrl` helper in `web/src/utils/urls.ts` with a widened trailing-punctuation regex (strips trailing `**`, brackets, quotes) and leading-junk strip; long-press "Open Link" / "Copy link" now resolve a clean URL in `MessageBubble.tsx` and `MarkdownRenderer.tsx`
- **Terminal-mode swipe-back fix** — `Dashboard.tsx` emits close-overlay through the shared `eventBus` instead of dispatching a raw DOM `window` event, so the Android back gesture reliably closes the terminal overlay
- **Wider multi-choice prompt detection** — `parser.ts` `parseTextChoicePrompt` now recognizes `1.` / `1)` / `(1)` / `❯` arrow / lettered list styles with false-positive guards; covered by new cases in `daemon/src/__tests__/permission-prompts.test.ts`. Web rendering hardened in `QuestionBlock.tsx` + `MessageBubble.tsx` (option normalization, empty `questions[]` handling)
- **Tappable terminal-mode choice overlay** — daemon detects an active `❯ N.` selector in the pane tail (`handlers/tmux.ts`, `types.ts`) and attaches a `choicePrompt` to `terminal_output`; new `web/src/components/TerminalChoiceOverlay.tsx` renders tappable options in `TerminalPanel.tsx` (web `types/index.ts` updated)
- **Mobile chat header buttons relocated** — header actions moved into the activity/processing row with a kebab overflow menu; new `web/src/components/SessionActionBar.tsx` + `HeaderOverflowMenu.tsx`, wired into the mobile branch of `SessionView.tsx`. Desktop layout unchanged
- **Hide Tools defaults ON** — `SessionView.tsx` `readHideTools` now treats absence as enabled (`!== '0' : true`), so tool cards are hidden by default for cleaner reading
- **Settings header safe-area hardened** — `global.css` uses `max(28px, calc(... + env(safe-area-inset-top)))` on `.form-header` and the settings modal header; overlay padding zeroed to avoid double-applying the inset
- **Orchestrator / concierge POC** — `docs/orchestrator-design.md`, `bin/concierge`, `bin/companion-sessions`, and a `concierge/` scaffold (`CLAUDE.md`, `projects.json`, `.mcp.json.template`); rendered per-machine `concierge/.mcp.json` is gitignored

## Global Concierge (cross-machine fan-out)
Per-server "C" button spawns/attaches a long-running concierge Claude session on that daemon's host; it fans your request out to real, resumable project sessions on ANY connected daemon via the `companion-remote` MCP, waits for each to finish, and relays one consolidated, per-project-attributed summary. Builds on the Cross-Daemon Dispatch MCP above.

- **Per-server spawn from UI** — "C" button in each server's action row (desktop sidebar + mobile dashboard); `concierge_open` attaches the existing `concierge` tmux session or spawns it (renders `concierge/.mcp.json` from template, launches `claude --dangerously-skip-permissions` in the concierge dir), then routes to a new `ConciergeView` (reuses the normal session message list / input bar)
- **Wait-and-aggregate routing** — concierge resolves each target's live sessionId, dispatches/sends, polls `isWaitingForInput` until each returns to waiting, fetches highlights, and relays ONE attributed summary (one line per project). Answers status-on-demand mid-flight without blocking; caps total wait and reports stragglers as "still working"
- **Auto-derived MCP registry** — `concierge_sync_mcp` writes `~/.companion/mcp-servers.json` (`0o600`) from the server list the app already knows, always including a `local` loopback entry and preserving manual entries by name — no hand-editing per remote daemon
- **Cross-machine session resolver** — new `remote_list_sessions` MCP tool proxies each daemon's `get_sessions`; with `cwd` it returns `resolved` = the newest matching live sessionId (the cross-machine `bin/companion-sessions`). Runs on the concierge host against the remote daemon's existing endpoint, so remote daemons don't need the new build just to be fan-out targets
- **Reliable dispatch handle** — `remote_dispatch` no longer races a 5s timeout to `null`: `resolveTimeoutMs` is threaded + clamped, the default resolve window raised, a `resolveSessionByTmuxName` fallback added, and `tmuxSessionName` is always returned as a last-resort handle
- **Per-origin tokens** — listeners may carry `origins[]` (`{origin, token, label?, capabilities?, disabled?}`); the app mints a per-concierge token and registers it via the audited, dispatch-gated `concierge_register_origin`. Per-origin capabilities intersect with the daemon's. Additive (the plain listener token still works) — backward compatible
- **TLS cert pinning** — `get_cert_fingerprint` WS endpoint (sha256 of the cert DER) lets the app store `certFingerprint` on a Server record; the MCP daemon-client compares `fingerprint256` on connect and rejects with `CertPinMismatch`. Optional/per-server — no fingerprint means today's behavior
- See `daemon/src/handlers/concierge.ts`, `mcp/src/tools/remote_list_sessions.ts`, `web/src/components/ConciergeView.tsx`, `concierge/CLAUDE.md`, and `NEXT_TIME.md` (rollout) / `/home/hexi/.claude/plans/purrfect-leaping-frost.md` (design)

## Mobile Header Refinement & Link Autolink (2026-06-09)
Follow-up fixes layered on the Mobile UX round above: walks back the activity-row header relocation in favor of a compact top button row, fixes a doubled status-bar inset, and makes URLs inside markdown emphasis tappable.

- **Compact top-row mobile header** — buttons now stay in a single top row (Back · Terminal · Plan · Bookmarks · Tools ▾ · gear); Files/Search/Skills/Review collapsed into a "Tools" dropdown. The `SessionActionBar` (which had moved buttons into the activity/processing row) was removed and the activity row is conditional again. `HeaderOverflowMenu.tsx` gained an optional `label` prop to render as "Tools ▾"; `web/src/components/SessionActionBar.tsx` deleted
- **Doubled header inset fixed** — `.dashboard` already applies `var(--safe-top)`, and `.session-header-mobile` was applying it again, creating an excessive top band. Inset now applied once plus a 6px gap (`global.css` mobile media queries)
- **Autolink URLs inside emphasis** — `MarkdownRenderer.tsx` previously stored bold/italic inner text as a raw string and never re-parsed it, so URLs inside `**…**` / `*…*` never became links. Bold/italic now carry children and recurse, so URLs (plus code/file links and nested emphasis) inside emphasis render as the accent link pill, enabling long-press → Open Link / Copy link

## Herald — "Hey Jarvis" in the desktop apps, Diagnostics, macOS shortcuts (2026-10-01)
- Fixed: hands-free in the Mac / Windows apps heard "Hey Jarvis" but never answered. With several servers the Herald hub connects after another one; the wake-word events stayed subscribed to the old connection, so every woken utterance was discarded. Subscriptions now follow the hub; a VAD misfire after the wake word still transcribes
- The desktop app keeps listening while its window is covered, minimised or in the tray (default on; webview background throttling and Windows occlusion off)
- Help > Diagnostics (or say "diagnostics"): live mic, level meter, echo canceller and ERLE, VAD, hands-free state and stand-down reason, speaking-elsewhere suppression, wake streaming and last score, asset status, active / speaking device, hub round trip, shortcuts and Input Monitoring; "Copy diagnostics" (redacted JSON)
- Hub logs wake streams, detections with scores and hands-free decisions (rate limited); herald-voice logs each stream's best score
- macOS shortcuts: ⌘⌥Space hold to talk, ⌘⌥⇧H toggle, ⌘⌥⇧B brief, ⌘⌥⇧S stop (never Control+Option); untouched old defaults migrate once; Mac key glyphs; a failed registration offers a free alternative in one click; button to open Input Monitoring settings

## Herald — cost control, offline fallback, hardened triggers (2026-09-30)
- Prompt caching of tools + system (~5.9K tokens) on Haiku 4.5: a warm turn costs roughly a quarter of an uncached one
- Usage meter in the Herald menu ("Today $0.04 · Month $1.10", turns, average per turn, cache hit rate) and an optional monthly budget (80% warning, fallback at 100%); "how much have you cost me" answered from the meter
- Fallback brain: when the API is down, out of credit, rate limited or over budget, Herald answers briefings, status and "what's waiting" from session data, says why once per outage, shows an offline badge and recovers on its own
- Per-device trigger tokens (create / list / rotate / revoke), mic-opening triggers only from the home network / tailnet (hairpin through the public domain counts as home), optional signed triggers (HMAC, 60 s, replay-guarded), distinct tone for remote listening

## Herald — quiet by default: voice commands, brevity, tones (2026-09-30)
- Local voice commands, whole-utterance only (1-5 words after fillers and "Herald"/"Hey Jarvis"): "stop", "repeat that" (replays cached audio), "shorter", "go on", "slower"/"faster", "what's up"; "stop the build" is still a message. Works for push-to-talk, talking over Herald and hands-free
- Spoken cap: at most two sentences / 40 words are read out, then "There's more on screen — say go on."; full text on screen. Setting: Spoken length Short / Full
- Voice-mode replies: spoken messages ask the brain for 1-2 short sentences (about 30 words); reply length setting Auto / Brief / Normal / Detailed stored on the hub (follows you across devices), also changed by saying "keep it short from now on"
- Herald never speaks up on its own: a signature tone (rising G-C-E; insistent for blocked, soft for finished) on one device only (the hands-free or most recently used one), optional reminder for unheard blocks. "Brief me" button, Ctrl+Shift+B, or "what's up" reads only what is new ("Nothing new." otherwise)
- Better recognition: session names and jargon are passed to Whisper as vocabulary hints (A/B on Kokoro clips: 20.6% -> 3.6% word errors, no added latency)
- Talking over Herald now works in hands-free mode (two fixes); Esc stops speech from anywhere on the page

## Herald — voice, Phase 2 (2026-09-30)
- Live on the production daemon (2026-09-30): Herald on Haiku over the anthropic provider, voice service runs as the `herald-voice` systemd user unit (`bin/herald-voice install-unit`, survives reboots)
- Neural voice: Kokoro TTS on a local voice service (`bin/herald-voice`, 127.0.0.1:9889), 27 English voices (default Heart), gapless per-sentence playback, falls back to browser voices per sentence if the service drops
- Push-to-talk: hold the mic button, Space in an empty composer, or Ctrl+Shift+Space (configurable); faster-whisper transcribes on release and sends (or drops it in the box for review)
- Interrupt by talking: Silero VAD stops Herald mid-sentence (client and server queues) and sends what you said
- Hands-free "Hey Jarvis": openWakeWord on the hub, audio sent only while someone is talking, chime on wake, one device at a time, always-visible indicator
- Browser never talks to the voice service; everything rides the authenticated daemon WS. `bin/herald-sandbox https` gives the sandbox a Tailscale HTTPS origin for the mic

## Herald — conversational front layer, Phase 1 (text) (2026-09-30)
- Fast, grounded chat over all coding sessions: "anything for me?", "what is X doing?", "tell X to go ahead"; brain is Claude Haiku (`claude-haiku-4-5`) via the Anthropic API, or any OpenAI-compatible local server (`herald.provider`)
- Deterministic inbox (blocked / finished) derived from session state; headlines are templated, never model-written; "heard" markers persist
- Actions never send directly: a pure danger classifier (deploy, push, prod, secrets, destructive, remote hosts, ...) picks echo (auto-sends after ~5s unless cancelled) or hard-confirm (press-and-hold, expires after 10 min); the model can only raise the tier; batches are classified per session
- Every send re-validates the live terminal right before typing (same prompt still on screen, never free text into a choice box, fails closed if the pane cannot be read)
- Web: docked desktop panel / full-screen mobile view, Ctrl/Cmd+J, streaming replies, inbox chips, countdown and hold-to-confirm cards
- Ops: `bin/companion install-secrets` (Infisical -> chmod-600 env file + systemd drop-in), `bin/companion herald-provider`, `bin/herald-sandbox` isolated test daemon (`COMPANION_SANDBOX=1`: no push, no auto-approve, shared state read-only)
