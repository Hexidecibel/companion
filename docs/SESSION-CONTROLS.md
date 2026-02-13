# Session Controls

Detailed guide to the conversation viewer, file browser, terminal, and other session-level controls.

## Conversation Viewer

The main session view renders a scrollable conversation between you and the CLI.

- **Markdown rendering** in assistant messages: headings, tables, task lists, code blocks with language labels, links
- **User messages** rendered as plain text
- **Compacted conversations** render as markdown with expand/collapse toggle
- **Expandable tool cards** with inputs/outputs, smart grouping by tool name
- **Skill tool cards**: compact "Skill: {name}" header, collapsed by default, markdown output when expanded
- **Diff view**: color-coded additions/deletions with "Show all" toggle (40-line default)
- **Line numbers and language labels** on Write/Edit tool views
- **Full-screen message viewer** for long responses
- **Activity counters**: tokens, cache hits
- **Graceful fallback** rendering for unknown tool types
- **Optimistic sent messages**: messages appear immediately before server acknowledgement
- **Direct message sending**: messages send immediately regardless of session state

### Text Search

`Cmd/Ctrl+F` opens a search bar across the current session's messages.

- Match highlighting with prev/next navigation
- Cross-session infinite scroll (chains JSONL files by creation time)

## File & Artifact Viewer

Tap any file path in a conversation to open it in the built-in viewer.

- **Markdown** files render with full formatting
- **Diff** files render with color-coded additions/deletions/hunks
- **Code** files render with syntax highlighting (22 languages via highlight.js, GitHub Dark theme), line numbers, and horizontal scroll
- **Images**: PNG, JPG, GIF, SVG, WebP, ICO rendered via base64
- **Binary files**: detected with size display
- **Progressive rendering**: large files load 3000 lines at a time with "Show more"
- **Fuzzy file finder** (`Cmd/Ctrl+P`): debounced search, keyboard navigation, match highlighting
- **"Files" button** in session header for quick access
- **Large messages** (100+ lines) get "View full output in viewer" button
- **Artifact viewer modal** for inline content with copy-to-clipboard
- **Persistent file tab bar** with per-session localStorage persistence
- **Navigate between files** via tappable links within the viewer
- **APK download and install** support on Android

## Plan Viewer

Plans are detected from `ExitPlanMode` / `EnterPlanMode` tool calls in the conversation.

- **Inline plan cards** for ExitPlanMode with "View Plan" button
- **Approve/Reject buttons** on pending plans (sends "yes"/"no" directly)
- **Plan button** in session header when a plan file is detected
- Plans open in the file viewer with full markdown rendering
- Path fallback for pending tools (uses `latestPlanFile` when output not yet available)

## Interactive Terminal

Toggle with `Cmd/Ctrl+T` or the terminal button in the session header/toolbar.

- **Raw tmux output** with ANSI color rendering
- **Keyboard capture** sends keys directly to tmux (arrow keys, enter, ctrl combos)
- **Unified input bar** for both chat and terminal modes
- **SSH command display** with tap-to-copy (mobile) and click-to-copy (web)
- **Scroll-position-aware auto-scroll**: pauses when reading, resumes at bottom
- **Infinity scroll** with offset-based paging for terminal history
- **Auto-refresh polling** with pause/resume toggle
- **Horizontal scroll** for long lines
- **Font size zoom** controls (mobile)
- **Pull-to-refresh** (mobile) and manual refresh button (web)

## Auto-Approve System

Automatically approve safe tool calls so the CLI doesn't block waiting.

- Approves read-only tools by default (Read, Glob, Grep, etc.)
- **"Always Allow"** option on pending approval prompts
- **Auto-expand** pending tool approval cards
- Composite key deduplication to prevent duplicate approvals
- Fuzzy tmux session path matching
- Retry logic for failed approval sends
- Toggle per-session via header (desktop) or bottom bar (mobile), or `Cmd/Ctrl+Shift+A`

## Tool Card Visibility Toggle

Per-session toggle to show or hide tool call cards for cleaner reading.

- "Tools: ON/OFF" button in bottom bar (mobile) or header (desktop)
- When hidden, tool cards are removed from the DOM entirely
- Pending tool cards and ExitPlanMode cards always shown regardless
- State persisted per session in localStorage

## Mobile Toolbar Layout

On mobile, session controls are split between header and footer to avoid overflow.

- **Header** (alongside Back button): Files, Search, Plan, Review
- **Footer** (bottom bar): Cancel, Notify, Auto, Tools, Terminal
- Desktop layout unchanged — all buttons in the header

## Session Header

- **Connection status dot**: green / yellow / orange / red
- **Unified activity bar** combining processing and agent status
- **Agents bar** togglable via session settings
- **Long-press tooltips** on all header icons
- **Inline auto-approve toggle**

## Code Review Mode

Consolidated diff view of all files changed by a session.

- Auto-triggers on session completion with review card in conversation
- Manual "Review" button in session header
- Git diff on server for accurate consolidated diffs (JSONL Edit/Write fallback for non-git dirs)
- Per-file diff stats (insertions/deletions) with expandable diff view
- "Looks good" to dismiss or "Request changes" to send feedback
- Full-screen modal with keyboard navigation (j/k, arrows, Enter, Escape)
- File list panel with diff viewer side-by-side (stacked on mobile)
- Auto-refresh on file changes via `conversation_update` broadcasts

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl+P` | Fuzzy file finder |
| `Cmd/Ctrl+T` | Toggle terminal panel |
| `Cmd/Ctrl+F` | Search messages in session |
| `Cmd/Ctrl+1-9` | Switch to session by sidebar position |
| `Cmd/Ctrl+Shift+A` | Toggle auto-approve |
| `Cmd/Ctrl+Shift+M` | Toggle session mute |
| `j` / `k` or Arrow keys | Navigate sessions in sidebar |
| `/` | Focus input bar |
| `?` | Toggle shortcut help overlay |
| `Escape` | Close modal / panel / search (priority-ordered) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle through recently used sessions (MRU) |
| `Ctrl/Cmd+Alt` (hold) | Show numbered jump badges on sidebar sessions |
