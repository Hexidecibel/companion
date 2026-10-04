# Implementation Plan

Detailed plans for upcoming work items. Completed items are moved to FEATURES.md.

---

## Item: Stuck-session detection ("Out4 looks stuck")
**Status:** done (live-verified on the probe; production needs a daemon restart)

Deterministic, no-LLM detection of sessions that are WORKING but going nowhere, with very low false positives.

### Signals (daemon `daemon/src/stuck/`, pure analysis over the parsed transcript of the current turn)
1. **repeated_failure**: the same failure signature (failing test names, compiler errors, error lines; numbers/paths/timestamps/hex normalised) >= 5 times in 30 min, spanning >= 2 min, with no later passing run of the same command.
2. **loop**: the same tool + normalised input + same normalised output >= 5 times in 15 min with no successful edit in between (polling tools / `sleep` / `watch` exempt).
3. **oscillation**: edits on the same file flipping between the same two states (A->B->A->B->A, 4 moves) in 30 min (Edit/MultiEdit old/new pairs, Write content hashes).
4. **no_progress**: working >= 30 min with no successful edit and no new assistant text; exempt while a Bash call is pending with a changing pane, or a known long command (build/install/test) or a subagent is pending, up to 90 min.
5. **stalled_tool**: one pending tool call older than its kind's cap (Bash 20 min, others 10 min; Task/Agent exempt) and the pane unchanged across two captures >= 4 min apart; a choice/approval prompt on screen = blocked (the inbox owns it).

### Design
- `StuckDetector` fed by watcher `conversation-update` / `status-change` (debounced 1 s per session) + a 60 s tick for time-based signals; bounded state (LRU sessions, capped findings / snoozes / dismissals).
- Pane captures only through a guarded probe: per-session in-flight dedupe, 2 s timeout + SIGKILL (`defaultCapturePane`), liveness check against the watcher's live session list, at most 2 captures per tick, >= 2 min between captures of one session.
- Findings `{id, sessionId, sessionName, kind, severity, signature, summary, headline, evidence (redacted), firstSeen, lastSeen, count, turnId}`; dedupe per session+kind+signature; auto-clear when the session goes idle/waiting, the user sends a prompt (new turn), the failure stops recurring (a later run of the same command no longer shows it, or nothing for 15 min), an oscillating file moves on to a third state, or an edit lands (loop / no_progress).
- Snooze per session+kind (default 30 min), "Not stuck" suppresses the signature for the rest of the turn.
- Protocol `daemon/src/stuck/protocol.ts` <-> `web/src/types/stuck.ts` byte-identical (mirror test). WS: `stuck_list`, `stuck_snooze`, `stuck_dismiss`, `stuck_ask`, `stuck_interrupt`, `stuck_get_settings`, `stuck_set_settings`; global event `stuck_update`.
- Settings persisted in `~/.companion/stuck/settings.json` (`COMPANION_STUCK_STATE_DIR`), quiet hours (escalation config) keep findings off the Herald inbox.
- Herald: inbox item with `stuck` field (own `stuck` tone, active device only, never spoken unasked; Gaming = tone only), brief-me line "Out4 looks stuck: same test failing 6 times.", brain tools `stuck_sessions` + `snooze_stuck`, actions via ask-a-session (`relayAsk`), `propose_interrupt` (echo tier) and show.
- Web: amber "Stuck?" badge (sidebar + mobile list), dismissible SessionView banner (summary, expandable evidence, Ask what's wrong / Interrupt / Snooze 30m / Not stuck), settings card in Notification Settings (toggle, no-progress minutes, Advanced thresholds).
- Parser: `ToolCall.isError` (optional) from `tool_result.is_error`; `status` unchanged (an `error` status would start firing error-detected escalations).

---

## Item: Code Review 2.0
**Status:** done (daemon + Herald); web workstream in progress

Authoritative design, protocol contract and tests: `docs/code-review-2-plan.md`.

Daemon shipped in four phases (commits `feat(review): ...`, `feat(herald): review_changes ...`):
0. Protocol contract (`daemon/src/review/protocol.ts`), bounded GitRunner, `get_session_diff` rebuilt on the ledger + one bounded diff (fixes the N+1 shell fan-out and dropped untracked files).
1. Ledger, checkpoint store, free summaries, risk classification, `review_summary_list` / `review_get` (turns) / `review_mark_reviewed` / `review_approve_turn`, global `review_summary` events.
2. Snapshots + net files view, `review_get_file`, `review_get_edits`, renames / binary / modes, unattributed section, subagent attribution.
3. `review_ask` via Herald `relayAsk`, revert preview / apply / undo (CAS, backups, audit, tiers), `review_watch` / `review_live`.
4. Herald `review_changes` tool, risk alerts in the inbox (`review` field), fallback lines, `review_polish_summaries`.

Needs a user-approved daemon restart to go live. Known gaps: no on-wire notice when a checkpoint snapshot was gc-pruned (silently falls back to HEAD); turn-end unattributed scans use the net diff (not `git status`).

---

## Item: Global Concierge — cross-machine fan-out
**Status:** done

A per-server "C" button spawns/attaches a long-running concierge Claude session
on that daemon's host, which fans work out to real project sessions on ANY
connected daemon via the `companion-remote` MCP and relays one consolidated
wait-and-aggregate summary. Full design in
`/home/hexi/.claude/plans/purrfect-leaping-frost.md`; rollout/verification steps
in `NEXT_TIME.md`.

Shipped:
- Auto-derived `~/.companion/mcp-servers.json` (`concierge_sync_mcp`) — no
  hand-editing; always includes a `local` loopback entry, preserves manual
  entries.
- `concierge_open` — spawn/attach the `concierge` tmux session from the UI.
- `remote_list_sessions` MCP tool — cross-machine session resolver (proxies
  `get_sessions`, returns newest `resolved` for a `cwd`).
- Reliable dispatch handle — clamped `resolveTimeoutMs`, raised default,
  `resolveSessionByTmuxName` fallback, always-returned `tmuxSessionName`.
- Security: per-origin tokens (`origins[]` + `concierge_register_origin`,
  additive with legacy listener token) and TLS cert pinning
  (`get_cert_fingerprint` + MCP `certFingerprint` → `CertPinMismatch`).
- Web: `ConciergeView`, "C" button (sidebar + mobile), routing,
  `getServersForMcpBootstrap()`.
- Concierge routing rules (`concierge/CLAUDE.md`) rewritten for cross-machine
  wait-and-aggregate; per-project `server` in `projects.json`.

Builds green (daemon/mcp/web). NOT yet deployed to running daemons or
E2E-verified — see `NEXT_TIME.md`.

---

## Item: Theme customization — Phase 1: Clean up hardcoded colors
**Status:** done

### Requirements
- Replace hardcoded hex colors in global.css with existing CSS variables (or create new ones where needed)
- Convert inline style colors in the 5 problem components to CSS classes using variables
- Add missing variables: `--gradient-success`, `--gradient-success-hover`, `--color-white`
- Do NOT touch GitHub syntax highlighter colors (intentionally hardcoded from highlight.js theme)
- No visual changes — this is a pure refactor

### Files to Modify
- `web/src/styles/variables.css` — add missing variables (`--gradient-success`, `--gradient-success-hover`, `--color-white`)
- `web/src/styles/global.css` — replace ~67 hardcoded hex colors with `var()` references
- `web/src/components/UsageDashboard.tsx` — convert ~30 inline style colors to CSS classes
- `web/src/components/CostDashboard.tsx` — convert ~10 inline style colors to CSS classes
- `web/src/components/DailyUsageChart.tsx` — convert inline style colors to CSS classes
- `web/src/components/TerminalPanel.tsx` — check and convert if needed
- `web/src/components/ErrorBoundary.tsx` — check and convert if needed

### Implementation Steps
1. Open `web/src/styles/variables.css` and add missing variables to the `:root` block:
   - `--gradient-success: linear-gradient(135deg, #22c55e 0%, #10b981 100%);`
   - `--gradient-success-hover: linear-gradient(135deg, #16a34a 0%, #059669 100%);`
   - `--color-white: #ffffff;`
2. Audit `web/src/styles/global.css` for hardcoded hex colors. For each one:
   a. Identify which existing CSS variable matches (e.g., `#3b82f6` -> `var(--accent-blue)`, `#f1f5f9` -> `var(--text-primary)`, `#334155` -> `var(--border-color)`)
   b. Replace the hardcoded value with the `var()` reference
   c. Skip any colors inside the `.hljs` / syntax highlighter block (these are from a highlight.js theme and must stay hardcoded)
   d. For colors with no exact variable match, check if it is close enough to an existing variable or create a new variable in variables.css
3. For `web/src/components/UsageDashboard.tsx`:
   a. Search for all `style={{ ... color:` and `style={{ ... background` patterns
   b. Create CSS classes in global.css for each unique style combination (e.g., `.usage-bar-blue { background: var(--accent-blue); }`)
   c. Replace inline `style=` with `className=` references
   d. For chart/SVG fill colors that must stay inline, use CSS custom properties via `style={{ fill: 'var(--accent-blue)' }}`
4. Repeat step 3 for `web/src/components/CostDashboard.tsx` (~10 inline colors)
5. Repeat step 3 for `web/src/components/DailyUsageChart.tsx`
6. Check `web/src/components/TerminalPanel.tsx` for hardcoded colors:
   a. If any exist, convert to CSS variables/classes
   b. ANSI terminal color codes should remain as-is (they are part of terminal emulation)
7. Check `web/src/components/ErrorBoundary.tsx` for hardcoded colors and convert any found
8. Run `cd web && npx tsc --noEmit` to verify no type errors introduced
9. Run a final grep for remaining hardcoded hex colors: `grep -rn '#[0-9a-fA-F]\{6\}' web/src/styles/global.css` and verify all remaining are either in syntax highlighter blocks or are intentional (e.g., inside `rgba()` or SVG data URIs)
10. Visual verification: open the app in browser and confirm no visible color changes

### Tests Needed
- `cd web && npx tsc --noEmit` — typecheck passes
- Visual verification in browser — no color changes visible (pixel-identical behavior)
- Grep for remaining hardcoded hex colors outside syntax highlighter blocks — should be zero or justified
- All 5 modified components render correctly (UsageDashboard, CostDashboard, DailyUsageChart, TerminalPanel, ErrorBoundary)

---

## Item: Theme customization — Phase 2: Theme presets
**Status:** done

### Requirements
- 5 curated theme presets: Midnight (current default), Ocean (teal/cyan), Forest (green/emerald), Warm (amber/orange), Rose (pink/magenta)
- Each preset defines all ~35 CSS variable overrides plus gradient variants
- Theme selector in SettingsScreen — card grid with color previews
- Live preview when selecting a preset
- Persist selection to localStorage (key: `companion_theme`)
- Load theme before first render to avoid flash of wrong theme (inline script or blocking read in index.html)
- On Tauri mobile, also persist via tauri-plugin-store for cross-launch persistence
- All presets must maintain WCAG AA contrast ratios for text readability

### Architecture
- CSS class-based approach: `:root { /* midnight default */ }`, `:root.theme-ocean { ... }`, etc.
- Theme context: `web/src/context/ThemeContext.tsx` with provider, hook, and preset definitions
- No granular per-color customization — presets only (curated to look good)
- Theme applied by adding class to `<html>` element (`document.documentElement.classList`)

### Theme Color Palettes
Each preset overrides all variables from `variables.css`:

**Midnight** (default — current colors, no class needed):
- Accents: blue `#3b82f6` + purple `#8b5cf6`
- Backgrounds: `#0f172a` (primary), `#1e293b` (secondary), `#334155` (tertiary)
- Gradient: blue-to-purple

**Ocean** (`.theme-ocean`):
- Accents: teal `#06b6d4` + blue `#0ea5e9`
- Backgrounds: `#0c1222` (deep navy), `#132038` (secondary), `#1e3350` (tertiary)
- Gradient: teal-to-blue
- Border accent: `#1a4a6a`

**Forest** (`.theme-forest`):
- Accents: emerald `#10b981` + green `#22c55e`
- Backgrounds: `#0a1510` (dark forest), `#11261a` (secondary), `#1a3828` (tertiary)
- Gradient: emerald-to-green
- Border accent: `#1a4a2e`

**Warm** (`.theme-warm`):
- Accents: amber `#f59e0b` + orange `#f97316`
- Backgrounds: `#1a1008` (dark warm), `#261a0a` (secondary), `#3d2a12` (tertiary)
- Gradient: amber-to-orange
- Border accent: `#5a3d1a`

**Rose** (`.theme-rose`):
- Accents: pink `#ec4899` + magenta `#d946ef`
- Backgrounds: `#1a0a14` (dark plum), `#261020` (secondary), `#3d1a30` (tertiary)
- Gradient: pink-to-magenta
- Border accent: `#5a1a4a`

Each preset needs to define:
- 6 background colors (`--bg-primary` through `--bg-card-purple`)
- 3 text colors (`--text-primary`, `--text-secondary`, `--text-muted`)
- 7 accent colors (`--accent-blue` renamed semantically or overridden, hover states, light variants)
- 2 border colors (`--border-color`, `--border-accent`)
- 6 gradients (`--gradient-primary`, `--gradient-header`, `--gradient-button`, `--gradient-button-hover`, `--gradient-progress`, `--gradient-text`)
- 2 focus glow effects (`--focus-glow`, `--focus-glow-blue`)
- Success gradients (`--gradient-success`, `--gradient-success-hover`)

### Files to Create
- `web/src/context/ThemeContext.tsx` — ThemeProvider component, `useTheme` hook, preset metadata (name, key, preview colors)

### Files to Modify
- `web/src/styles/variables.css` — Add theme class overrides (`:root.theme-ocean { ... }`, etc.) after the default `:root` block
- `web/src/App.tsx` — Wrap app with `<ThemeProvider>`, ensure theme class is applied before first render
- `web/src/components/SettingsScreen.tsx` — Add theme selector section with preview cards
- `web/src/styles/global.css` — Add styles for theme selector cards (`.theme-card`, `.theme-card-active`, `.theme-preview-swatch`)
- `web/index.html` — Add inline `<script>` in `<head>` to read `companion_theme` from localStorage and apply class to `<html>` before paint (prevents flash)

### Implementation Steps
1. **Design the theme preset data structure** in `web/src/context/ThemeContext.tsx`:
   ```typescript
   interface ThemePreset {
     key: string;           // 'midnight' | 'ocean' | 'forest' | 'warm' | 'rose'
     name: string;          // Display name
     className: string;     // CSS class ('' for midnight default, 'theme-ocean', etc.)
     previewColors: {       // For the selector UI
       bg: string;
       accent1: string;
       accent2: string;
     };
   }
   ```
2. **Define the 5 preset objects** with their metadata and preview colors
3. **Create ThemeProvider component**:
   a. Read saved theme from localStorage key `companion_theme` on mount
   b. Provide `{ currentTheme, setTheme, presets }` via React context
   c. On `setTheme(key)`: save to localStorage, update `document.documentElement.className` (preserve non-theme classes), and on Tauri mobile also write to tauri-plugin-store
   d. On mount: apply the saved theme class to `<html>` (redundant with inline script but ensures sync)
4. **Create `useTheme` hook** that returns the context value with a friendly error if used outside provider
5. **Add flash-prevention script** to `web/index.html`:
   ```html
   <script>
     (function() {
       var theme = localStorage.getItem('companion_theme');
       if (theme && theme !== 'midnight') {
         document.documentElement.classList.add('theme-' + theme);
       }
     })();
   </script>
   ```
   Place this in `<head>` before any CSS loads, so the correct theme class is present before first paint
6. **Add CSS variable overrides** in `web/src/styles/variables.css`:
   a. After the existing `:root { ... }` block, add `:root.theme-ocean { ... }` with all variable overrides
   b. Repeat for `.theme-forest`, `.theme-warm`, `.theme-rose`
   c. Each block overrides every variable defined in the default `:root` (backgrounds, text colors, accents, borders, gradients, focus glows)
   d. Ensure text-on-background contrast ratios meet WCAG AA (4.5:1 for normal text, 3:1 for large text) — verify with a contrast checker tool
7. **Wrap App with ThemeProvider** in `web/src/App.tsx`:
   a. Import `ThemeProvider` from `../context/ThemeContext`
   b. Wrap the outermost element: `<ThemeProvider><ConnectionProvider>...</ConnectionProvider></ThemeProvider>`
8. **Add theme selector to SettingsScreen** (`web/src/components/SettingsScreen.tsx`):
   a. Import `useTheme` hook
   b. Add a "Theme" section after the "Font Size" section
   c. Render a grid of theme preview cards (2-3 columns on mobile, 5 across on desktop)
   d. Each card shows: theme name, 3 color swatches (bg + 2 accents), active checkmark
   e. On click, call `setTheme(preset.key)`
   f. Active card gets a highlighted border using the theme's accent color
9. **Add CSS for theme selector** in `web/src/styles/global.css`:
   ```css
   .theme-selector-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 12px; }
   .theme-card { padding: 12px; border-radius: 12px; border: 2px solid var(--border-color); cursor: pointer; transition: border-color 0.2s; }
   .theme-card:hover { border-color: var(--accent-blue); }
   .theme-card-active { border-color: var(--accent-blue); box-shadow: var(--focus-glow-blue); }
   .theme-preview-swatches { display: flex; gap: 6px; margin-top: 8px; }
   .theme-preview-swatch { width: 24px; height: 24px; border-radius: 50%; }
   ```
10. **Handle Tauri mobile persistence**:
    a. In `ThemeContext.tsx`, detect if running in Tauri mobile via `isTauriMobile()`
    b. If so, also write to tauri-plugin-store on theme change: `await store.set('companion_theme', key); await store.save();`
    c. On mount in Tauri mobile, read from store as well (store takes precedence over localStorage if both exist)
11. **Test the complete flow**:
    a. Run `cd web && npx tsc --noEmit` — typecheck must pass
    b. `npm run dev` and verify all 5 themes render correctly
    c. Switch themes and verify all UI elements update (backgrounds, text, buttons, gradients, borders, focus rings)
    d. Refresh page — theme persists, no flash of default theme
    e. Check contrast ratios for each theme (especially light text on colored backgrounds)

### Tests Needed
- `cd web && npx tsc --noEmit` — typecheck passes
- Each preset renders with correct colors (visual verification for all 5)
- Theme persists across page reload (check localStorage)
- No flash of default theme on page load (inline script applies class before paint)
- Contrast ratios meet WCAG AA for all 5 themes (4.5:1 for body text)
- Theme selector cards show correct preview swatches
- Active theme card is visually distinguished
- Tauri mobile: theme persists across app restart (tauri-plugin-store)
- Switching themes updates all UI elements in real-time (no stale colors)

---

## Item: Diff line number gutter
**Status:** planned

### Requirements
- Render line numbers in a left gutter alongside diff lines in CodeReviewModal
- Use the existing `displayLineNum` already computed per line for line comments
- Added/removed/context lines show their number; hunk and meta lines show nothing

### Files to Modify
- `web/src/components/CodeReviewModal.tsx` — Add `<span className="crm-line-num">` before line content
- `web/src/styles/global.css` — Add `.crm-line-num` styles (monospace, muted color, fixed width)

### Implementation Steps
1. In the diff line rendering IIFE (lines 207-244), wrap each line in a flex row: `<span className="crm-line-num">{displayLineNum || ''}</span><span>{line || '\n'}</span>`
2. Add CSS: `.crm-line-num { width: 40px; text-align: right; color: #6b7280; user-select: none; flex-shrink: 0; }`
3. Update `.code-review-diff-line` to `display: flex`

### Tests Needed
- Visual verification: hunk lines have no number, context/added/removed lines show correct numbers
- Typecheck passes

---

## Item: Sticky comment threads on files
**Status:** planned

### Requirements
- Persist line comments in localStorage so they survive modal close/reopen
- Show previous comments as annotations on the diff when reopening review modal
- Scoped per session + file path
- Clear comments when session changes or user dismisses

### Files to Modify
- `web/src/components/CodeReviewModal.tsx` — Load/save comments, render annotations on diff lines
- `web/src/styles/global.css` — Annotation styles

### Implementation Steps
1. Define `CommentThread = { filePath: string; lineNumber: number; lineText: string; comment: string; timestamp: number }`
2. On comment submit (before calling `onComment`), also save to localStorage key `crm-comments:${sessionId}`
3. On mount / when expanding a file, load saved comments and match by filePath + lineNumber
4. Render matched comments as a small annotation div below the diff line: `.crm-saved-comment { font-size: 11px; color: #9ca3af; padding: 2px 0 2px 40px; }`
5. Add "Clear comments" button in modal header (only shown when comments exist)
6. Pass `sessionId` as a new prop to CodeReviewModal

### Tests Needed
- Comments persist after closing and reopening modal
- Comments for different sessions don't bleed
- Clear button removes all comments
- Typecheck passes

---

## Item: Session activity sparkline
**Status:** planned

### Requirements
- Tiny inline SVG in sidebar showing message frequency over last 30 minutes
- One bar per minute, height proportional to message count in that minute
- Placed between session name and relative time in sidebar items

### Files to Modify
- `web/src/components/SessionSidebar.tsx` — Add sparkline component inline in session item (around line 595)
- `web/src/components/MobileDashboard.tsx` — Add sparkline in MobileSessionItem
- `web/src/types/index.ts` — Add `recentTimestamps?: number[]` to `SessionSummary` (or compute client-side)

### Implementation Steps
1. Create `web/src/components/Sparkline.tsx` — pure component taking `timestamps: number[]` and rendering an SVG
2. Compute 30 bins (1 per minute), normalize to max height of 16px, render as `<rect>` bars
3. In SessionSidebar, pass `session.recentTimestamps` (if daemon provides) or compute from cached highlights
4. **Option A (simpler):** Daemon adds `recentTimestamps` to `server_summary` response — array of last 30 message timestamps
5. **Option B (client-only):** Use cached highlights timestamps from `SessionCache` — no daemon change needed
6. Style: width ~60px, height 16px, bars colored `#3b82f6` with 1px gap, no axis labels

### Tests Needed
- Sparkline renders 0-bar state gracefully (empty array)
- Correct bin assignment for edge timestamps
- Typecheck passes

---

## Item: Batch approve pending tools
**Status:** planned

### Requirements
- When multiple tool calls are pending approval in the last message, show an "Approve all (N)" button
- Uses existing `send_choice` / key-sequence infrastructure
- Sends approvals sequentially with small delay between each

### Files to Modify
- `web/src/components/MessageBubble.tsx` — Add batch approve button above individual approval prompts
- `daemon/src/parser.ts` — Ensure multiple pending tools in same message all get options

### Implementation Steps
1. In MessageBubble, detect when `message.toolCalls` has multiple pending approval tools
2. Render a "Approve all (N)" button before the individual tool cards
3. On click, iterate through each pending tool and send approval via `onSelectChoice({ selectedIndices: [0], optionCount: 3, multiSelect: false })` with a 500ms delay between each (CLI needs time to process each)
4. Disable individual approve buttons while batch is in progress (use a `batchApproving` state)
5. Show progress: "Approving 2/5..."

### Tests Needed
- Button only appears when 2+ tools are pending
- Sequential sends with delay don't race
- Typecheck passes

---

## Item: Message bookmarks
**Status:** planned

### Requirements
- Right-click (or long-press on mobile) a message to bookmark it
- Bookmarks stored in localStorage, keyed per server
- Accessible from a "Bookmarks" button in session header
- Tapping a bookmark scrolls to that message (if still loaded)

### Files to Modify
- `web/src/components/MessageBubble.tsx` — Add "Bookmark" / "Remove bookmark" to context menu (line ~556)
- `web/src/hooks/useBookmarks.ts` — New hook for bookmark CRUD
- `web/src/components/BookmarkList.tsx` — New dropdown/popover showing bookmarks
- `web/src/components/SessionView.tsx` — Add bookmarks button to header, pass bookmark state to MessageList/MessageBubble
- `web/src/types/index.ts` — Add `Bookmark` interface

### Implementation Steps
1. Define type: `Bookmark { messageId: string; serverId: string; sessionId: string; content: string; timestamp: number }`
2. Create `useBookmarks(serverId)` hook — reads/writes `companion_bookmarks:${serverId}` localStorage key
3. Add "Bookmark" item to MessageBubble context menu. If already bookmarked, show "Remove bookmark"
4. Show bookmarked messages with a subtle left-border accent (e.g., `border-left: 2px solid #f59e0b`)
5. Create BookmarkList component — simple dropdown listing bookmarks with content preview and relative time
6. On click, scroll to message via `data-highlight-id` selector. If not loaded, show "Message not in view"
7. Add "Bookmarks (N)" button in session header viewButtons section

### Tests Needed
- Bookmark persists across page reload
- Remove bookmark works
- Bookmark indicator renders on correct message
- Typecheck passes

---

## Item: Centralize localStorage keys into storageKeys.ts
**Status:** planned

### Requirements
- Single source of truth for all localStorage key strings
- Typed key builder functions for session/server-scoped keys
- Replace 38+ hardcoded string keys across the codebase

### Files to Modify
- `web/src/services/storageKeys.ts` — New file with all key constants and builders
- All files using localStorage — Import keys from storageKeys.ts

### Implementation Steps
1. Create `web/src/services/storageKeys.ts` with:
   - Static keys: `SERVERS_KEY`, `FONT_SCALE_KEY`, `HISTORY_KEY`, `DEVICE_ID_KEY`, `AWAY_KEY`
   - Builder functions: `hideToolsKey(sessionId)`, `openFilesKey(serverId, sessionId)`, `autoApproveKey()`, `bookmarksKey(serverId)`, `notifPrefsKey()`, etc.
2. Find/replace all hardcoded localStorage key strings across:
   - `services/storage.ts` (lines 4, 6)
   - `services/history.ts` (line 8)
   - `services/openFiles.ts` (line 6)
   - `services/BrowserNotifications.ts` (line 10)
   - `services/push.ts` (line 24)
   - `services/recentDirectories.ts` (line 3)
   - `hooks/useAutoApprove.ts` (line 3)
   - `hooks/useAwayDigest.ts` (line 8)
   - `components/SessionView.tsx` (line 116)
3. Import from centralized module in each file

### Tests Needed
- All existing functionality still works (keys unchanged, just centralized)
- Typecheck passes
- No duplicate key values

---

## Item: Extract QuestionBlock and MultiQuestionFlow out of MessageBubble.tsx
**Status:** planned

### Requirements
- Move QuestionBlock, QuestionBlockSingle, MultiQuestionFlow, and AnswerData/ChoiceData types to a dedicated file
- MessageBubble imports from the new file
- No behavior changes

### Files to Modify
- `web/src/components/QuestionBlock.tsx` — New file with extracted components
- `web/src/components/MessageBubble.tsx` — Remove ~300 lines, add imports

### Implementation Steps
1. Create `web/src/components/QuestionBlock.tsx`
2. Move these from MessageBubble.tsx:
   - `ChoiceData` interface (lines 10-15)
   - `QuestionBlockProps` interface (lines 30-34)
   - `QuestionBlock` function (lines 36-175)
   - `MultiQuestionFlowProps` interface (lines 187-190)
   - `MultiQuestionFlow` function (lines 192-311)
   - `AnswerData` interface (lines 313-317)
   - `QuestionBlockSingleProps` interface (lines 319-322)
   - `QuestionBlockSingle` function (lines 324-410)
3. Export all public interfaces and components from QuestionBlock.tsx
4. In MessageBubble.tsx, `import { QuestionBlock, MultiQuestionFlow, ChoiceData } from './QuestionBlock'`
5. Re-export `ChoiceData` from MessageBubble.tsx if other files import it from there

### Tests Needed
- Typecheck passes
- Question UI still works (single-select, multi-select, other input, multi-question flow)

---

## Item: Named constants for daemon magic numbers
**Status:** planned

### Requirements
- Extract ~90 hardcoded numbers across daemon source into `daemon/src/constants.ts`
- Group by category: timeouts, delays, size limits, display limits, cache TTLs
- Replace in-place references with named imports

### Files to Modify
- `daemon/src/constants.ts` — New file with all named constants
- `daemon/src/input-injector.ts` — Replace 5000ms timeouts, 150ms/50ms/80ms delays
- `daemon/src/websocket.ts` — Replace size limits (5MB, 1MB, 150MB), TTLs (30s, 10min), thresholds
- `daemon/src/parser.ts` — Replace truncation limits (50, 100 chars), rate limit interval (60s)
- `daemon/src/watcher.ts` — Replace debounce (150ms, 3000ms), polling (5000ms), chain limit (20)
- `daemon/src/index.ts` — Replace dedup threshold (1s), cleanup window (30s), approval delay (300ms)

### Implementation Steps
1. Create `daemon/src/constants.ts` with groups:
   - TMUX: `TMUX_SPAWN_TIMEOUT_MS`, `KEY_PRESS_DELAY_MS`, `PRE_ENTER_DELAY_MS`, `POST_ENTER_DELAY_MS`
   - FILES: `MAX_IMAGE_SIZE_BYTES`, `MAX_TEXT_FILE_SIZE_BYTES`, `MAX_APK_SIZE_BYTES`
   - CACHE: `FILE_TREE_CACHE_TTL_MS`, `PENDING_SENT_TTL_MS`
   - POLLING: `FILE_CHANGE_DEBOUNCE_MS`, `WAITING_DEBOUNCE_MS`, `TMUX_REFRESH_INTERVAL_MS`
   - DISPLAY: `LOG_TRUNCATION_LENGTH`, `COMMAND_TRUNCATION_LENGTH`, `SEARCH_DEFAULT_LIMIT`, `SEARCH_MAX_LIMIT`
2. Replace hardcoded values file by file (start with input-injector, then websocket, parser, watcher, index)
3. Leave values that are already named constants (e.g., `MAX_SCROLL_LOGS`) in place

### Tests Needed
- All 442 existing daemon tests pass
- No behavior changes (values identical)

---

## Item: Focus-visible keyboard outlines
**Status:** planned

### Requirements
- Add `:focus-visible` styles to all interactive elements (buttons, inputs, links)
- Consistent blue glow ring matching existing input focus styles
- Don't show on mouse click (`:focus-visible` handles this)

### Files to Modify
- `web/src/styles/global.css` — Add global `:focus-visible` rule and component-specific overrides

### Implementation Steps
1. Add global rule near top of global.css:
   ```css
   :focus-visible {
     outline: 2px solid #3b82f6;
     outline-offset: 2px;
   }
   ```
2. For dark-background elements, the blue outline works well already
3. Remove redundant `:focus` styles on inputs that only set `border-color` — keep the ones that adjust background or other properties
4. Add `outline: none` to elements that have their own `:focus-visible` treatment (e.g., inputs with border-color change)
5. Test tab navigation through: sidebar sessions, header buttons, input bar, tool card approve/reject, context menu items

### Tests Needed
- Tab through major UI flows — every interactive element has visible focus ring
- Mouse clicks don't show focus ring
- Typecheck passes (CSS only)

---

## Item: Error toast for failed choice/approval sends
**Status:** done

### Requirements
- When `onSelectChoice` or `onSelectOption` fails, show inline error below the options
- "Failed to send — tap to retry" message that re-attempts on click
- Auto-dismiss after 5 seconds

### Files to Modify
- `web/src/components/MessageBubble.tsx` — Add error state to QuestionBlock and approval prompt sections
- `web/src/styles/global.css` — Error toast styles

### Implementation Steps
1. In QuestionBlock, add `const [sendError, setSendError] = useState(false)` state
2. Wrap `onSelectChoice` calls in try/catch; on failure (or `false` return), set `setSendError(true)`
3. Render error below options: `{sendError && <div className="choice-send-error" onClick={retry}>Failed to send — tap to retry</div>}`
4. Auto-dismiss: `useEffect(() => { if (sendError) { const t = setTimeout(() => setSendError(false), 5000); return () => clearTimeout(t); } }, [sendError])`
5. Apply same pattern to the standalone approval prompt section (lines ~758-790)
6. Store the last attempted choice data so retry can re-send it
7. CSS: `.choice-send-error { color: #ef4444; font-size: 12px; cursor: pointer; padding: 4px 0; }`

### Tests Needed
- Error appears when send returns false
- Tap retries the same choice
- Auto-dismisses after 5 seconds
- Typecheck passes

---

## Item: `companion-remote` MCP server — cross-daemon dispatch
**Status:** done

### Goals
- A Model Context Protocol server that lets Claude running on one Companion box dispatch work to Claude (or raw shell) on another Companion box, going through each machine's existing daemon.
- Three daemons (Linux, Windows, Mac) today only serve the Companion app; this adds a second kind of client — another daemon (via the MCP server) — without breaking the existing one.
- "Sick af" centerpiece: `remote_dispatch` spawns `claude "<prompt>"` in a tmux session on the remote box. Because both daemons are already feeding the Companion app, the user watches Claude-A and Claude-B in the same dispatch panel in parallel — cross-machine foreman mode.
- Secure by default: a compromised MCP server, a stolen auth token, or a malicious prompt on one box must not trivially escalate to "run arbitrary code anywhere."

### Architecture

#### Components
- **`mcp/` top-level directory** (new) — mirrors `daemon/` and `web/` layout.
  - `mcp/package.json` — separate npm package, depends on `@modelcontextprotocol/sdk` and `ws`.
  - `mcp/src/index.ts` — MCP stdio server entry point.
  - `mcp/src/tools/` — one file per tool (`remote_exec.ts`, `remote_dispatch.ts`, etc.).
  - `mcp/src/daemon-client.ts` — WS client to Companion daemons, structurally a stripped-down `ServerConnection.ts` (reconnect, auth, requestId/response correlation) but Node-side with `ws` instead of browser WebSocket.
  - `mcp/src/config.ts` — loads `~/.companion/mcp-servers.json`.
  - `mcp/src/session-registry.ts` — in-memory map of dispatched remote Claude sessions (see `remote_dispatch`).
- **Daemon** (existing, modified):
  - New handlers module `daemon/src/handlers/remote.ts` registering `exec_command`, `read_file_raw`, `write_file`, `get_capabilities`, `remote_dispatch_spawn`.
  - New `daemon/src/audit-log.ts` for append-only per-origin audit trail.
  - Extend `handler-context` with a `requireRemoteCapability(client, action)` gate.

#### Data flow for `remote_dispatch`
1. Claude on box A calls MCP tool `remote_dispatch({ server: "mac", prompt, cwd })`.
2. MCP server opens/uses a long-lived WS to Mac's daemon, authenticates, sends `remote_dispatch_spawn` with `{ prompt, cwd, tmuxName? }`.
3. Mac's daemon calls `tmux.createSession(name, cwd, startCli=true)` — reusing the `create_tmux_session` pathway — then injects the prompt via `injector.sendInput(prompt, name)`.
4. Daemon returns `{ sessionName, sessionId (JSONL uuid, resolved shortly after), createdAt }`.
5. MCP server returns `{ sessionId, server, tmuxSessionName }` to dispatching Claude.
6. Dispatching Claude polls `remote_get_conversation({ server, sessionId })` which proxies to the existing daemon `get_full` / `get_highlights` handler.
7. Both daemons still emit their normal `conversation_update` / `status_change` broadcasts to the Companion app — user sees both sessions side by side.

### Tool Contracts (MCP-exposed)

Every tool takes `server: string` (key into `mcp-servers.json`). MCP server resolves that to a daemon connection.

- **`remote_list_servers() -> { servers: Array<{ name, host, port, capabilities, connected }> }`**
  - No daemon call; reads config + cached connection state.

- **`remote_exec({ server, command, cwd?, timeout? }) -> { exitCode, stdout, stderr, truncated }`**
  - Streams via a new daemon `exec_command` handler that spawns a child_process, enforces `timeout` (default 30s, max 300s), captures <=1 MiB stdout/stderr. Requires `exec` capability on the target daemon (see Security Model).

- **`remote_read({ server, path }) -> { content, encoding, size }`**
  - Proxies to existing daemon `read_file` (already enforces `allowedPaths`). No new handler needed for v1.

- **`remote_write({ server, path, content, createDirs? }) -> { bytesWritten, path }`**
  - New `write_file` daemon handler. Reuses the same `allowedPaths` check as `read_file` + an extra `writableRoots` list (subset of allowed, opt-in per daemon; default empty).

- **`remote_dispatch({ server, prompt, cwd, sessionName? }) -> { sessionId, tmuxSessionName, startedAt }`**
  - See data flow above. `sessionName` optional; daemon generates one from `cwd` if omitted (same rules as `create_tmux_session`).
  - Requires `dispatch` capability.

- **`remote_get_conversation({ server, sessionId, sinceMessageId? }) -> { messages, status, isWaitingForInput }`**
  - Proxies to `get_highlights` (or `get_full` when `sinceMessageId` provided). Read-only; uses normal auth only.

- **`remote_send_input({ server, sessionId, input }) -> { sent }`**
  - Proxies to existing `send_input` handler. Read-write, so gated by `dispatch` capability (sending input counts as continuing a dispatched conversation). Not strictly needed for MVP but closes the loop.

- **`remote_cancel({ server, sessionId }) -> { cancelled }`**
  - Proxies to `cancel_input`. Required so a runaway remote Claude can be killed from the dispatching one.

### Security Model

This is the core of the design. Options presented where there's a real tradeoff.

#### 1. Authentication — layered capability tokens
**Recommendation:** Keep the single shared token for existing (read-oriented) daemon API, but introduce a **capability allowlist per listener** in `config.json` that gates the new destructive message types. No second token needed — the existing token proves identity, capabilities prove authorization.

```json
{
  "listeners": [
    {
      "port": 9877,
      "token": "...",
      "remoteCapabilities": {
        "enabled": false,
        "exec": { "enabled": false },
        "dispatch": { "enabled": true },
        "write": { "enabled": false, "roots": ["/home/user/dispatched"] },
        "requireLoopbackOrTls": true,
        "allowedOrigins": ["mcp-a1b2..."],
        "commandAllowlist": null
      }
    }
  ]
}
```

Rationale: a second token is tempting but would force users to track N^2 token pairs across machines, and rotating one breaks many flows. A single token + per-action gate is simpler and the gate is what actually provides protection — a leaked token that can only read still can't RCE.

**Alternative considered:** a distinct `remoteToken` per listener that's required alongside the normal token for destructive ops. Rejected as too noisy for single-user infrastructure — the user would copy both tokens everywhere defeating the security benefit.

#### 2. Command allowlist vs. freeform
**Recommendation:** Freeform by default **when `exec.enabled` is true**, with optional per-daemon regex allowlist (`commandAllowlist`) for users who want belt-and-suspenders. `exec.enabled` itself defaults OFF and must be explicitly flipped in the daemon's config on each box the user wants to accept exec from.

Rationale: this is the user's own three machines. If they wanted to lock down what Claude can run they'd write a tighter shell wrapper — heavy allowlisting pushes users to `exec("bash -c 'the real thing'")` which defeats the allowlist. The enabled/disabled flag is the real security control; the allowlist is for users with a specific threat model (e.g., "from the Linux box the Mac can only run `git fetch`-type stuff").

#### 3. Transport
**Recommendation:**
- MCP server **refuses** to talk to a remote daemon unless one of: (a) target is loopback (`127.0.0.1` / `::1`), (b) connection is `wss://`, or (c) target host is explicitly marked `trustedNetwork: true` in `mcp-servers.json` (use case: Tailscale).
- Daemon enforces the same on its side for remote-capability messages: if `remoteCapabilities.requireLoopbackOrTls` (default true) and the connection isn't loopback and isn't TLS, destructive messages return `transport_insecure` error.
- The daemon already tracks `client.isLocal`; reuse that for the loopback check — no new code.

#### 4. Filesystem scope
**Recommendation:** Two-tier.
- `remote_read` uses existing `allowedPaths` (homeDir, /tmp, /var/tmp, config extras). Unchanged.
- `remote_write` uses a **stricter** opt-in list `remoteCapabilities.write.roots` (default empty -> writes disabled). No fallback to `allowedPaths` — writing is scarier than reading, different control.
- `remote_dispatch` can set `cwd` anywhere under `allowedPaths` (same as read) since it's just chdir, not write.

#### 5. Audit log
Every message handled via the remote-capability path writes an append-only JSONL line to `~/.companion/audit.log`:

```json
{"ts": 1713283200000, "origin": {"addr": "100.64.0.3", "clientId": "abc", "isLocal": false, "tls": true}, "action": "exec_command", "payload": {"command": "git status", "cwd": "/home/user/repo"}, "result": {"ok": true, "exitCode": 0}, "durationMs": 143}
```

- Rotated at 10 MB, 5 files retained.
- Exposed via a new read-only handler `get_audit_log({ limit, since })` (gated behind normal auth) so the Companion app can surface a "cross-daemon actions" view.
- Writes happen in a non-blocking `setImmediate` — never gates the response path.

#### 6. Rate limiting
**Recommendation:** Sliding-window limiter per `(clientId, action)`: 60 exec/min, 600 read/min, 10 dispatch/min. Exceeding returns `rate_limited` error. Values hardcoded for MVP; configurable in follow-up. Not critical for single-user but trivial to add and forces noisy misbehavior to be visible.

### Configuration & Registration

#### Daemon side
Add `remoteCapabilities` to existing `ListenerConfig` (see `daemon/src/types.ts:1-7`). Upgrading daemons default to `enabled: false`, so zero behaviour change until the user opts in. A `bin/companion enable-remote` CLI helper flips the flag interactively and prints the matching `mcp-servers.json` snippet.

#### MCP config
Location: `~/.companion/mcp-servers.json` (shape mirrors `web/src/types/index.ts:1-11`):

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
      "trustedNetwork": false,
      "capabilities": ["exec", "dispatch", "read", "write"]
    }
  ]
}
```

The `capabilities` field on the MCP side is a **client-side** hint — actual enforcement is on the daemon. It's there so `remote_list_servers` can tell Claude what each server is expected to support without a round trip.

#### Claude Code registration
Document in README: `claude mcp add companion-remote -- node /path/to/mcp/dist/index.js`. The MCP server discovers its config from `~/.companion/mcp-servers.json` automatically — no `.mcp.json` per-project config needed, but an env var `COMPANION_MCP_CONFIG` can override.

### Capability Negotiation

Currently there is no version handshake. An older daemon receiving `exec_command` would hit the `Unknown message type` branch in `daemon/src/websocket.ts:432-438`. That's fine as a signal — the MCP server treats `Unknown message type: <remote_*>` response as "capability not supported" and surfaces a clear error to Claude.

But we should also add a proactive handshake:
- New `get_capabilities` handler on the daemon. Cheap, no side effects, usable pre-auth? No — keep it post-auth to avoid fingerprinting. Returns `{ daemonVersion, protocolVersion, remoteCapabilities: { exec: bool, dispatch: bool, write: { enabled, roots } } }`.
- MCP's `daemon-client.ts` calls `get_capabilities` immediately after authenticating and caches the result per connection. Tool calls that need a missing capability fail fast with a clear error.
- Bonus: expose this in the Companion app UI too so users can audit remote-capability settings per daemon.

### Dispatch-specific Concerns

#### Where does Claude get spawned?
Two options:
- **(A) Always create a new tmux session**, named deterministically from `cwd` (reusing `generateSessionName`). If an existing session matches, append `-dN`. This is what `remote_dispatch_spawn` does. Pro: isolated; each dispatch has its own session visible in the Companion app. Con: sessions accumulate.
- **(B) Require the caller to pre-create a session and pass its name.** Pro: explicit. Con: extra step, and the dispatching Claude has to learn about tmux.

**Recommendation:** (A) for MVP (that's the "sick af" vibe — just works), with an explicit `sessionName` override for users who want to target an existing one. Add a daemon-side "remote-dispatch TTL" that cleans up idle dispatched sessions after N hours (default 24h) so they don't accumulate forever. Store an opt-in tag (`metadata.remoteDispatch = true`) on the tmux config so cleanup only touches dispatched sessions.

#### Reconnect / daemon restart mid-dispatch
- Dispatched Claude sessions live in tmux — they survive daemon restart automatically.
- MCP server's connection to the daemon reconnects with exponential backoff (reuse `ServerConnection.ts` logic).
- Pending `remote_exec` / `remote_dispatch` calls in flight at disconnect: reject with `disconnected`, let the dispatching Claude retry. Don't try to dedupe — remote_exec is potentially non-idempotent and we shouldn't guess.
- After reconnect, `remote_get_conversation` just works (JSONL is the source of truth on the remote box).

### Phased Rollout

**MVP (Phase 1) — one PR worth:**
- `mcp/` package scaffolding + daemon-client.
- Tools: `remote_list_servers`, `remote_read`, `remote_get_conversation`. Read-only, no new daemon handlers needed (reuses `read_file`, `get_highlights`).
- Daemon: `get_capabilities` handler only. No destructive handlers yet.
- Config loading from `~/.companion/mcp-servers.json`.
- `claude mcp add companion-remote` instructions.
- Demonstrates the cross-daemon plumbing end-to-end with zero new attack surface.

**Phase 2 — the magic:**
- Daemon: `remote_dispatch_spawn` handler (reuses `create_tmux_session` + `send_input`).
- MCP: `remote_dispatch`, `remote_send_input`, `remote_cancel`.
- Capability flag `dispatch` + audit log infrastructure.
- This is the headline feature. Most code here is glue.

**Phase 3 — filesystem writes + exec:**
- Daemon: `write_file`, `exec_command` handlers.
- MCP: `remote_write`, `remote_exec`.
- `remoteCapabilities.write.roots`, `exec.enabled`, rate limiting, audit log rotation.
- TLS/loopback enforcement made strict.

**Phase 4 — polish:**
- Companion app UI for audit log + capability toggles per daemon.
- Command allowlist / regex support.
- `bin/companion enable-remote` interactive CLI.
- Optional origin pinning (MCP identifies itself with an `origin` field in auth; daemon can pin to a specific origin).

### Files to Add

- `mcp/package.json` — MCP package manifest.
- `mcp/tsconfig.json` — TS config.
- `mcp/src/index.ts` — MCP stdio server bootstrap (registers tools, wires `DaemonClient`).
- `mcp/src/daemon-client.ts` — WS client with auth, reconnect, `sendRequest`. Structured after `web/src/services/ServerConnection.ts:1-400` but in Node.
- `mcp/src/session-registry.ts` — maps `{server, sessionId}` to dispatch metadata so tools can look up dispatches.
- `mcp/src/config.ts` — loads `~/.companion/mcp-servers.json`, watches for changes.
- `mcp/src/tools/remote_list_servers.ts`
- `mcp/src/tools/remote_read.ts`
- `mcp/src/tools/remote_write.ts`
- `mcp/src/tools/remote_exec.ts`
- `mcp/src/tools/remote_dispatch.ts`
- `mcp/src/tools/remote_get_conversation.ts`
- `mcp/src/tools/remote_send_input.ts`
- `mcp/src/tools/remote_cancel.ts`
- `mcp/src/errors.ts` — shared error types (`TransportInsecure`, `CapabilityDisabled`, `RateLimited`).
- `daemon/src/handlers/remote.ts` — new handler module registering `get_capabilities`, `exec_command`, `write_file`, `remote_dispatch_spawn`.
- `daemon/src/audit-log.ts` — append-only JSONL audit writer with rotation.
- `daemon/src/rate-limiter.ts` — sliding window per `(clientId, action)`.
- `docs/companion-remote.md` — user-facing docs: config shape, capability explanation, `claude mcp add` instructions.

### Files to Modify

- `daemon/src/types.ts` — add `RemoteCapabilitiesConfig` interface, extend `ListenerConfig` with optional `remoteCapabilities`.
- `daemon/src/handlers/index.ts` — register `registerRemoteHandlers`.
- `daemon/src/handler-context.ts` — add `auditLog`, `rateLimiter`, `requireRemoteCapability(client, action) -> error | null`.
- `daemon/src/websocket.ts` — thread new context fields through `createHandlerContext()` around line 207-241. No changes to the router — handlers self-register.
- `daemon/src/config.ts` — default-fill `remoteCapabilities: { enabled: false }` when absent.
- `README.md` / `CLAUDE.md` — document the new `mcp/` directory and setup flow.

### Open Questions

1. **Stream vs. buffer for `remote_exec` output.** MCP tools don't natively stream results mid-call. Proposal: accumulate up to `maxOutputBytes`, then return all at once with `truncated: true` if exceeded. Streaming would require a companion `remote_exec_stream` tool that pushes progress notifications — worth it? (Lean: skip for MVP, revisit if Claude complains about timeouts.)

2. **Does `remote_dispatch` block or return immediately?** Current design: returns immediately with `sessionId`, caller polls. Alternative: `remote_dispatch_wait` variant that blocks until the remote Claude reaches `isWaitingForInput` or completes. Probably worth adding in Phase 2 — makes trivial sequential cross-machine workflows nicer.

3. **Shared `DaemonClient` with the web codebase.** `web/src/services/ServerConnection.ts` is browser-WebSocket. The MCP's is Node `ws`. Worth factoring into a shared package in `packages/daemon-client`? Probably yes eventually, but not for MVP — lift after Phase 3 when the contracts stabilize.

4. **Origin pinning.** Should the daemon know which MCP instance is talking to it? Useful if the user wants to say "only the Linux box's MCP can trigger dispatch on Mac." Implementation: MCP sends an `origin` string (stable UUID in config) in `authenticate`; daemon pins via `allowedOrigins`. Moved to Phase 4; the `enabled: false`-by-default gate makes it low priority.

5. **Multi-MCP connections to the same daemon.** If both box A and box B point their MCP servers at box C's daemon, they'll each get their own WS connection. That's fine; the daemon already supports N clients. Just noting it works.

6. **What happens if `remote_dispatch` target machine has no `claude` on PATH?** Need a clear error — currently `create_tmux_session` with `startCli=true` runs `claude` unconditionally and silently fails inside the tmux. Should add a pre-check: daemon's `remote_dispatch_spawn` runs `which claude` first, returns `claude_not_found` error with the PATH it checked. Small win, big UX improvement.

7. **Does the MCP server need its own long-running process, or can it launch on demand?** MCP SDK supports both. Recommendation: stdio (launched on demand by Claude Code). State is per-invocation — the session registry is ephemeral, remote Claude sessions live in tmux anyway.

### Tests Needed
- Daemon: new handlers have unit tests mocking `tmux.createSession` / `injector.sendInput`.
- Capability gate: requests with `enabled: false` return `capability_disabled` error; `enabled: true` + insecure transport returns `transport_insecure`.
- Audit log: every destructive handler writes exactly one entry with correct fields; rotation works at 10 MB.
- Rate limiter: 61st exec in 60s returns `rate_limited`.
- MCP: mock daemon WS, assert each tool sends the right request and surfaces errors cleanly.
- End-to-end manual: two daemons on loopback, MCP server in between, dispatch a prompt A -> B, verify both sessions show up in the Companion app.

### Critical Files for Implementation
- /home/hexi/local/src/companion/daemon/src/websocket.ts
- /home/hexi/local/src/companion/daemon/src/handler-context.ts
- /home/hexi/local/src/companion/daemon/src/handlers/tmux.ts
- /home/hexi/local/src/companion/daemon/src/handlers/input.ts
- /home/hexi/local/src/companion/web/src/services/ServerConnection.ts

---

## Item: Fleet (Inbox → Missions → Routing → Health)
**Status:** planned

### Goal & Rationale
Anthropic's built-in Remote Control now covers the single-session phone remote (transcript,
AskUserQuestion, permissions, push). Companion should stop competing on that and instead own the
**fleet / orchestration layer**: many sessions, many machines, one place to see what needs you, what
is being worked on, where work should run, and whether the fleet itself is healthy. Nothing in
Remote Control spans machines or persists cross-session intent — that is the differentiator.

Four phases, each shippable on its own:
1. **Fleet Inbox** — one cross-daemon, attention-sorted list of every session; answer prompts inline.
2. **Missions + mission notes** — durable object above sessions (goal, members on N machines,
   results, notes that get injected into whichever session picks the work up).
3. **Routing + fleet inventory** — what each host has (repos, toolchains, load); placement
   suggestions when starting work.
4. **Fleet health** — per-daemon build/version/drift, confirmed rolling updates.

### Hard Constraints (apply to every phase)
- **C1 Opt-in / additive.** The existing server→session Dashboard stays the default home. Inbox is a
  separate view (toggle) with an optional setting to make it home. Missions exist only if created;
  direct session use and plain concierge chat are unchanged. Routing is suggestion-only (never
  auto-places). Health is read-only except explicitly confirmed actions.
- **C2 Backward-compatible protocol.** Only ADD new WS message types and new optional fields. Never
  rename, remove, or change semantics/shape of existing messages/fields. Unknown new fields on old
  clients must be harmless.
- **C3 Graceful degradation.** Older daemons keep working in all existing views. In new views they
  are either shown with reduced data or labelled "needs update" — never an error state, never a
  broken view. The web feature-detects per daemon (see "Capability handshake" below).
- **C4 Zero cost when off.** If the user never opens the Inbox/Missions/Health views, the client
  sends no new requests and daemons do no new work (no new timers, no pane scrapes).
- **C5 Subprocess safety** (engineering rule, commit 3058a0a): every recurring or fan-out exec
  (tmux capture-pane, git, `claude --version`, etc.) must have in-flight dedup + timeout with
  SIGKILL + PID/session liveness check. Prefer on-demand + short TTL cache over intervals.
- **C6 Never restart a daemon without explicit per-daemon sign-off** (project hard rule). No fleet
  action may batch restarts.
- **C7 Conventions.** New handler modules under `daemon/src/handlers/` registered in
  `handlers/index.ts`; shared types mirrored in `daemon/src/types.ts` ↔ `web/src/types/index.ts`;
  hooks in `web/src/hooks/` following the hooks pattern; localStorage keys in
  `web/src/services/storageKeys.ts`; dark-theme CSS variables (no hardcoded hex); no emojis;
  `console.log` daemon logging.

### Decisions (2026-09-24)
User answers to the open questions; no open user questions remain.
1. **Unseen finished turns count as "Needs you"** by default (Q1), with a per-device setting to turn
   it off.
2. **"Seen" state is synced across devices** (Q3), not per device. Each session's own daemon stores
   a monotonic (max-wins) `seenUpTo` watermark per tmux session in `~/.companion/inbox-seen.json`,
   exposed via additive `mark_seen` → `session_seen` (live to fleet-subscribed clients) and
   `seenUpTo` on `get_fleet_inbox` items; feature `inbox_seen_sync_v1`. Older daemons fall back to
   per-device local seen state for those servers only. See Phase 1 design.
3. **Mission home = the daemon where the concierge runs** (Q4); no separate "Fleet home" setting.
4. **Phase 2 may install a Claude Code `SessionStart` hook into project repos** (Q5) to re-inject
   mission notes after compaction — opt-in per repo, idempotent, merged into existing settings
   (never clobbers hooks), easy uninstall, no-op without an active mission.
5. **In-app per-daemon restart confirmation counts as the required sign-off** (Q9) for the Phase 4
   rolling update; each restart is individually confirmed, no batch auto-restart.
- Unanswered minor questions (Q2, Q6, Q7, Q8, Q10) proceed with the plan defaults written in their
  phases; they are not blocking and can be revisited at each phase's kickoff.

### Current-State Findings (research, 2026-09-24)
- **Handshake already half-exists.** `get_capabilities` (`daemon/src/handlers/remote.ts`) returns
  `{ daemonVersion, protocolVersion: 1, remoteCapabilities }`, and `web/src/hooks/useCapabilities.ts`
  consumes it. But `daemonVersion` is `package.json` `1.0.0` on every build (useless for drift), and
  there is no feature list. Daemons older than the MCP work answer `Unknown message type:
  get_capabilities` → that response is itself a reliable "legacy" signal. The `authenticated` reply
  carries only `isLocal` + `gitEnabled`.
- **Cross-server aggregation already exists.** `web/src/hooks/useAllServerSummaries.ts` polls
  `get_server_summary` on every connected server every 5s (used by `Dashboard.tsx`).
  `SessionSummary.status` is `idle | working | waiting | error`, but the daemon never actually
  emits `error` (`watcher.getServerSummary`), and `waiting` conflates "turn finished" with "blocked
  on a permission/plan prompt".
- **Pending live AUQ is invisible to status.** Claude Code only flushes the AUQ tool_use to JSONL
  after it is answered, so `isWaitingForInput` is FALSE while an AUQ box is on screen (see the
  `get_highlights` comment in `handlers/session.ts` and commits 5b4c68c..1028d5d). Only
  `get_highlights` (offset 0) pane-scrapes via `detectActiveChoicePrompt`. The Inbox therefore needs a
  gated pane probe for "stalled working" sessions — the summary alone will miss the most important
  case.
- **Answering already works without subscribing.** `send_input` and `send_choice`
  (`handlers/input.ts`) accept `tmuxSessionName`; `send_worker_input` exists for workers. The Inbox
  needs no new answer endpoints. `QuestionBlock.tsx` is already a standalone component
  (`question`, `onSelectOption`, `onSelectChoice`), and SessionView answers permission prompts by
  `send_input(label)`.
- **Bug that matters for the Inbox:** after `send_input`/`send_choice`, the daemon calls
  `escalation.acknowledgeSession(watcher.getActiveSessionId())` — the *active* session, not the one
  that was answered. Answering from the Inbox would not cancel push escalation for that session.
- **Pending permission tools are computed but not exposed.** The watcher emits `pending-approval`
  (`getPendingApprovalTools`) only to auto-approval in `index.ts`; no client message carries it.
  `status_change` is session-scoped (only the subscribed session gets it); `other_session_activity`,
  `error_detected`, `session_completed`, `work_group_update` are global broadcasts.
- **Away Digest's UI is gone.** `AwayDigest.tsx`/`useAwayDigest.ts` were deleted in 0248880; only the
  daemon's `get_digest` / `get_notification_history` (persisted in
  `~/.companion/notification-history.json`, entries carry `eventType`, `sessionName`, `preview`,
  `acknowledged`) remain. FEATURES.md still lists "Away Digest" as present. The Inbox is the
  natural successor and should reuse that history for error reasons + "Recently finished".
- **Missions have no substrate yet.** Concierge fan-outs keep all state inside the concierge
  Claude's context (`concierge/CLAUDE.md`, `projects.json`); nothing persists. Work groups persist to
  `~/.companion/work-groups.json` and have their own worker lifecycle (`WorkGroup`, `WorkerSession`).
  Daemons never talk to each other directly — only the MCP (`mcp/src/daemon-client.ts`) using
  `~/.companion/mcp-servers.json` (auto-derived by `concierge_sync_mcp`) does.
- **AJ's box is a file-copy deploy** (`bin/deploy-aj`) — no git on the host, so drift can only be
  detected from a build stamp shipped inside `daemon/dist`.
- Uncommitted WS-reliability work is in `web/src/services/ServerConnection.ts` /
  `ConnectionManager.ts`. Fleet work should land after that is committed and should avoid editing
  `ServerConnection.ts` (capability caching goes in a new module instead).

### Capability handshake (prerequisite, part of Phase 1)
- Extend `CapabilitiesResponse` (additive): `features: string[]`, `hostname: string`,
  `platform: NodeJS.Platform`, `arch: string`, `buildInfo?: { gitSha?: string; dirty?: boolean;
  builtAt?: string; branch?: string }`. Bump `protocolVersion` to `2` (field already exists; web
  treats `>= 2` or presence of `features` as feature-aware).
- Feature strings (constants in both type files): `fleet_inbox_v1`, `fleet_inbox_push_v1`,
  `choice_expect_prompt_v1`, `inbox_seen_sync_v1`, later `missions_v1`, `inventory_v1`, `health_v1`, `self_update_v1`.
- Web: new `web/src/services/capabilities.ts` — per-server cache, fetched once per (re)connect via
  `connectionManager.onChange`, lazily (only when a Fleet view is mounted, per C4). Result states:
  `{ kind: 'modern', caps }` | `{ kind: 'legacy-caps', caps }` (has get_capabilities, no
  `features`) | `{ kind: 'legacy' }` (unknown message type / error) | `{ kind: 'unknown' }`
  (not connected). `hasFeature(serverId, f)` helper.
- `useCapabilities.ts` keeps working unchanged (it reads the same message; new fields are ignored).

---

### Phase 1 — Fleet Inbox (DETAILED)
**Size:** M–L. ~600 LOC daemon + ~400 LOC daemon tests, ~950 LOC web + ~300 LOC web tests
(includes daemon-synced seen state, decided 2026-09-24).
Roughly 3–5 focused days; splits cleanly into a daemon workstream and a web workstream (web can
start against the legacy-derivation path before the daemon lands).

#### Design
**Buckets** (fixed order), each item in exactly one:
1. **Needs you** — ranked by reason priority, then oldest-waiting first:
   `permission` (pending approval tool) > `question` (AUQ, JSONL or live pane) > `plan`
   (ExitPlanMode pending) > `worker_question` > `error` / `worker_error` (unacknowledged since the
   session's last user input) > `awaiting_reply` (turn finished, not yet seen by you).
2. **Working** — actively producing output / running tools / subagents running; shows
   `currentActivity`.
3. **Recently finished** — turn ended (or `session_completed`) within `recentWindowMs` (default 2h)
   and already seen/dismissed.
4. **Idle** — everything else, including `inactive` persisted sessions; collapsed by default.

**"Seen" state — SYNCED across devices (decided 2026-09-24)** (makes `awaiting_reply` vs Recently
finished work). Each session's **own daemon** is the source of truth for its sessions' seen
markers; no daemon-to-daemon traffic, no replication (every session lives on exactly one daemon,
so there is nothing to merge across daemons).
- **Marker:** per `tmuxSessionName` a watermark `seenUpTo: number` (ms, **daemon clock**), plus
  `seenAt` / `seenBy` (client label, for debugging). An item is seen iff `seenUpTo >= turnEndedAt`.
  Keyed by tmux name (stable within a daemon, survives `/clear` and conversation-file rotation,
  which a JSONL session id / message uuid would not). A reused tmux name is harmless: the new
  session's `turnEndedAt` is later than the stale watermark, so it shows as unseen.
  Timestamp watermark (not a message/turn id) chosen because it is totally ordered, which makes
  "max wins" trivial, and `turnEndedAt` is already computed for the Inbox item.
- **Clock skew:** the client never supplies wall-clock time of its own. `mark_seen { upTo? }` sends
  the `turnEndedAt` value the daemon itself reported for the item the user saw (so seeing an old
  turn cannot swallow a newer one that arrived meanwhile); omitted → daemon uses its current
  `turnEndedAt` for that session. Values > daemon `now` are clamped.
- **Races (multiple devices):** monotonic — `seenUpTo = max(stored, incoming)`; a lower value is a
  no-op that still returns the effective marker. No un-see/undo in v1 (an "unread" action would need
  a separate explicit `clear` op; deferred).
- **What counts as seen:**
  1. *Opening the session* (SessionView mounted **and** document visible, for ≥ ~1.5s, debounced so
     swiping through sessions doesn't mark everything) → `mark_seen` with the latest `turnEndedAt`
     the client has; re-sent when a new turn ends while the view stays open and visible.
  2. *Answering* — the daemon marks seen **implicitly** inside `send_input` / `send_choice` /
     `send_worker_input` for the answered session (upTo = now). Server-side, so it also works from
     old clients and the terminal-less paths; no extra round trip.
  3. *Explicit "Dismiss"* on an Inbox card → `mark_seen`.
  NOT seen: appearing in the Inbox list, a push/browser notification being delivered or tapped
  without the session opening, the app being foregrounded on the Dashboard.
- **Escalation tie-in:** `mark_seen` also calls `escalation.acknowledgeSession(<that session>)` —
  if you saw it on the desktop, the phone push is cancelled. (Internal behaviour, only triggered by
  new clients.)
- **Live update:** after a marker advances, the daemon sends `session_seen { tmuxSessionName,
  seenUpTo, seenAt }` to **fleet-subscribed clients only** (C4: nothing new to clients that never
  opened the Inbox). Non-subscribed / polling clients pick it up from the `seenUpTo` field in the
  next `get_fleet_inbox`.
- **Persistence:** `~/.companion/inbox-seen.json` `{ version: 1, sessions: { [tmux]: { seenUpTo,
  seenAt, seenBy? } } }`, written with the existing `atomicWriteFileSync` (`daemon/src/utils.ts`)
  with mode `0o600`; loaded lazily on first `mark_seen`/`get_fleet_inbox` (not at boot); writes
  coalesced (≤ 1 write / `SEEN_WRITE_DEBOUNCE_MS` = 1s, timer only exists while a write is pending,
  flushed on shutdown). Pruned on write: entries whose tmux session no longer exists and
  `seenAt` > 30 days old; hard cap 1000 entries. Corrupt/missing file → start empty, log once.
- **Older daemons (no `inbox_seen_sync_v1` in `features`):** fall back to per-device
  `localStorage` seen state **for those servers only** (map `serverId:tmuxSessionName → seenUpTo`,
  using that daemon's `lastActivity`-derived turn end). When a server later advertises the feature,
  the client does a one-time upload of its local entries for that server via `mark_seen` (max-wins
  makes this safe from every device) and then deletes them locally.
- **Offline daemon:** `mark_seen` for a disconnected server is queued in memory (latest per session)
  and flushed on reconnect; the card is shown seen optimistically meanwhile.
- The "Count finished turns as Needs you" setting (default **ON**, decided) stays a **per-device UI
  preference** (localStorage) — only the seen marker is synced. OFF sends finished turns straight to
  Recently finished.

**Daemon side — `get_fleet_inbox`:** one round trip returning classified items for all tagged
sessions on that daemon.
- Base data: reuse `watcher.getServerSummary(tmux.listSessions())` + friendly names + subagent
  counts (same enrichment as `get_server_summary`; factor into a shared helper
  `buildSessionSummaries(ctx)` in `handlers/session.ts` so both handlers use it — no behavior change
  for `get_server_summary`).
- Classification: pure function `classifyAttention(input)` in `daemon/src/fleet/attention.ts`
  using the conversation's cached messages: `getPendingApprovalTools` → `permission` (+ tool name
  and a one-line summary: Bash command / file path), pending `AskUserQuestion` in JSONL →
  `question` (questions from `extractHighlights` last highlight), pending `ExitPlanMode` → `plan`,
  worker membership from `workGroupManager` (`status === 'waiting'` + `lastQuestion` →
  `worker_question`; `status === 'error'` → `worker_error`), notification history
  (`store.getHistorySince(lastUserInputTs)`, `eventType === 'error_detected'`, not acknowledged) →
  `error`, `isWaitingForInput` with no blocking reason → `awaiting_reply`.
- **Live AUQ probe (gated, C5):** only for *candidate* sessions: summary status `working` (or
  `idle` with a live tmux pane), JSONL unchanged for ≥ `FLEET_AUQ_STALL_MS` (4s), tagged tmux
  session present in the `listSessions()` result just fetched (liveness check). Implementation in
  `daemon/src/fleet/live-prompt-probe.ts`:
  - per-session in-flight promise map (dedup concurrent requests from multiple clients),
  - per-session result cache keyed by `(tmuxName, conv.lastModified)` with TTL
    `FLEET_PROBE_TTL_MS` (3s),
  - global concurrency cap `FLEET_PROBE_MAX_CONCURRENT` (4),
  - uses `injector.captureTmuxPane` (already `runTmux` with `TMUX_OPERATION_TIMEOUT_MS` +
    SIGKILL) + `detectActiveChoicePrompt`; any failure → no prompt (never throws),
  - no timers — runs only inside `get_fleet_inbox`.
  A live choice → reason `question`, bucket Needs you, `liveSourced: true`.
- **Prompt identity:** every inline prompt gets a stable `promptId`: live choices reuse
  `liveChoiceHighlightId(sessionId, question)` (already in `handlers/session.ts`); JSONL prompts use
  the tool_use id. Used for the staleness guard below.
- Preview: last assistant text, whitespace-collapsed, truncated to `previewChars` (default 160).
- Also returns daemon identity (`hostname`, `platform`) so cards can show machine tags even when the
  user's server name is generic.

**Push (optional, `fleet_inbox_push_v1`):** `fleet_subscribe { enabled }` marks the client;
subscribed clients receive `fleet_inbox_changed { sessionIds, at }` (a cheap invalidation hint,
debounced 750ms, triggered from watcher `status-change` / `other-session-activity` /
`error-detected` / `session-completed` and `work-group-update`). Client then re-fetches
`get_fleet_inbox`. Keeps payloads small and avoids a second classification codepath. Non-subscribed
clients (all existing ones) see no new traffic. Polling (5s visible / paused when hidden) remains the
baseline so the feature works without push.

**Staleness guard for inline answers (`choice_expect_prompt_v1`):** optional
`expectPromptId?: string` on `send_choice` and `send_input`. If present, the daemon re-derives the
session's current prompt id (JSONL pending tool id, or fresh pane probe bypassing cache) and replies
`{ success: false, error: 'prompt_changed' }` on mismatch without sending keys. Old daemons ignore
the field (so for legacy daemons the web re-fetches immediately before sending and shows a
"prompt may have changed" confirm if the list changed). Behaviour without the field is unchanged.

**Escalation ack fix:** in `send_input` / `send_choice`, additionally call
`escalation.acknowledgeSession(<resolved session>)` for the session actually answered (keep the
existing active-session ack). Internal, non-protocol change.

**Web side:**
- `useFleetInbox()` merges per-server results:
  - modern daemon (`fleet_inbox_v1`) → `get_fleet_inbox`;
  - legacy daemon → derived from `get_server_summary` (`waiting` → Needs you/`awaiting_reply`,
    `working` → Working, else Idle/Recently finished by `lastActivity`), plus bounded
    enrichment: for `waiting` sessions only, `get_highlights { sessionId, limit: 3 }` (max 2
    concurrent per server, cached by `lastActivity`) to surface JSONL-visible permission/AUQ/plan
    prompts inline. Live-pane AUQ is only available if that daemon's `get_highlights` already
    scrapes (post-5b4c68c) — otherwise shown as a normal card. Legacy servers get a subtle
    "limited — update daemon" chip on the machine tag, never an error.
  - disconnected servers: last-known items kept, dimmed, with "offline since …" and prompts
    disabled.
- Pure merge/sort/bucket logic lives in `web/src/utils/fleetInbox.ts` (unit-testable), the hook only
  does IO.
- **Cards** (`InboxCard.tsx`): machine tag (server name, tinted per server), project tag
  (basename of `projectPath`, full path on hover/long-press), friendly/tmux name, reason chip,
  relative time ("waiting 12m"), preview (2 lines), work-group chip if a worker, subagent count.
  Needs-you cards render the prompt inline (`InboxPrompt.tsx`):
  - `question` → existing `QuestionBlock` wired to `send_choice` with `tmuxSessionName` +
    `expectPromptId`; multi-question AUQs: answer current, card re-fetches and shows the next
    (same as Chat behaviour after f5165c8).
  - `permission` / `plan` → option buttons (labels from highlight `options`) → `send_input(label)`
    exactly as `SessionView.handleSelectOption` does, plus "Open" for context.
  - `worker_question` → options/text → `send_worker_input`.
  - `awaiting_reply` → collapsed quick-reply field (`send_input`) + "Dismiss".
  - After a successful send: optimistic "Sent" state + optimistic seen (the daemon marks it seen
    server-side; legacy servers → local seen), re-fetch that server.
  - Failures use the existing error toast pattern; `prompt_changed` → refresh card + inline notice.
- **Layout:**
  - Desktop: the Dashboard gains a segmented control at the top of the sidebar: **Sessions |
    Inbox (N)**. In Inbox mode the main pane shows `FleetInbox` (bucket sections, filter bar:
    machine, project, reason, text search). Clicking a card opens the session in the main pane with
    a "Back to Inbox" affordance; sidebar session list keeps working.
  - Mobile: `MobileDashboard` gets the same toggle in its header; Inbox is a full-screen list; tap a
    card → existing session view; Android back returns to Inbox (use existing `eventBus` /
    history pattern).
  - N badge = Needs-you count, only computed while the Inbox has been opened at least once this app
    session OR "Inbox as home" is set (C4).
- **Settings** (`SettingsScreen.tsx`): "Home view: Sessions (default) | Inbox";
  "Count finished turns as Needs you"; "Recently finished window". Keys in `storageKeys.ts`.
- Notification deep links / push behaviour: unchanged.

#### Data Model / Types (add to `daemon/src/types.ts` and mirror in `web/src/types/index.ts`)
```ts
export const FLEET_FEATURES = {
  INBOX: 'fleet_inbox_v1',
  INBOX_PUSH: 'fleet_inbox_push_v1',
  CHOICE_EXPECT_PROMPT: 'choice_expect_prompt_v1',
  SEEN_SYNC: 'inbox_seen_sync_v1',
} as const;

export interface SessionSeenMarker {
  tmuxSessionName: string;
  seenUpTo: number;             // daemon clock; monotonic (max wins)
  seenAt: number;               // daemon clock when last advanced
  seenBy?: string;              // client label, informational only
}

export interface MarkSeenRequest {
  tmuxSessionName: string;
  upTo?: number;                // a turnEndedAt value the daemon reported; omitted → current
  clientLabel?: string;
}
// Response `session_seen` payload = SessionSeenMarker (effective value after max-merge)

export type AttentionBucket = 'needs_you' | 'working' | 'finished' | 'idle';
export type AttentionReason =
  | 'permission' | 'question' | 'plan' | 'worker_question'
  | 'error' | 'worker_error' | 'awaiting_reply';

export type InboxPrompt =
  | { kind: 'question'; promptId: string; questions: Question[]; liveSourced: boolean }
  | { kind: 'permission'; promptId: string; toolName: string; summary: string; options: string[] }
  | { kind: 'plan'; promptId: string; excerpt: string; options: string[] }
  | { kind: 'worker_question'; promptId: string; groupId: string; workerId: string;
      question: WorkerQuestion };

export interface FleetInboxItem {
  tmuxSessionName: string;      // stable key within a daemon
  sessionId: string;            // same id get_server_summary uses
  friendlyName?: string;
  projectPath: string;
  bucket: AttentionBucket;
  reasons: AttentionReason[];   // highest priority first; [] for working/idle
  lastActivity: number;
  turnEndedAt?: number;         // when it last became waiting
  waitingSince?: number;        // when the current blocking reason appeared
  currentActivity?: string;
  preview?: string;
  prompt?: InboxPrompt;         // only for needs_you items with an answerable prompt
  workGroup?: { groupId: string; groupName: string; workerId: string; taskSlug: string };
  subagentRunning?: number;
  inactive?: boolean;
  lastError?: string;
  seenUpTo?: number;            // present only on inbox_seen_sync_v1 daemons
}

export interface FleetInboxResponse {
  items: FleetInboxItem[];
  generatedAt: number;
  host: { hostname: string; platform: string };
}

// CapabilitiesResponse — additive fields
//   features?: string[]; hostname?: string; platform?: string; arch?: string;
//   buildInfo?: { gitSha?: string; dirty?: boolean; builtAt?: string; branch?: string };
```
Web-only: `InboxEntry = FleetInboxItem & { serverId; serverName; source: 'modern' | 'legacy';
stale: boolean; seen: boolean; seenSource: 'daemon' | 'local' }`.

#### New / Changed WS Messages (all additive)
| Request | Response type | Notes |
|---|---|---|
| `get_fleet_inbox` `{ recentWindowMs?, previewChars?, includeIdle? = true }` | `fleet_inbox` `FleetInboxResponse` | new, `fleet_inbox_v1` |
| `fleet_subscribe` `{ enabled: boolean }` | `fleet_subscribed` | new, `fleet_inbox_push_v1` |
| (broadcast) | `fleet_inbox_changed` `{ sessionIds: string[]; at: number }` | only to fleet-subscribed clients |
| `mark_seen` `MarkSeenRequest` | `session_seen` `SessionSeenMarker` | new, `inbox_seen_sync_v1`; max-wins; also acks escalation for that session |
| (broadcast) | `session_seen` `SessionSeenMarker` | on advance only; only to fleet-subscribed clients (incl. the sender's other devices) |
| `get_fleet_inbox` | items carry optional `seenUpTo` | additive field |
| `send_input`, `send_choice`, `send_worker_input` | unchanged shape; daemon now also advances the seen marker for the answered session | internal side effect, no protocol change |
| `get_capabilities` | `capabilities` + `features`, `hostname`, `platform`, `arch`, `buildInfo` | new optional fields; `protocolVersion: 2` |
| `send_choice`, `send_input` | unchanged + optional `expectPromptId` → may return `error: 'prompt_changed'` | only when field supplied |

#### Files to Create
- `daemon/src/fleet/attention.ts` — `classifyAttention()` pure classifier + reason priority.
- `daemon/src/fleet/live-prompt-probe.ts` — gated, deduped, cached pane probe.
- `daemon/src/fleet/build-info.ts` — reads `dist/build-info.json` if present (used by capabilities;
  groundwork for Phase 4).
- `daemon/src/fleet/seen-store.ts` — lazy-loaded, max-merge, coalesced atomic persistence of
  `~/.companion/inbox-seen.json`, prune, flush-on-shutdown.
- `daemon/src/handlers/fleet.ts` — `get_fleet_inbox`, `fleet_subscribe`, `mark_seen`.
- `daemon/scripts/stamp-build.js` — writes `dist/build-info.json` (git sha, dirty, branch, builtAt;
  tolerates no-git) — hooked into `npm run build`.
- `daemon/src/__tests__/fleet-attention.test.ts`, `daemon/src/__tests__/fleet-inbox-handler.test.ts`,
  `daemon/src/__tests__/live-prompt-probe.test.ts`, `daemon/src/__tests__/seen-store.test.ts`.
- `web/src/services/capabilities.ts` — per-server capability cache + `hasFeature`.
- `web/src/utils/fleetInbox.ts` — legacy derivation, merge, bucket/sort, seen logic.
- `web/src/hooks/useFleetInbox.ts` — polling / push-invalidation IO, visibility pause.
- `web/src/hooks/useInboxSeen.ts` — seen-state router: daemon markers (`mark_seen`,
  `session_seen` listener, offline queue) for `inbox_seen_sync_v1` servers; localStorage fallback
  for legacy servers; one-time local→daemon upload when a server gains the feature.
- `web/src/components/FleetInbox.tsx` — buckets, filters, empty states (desktop + mobile).
- `web/src/components/InboxCard.tsx`, `web/src/components/InboxPrompt.tsx`.
- `web/src/utils/__tests__/fleetInbox.test.ts`, `web/src/services/__tests__/capabilities.test.ts`.

#### Files to Modify
- `daemon/src/types.ts` — types above; extend `CapabilitiesResponse`.
- `daemon/src/handlers/index.ts` — register `registerFleetHandlers`.
- `daemon/src/handlers/remote.ts` — `get_capabilities` adds `features`, host info, `buildInfo`,
  `protocolVersion: 2`.
- `daemon/src/handlers/session.ts` — extract `buildSessionSummaries(ctx)` shared by
  `get_server_summary` and `get_fleet_inbox` (no output change for the old handler); export a helper
  for current prompt id.
- `daemon/src/handlers/input.ts` — optional `expectPromptId` check; ack the answered session;
  advance seen marker for the answered session (`send_input`, `send_choice`, `send_worker_input`).
- `daemon/src/websocket.ts` — `fleetSubscribed` flag on client; debounced `fleet_inbox_changed`
  broadcast wired to existing watcher/work-group events (only to flagged clients); helper to send
  `session_seen` to flagged clients (NOT via the generic `broadcast()`, which targets every
  subscribed client).
- `daemon/src/index.ts` — flush `seen-store` on shutdown.
- `web/src/components/SessionView.tsx` — visible-and-open ≥ 1.5s → mark seen (via `useInboxSeen`).
- `daemon/src/constants.ts` — `FLEET_AUQ_STALL_MS`, `FLEET_PROBE_TTL_MS`,
  `FLEET_PROBE_MAX_CONCURRENT`, `FLEET_INBOX_CHANGED_DEBOUNCE_MS`, `DEFAULT_RECENT_WINDOW_MS`,
  `SEEN_WRITE_DEBOUNCE_MS`, `SEEN_PRUNE_AGE_MS`, `SEEN_MAX_ENTRIES`.
- `daemon/package.json` — `build` runs `stamp-build.js` after `tsc`.
- `bin/deploy-aj` — ensure `dist/build-info.json` is rsynced (it is inside `dist/`, verify).
- `web/src/types/index.ts` — mirrored types; `DaemonCapabilities` gains optional fields.
- `web/src/components/Dashboard.tsx` — view-mode state, segmented toggle, render `FleetInbox`, open
  session from inbox + back affordance.
- `web/src/components/MobileDashboard.tsx` — header toggle + inbox list.
- `web/src/components/SessionSidebar.tsx` — host the desktop segmented control.
- `web/src/components/SettingsScreen.tsx` — home view + inbox settings.
- `web/src/services/storageKeys.ts` — `HOME_VIEW_KEY`, `INBOX_SEEN_KEY` (legacy-server fallback only),
  `INBOX_FINISHED_AS_NEEDS_KEY`, `INBOX_RECENT_WINDOW_KEY`, `INBOX_FILTERS_KEY`.
- `web/src/styles/global.css` (+ `variables.css` if a server-tint palette is needed) — inbox styles.
- `FEATURES.md` — on ship, add "Fleet Inbox"; mark Away Digest UI as superseded.

#### Implementation Steps
1. **Prereq:** confirm the in-flight WS-reliability changes are committed; branch `feat/fleet-inbox`.
2. **Types:** add all Phase 1 types/constants to `daemon/src/types.ts` and mirror in
   `web/src/types/index.ts` (keep field order identical for easy diffing).
3. **Build stamp:** write `daemon/scripts/stamp-build.js` (spawnSync `git` with timeout; on any
   failure write `{ builtAt }` only); add to the `build` script; `daemon/src/fleet/build-info.ts`
   reads it once at startup (sync read at boot only is fine).
4. **Capabilities:** extend `get_capabilities` with `features` (list driven by a single exported
   `DAEMON_FEATURES` array), `hostname` (`os.hostname()`), `platform`, `arch`, `buildInfo`,
   `protocolVersion: 2`. Unit test: payload contains old fields unchanged + new ones.
5. **Shared summaries:** extract `buildSessionSummaries(ctx)` from `get_server_summary`; verify the
   existing handler output is byte-identical with a test snapshot of a fixture.
6. **Classifier:** implement `classifyAttention({ summary, messages, isWaiting, workerInfo,
   recentErrors, livePrompt, now, recentWindowMs })` → `{ bucket, reasons, prompt?, waitingSince?,
   turnEndedAt? }`. Reuse `getPendingApprovalTools`, `extractHighlights` (last highlight only), and
   `detectWaitingForInput` from `parser.ts`. Table-driven tests (step 13).
7. **Live probe:** implement `live-prompt-probe.ts` (in-flight map, TTL cache, semaphore of 4,
   liveness = name present in the `listSessions()` snapshot passed in; never throws). Candidate
   predicate exported separately for testing.
8. **Handler:** `handlers/fleet.ts` `get_fleet_inbox`: listSessions → summaries → per-session gather
   (cached messages, worker map from `workGroupManager.getGroups()`, error events from
   `push.getStore().getHistorySince(since)`) → probe candidates in parallel (bounded) → classify →
   sort (bucket, priority, waitingSince asc, lastActivity desc) → send `fleet_inbox`. Log duration
   when > `SLOW_OPERATION_THRESHOLD_MS`.
9. **Staleness guard + ack fix:** in `handlers/input.ts`, when `expectPromptId` is present compute the
   current prompt id (JSONL pending tool id, else fresh probe with cache bypass) → `prompt_changed`
   on mismatch. Add `escalation.acknowledgeSession(resolvedSession)`. Tests for both paths and for
   "field absent → unchanged behaviour".
10. **Push invalidation:** `fleet_subscribe` sets `client.fleetSubscribed`; in `websocket.ts` add a
    debounced collector fed by `status-change`, `other-session-activity`, `error-detected`,
    `session-completed`, `work-group-update` that sends `fleet_inbox_changed` only to flagged
    clients. Advertise `fleet_inbox_push_v1`.
10b. **Synced seen state:** `fleet/seen-store.ts` (lazy load, `markSeen(tmux, upTo, label)` →
    max-merge, clamp to now, returns effective marker + `advanced` flag; coalesced atomic write
    `0o600`; prune; `flush()`), `mark_seen` handler (validates tmux name exists or is in the store;
    resolves `upTo` default from the session's current `turnEndedAt`; acks escalation; on `advanced`
    sends `session_seen` to fleet-subscribed clients), implicit mark in the answer handlers,
    `seenUpTo` added to `get_fleet_inbox` items, shutdown flush. Advertise `inbox_seen_sync_v1`.
11. **Web capabilities service:** `services/capabilities.ts` with lazy fetch per server on connect,
    classification (`modern` / `legacy-caps` / `legacy` / `unknown`), invalidation on reconnect,
    `hasFeature()`. Does not touch `ServerConnection.ts`.
12. **Web data layer:** `utils/fleetInbox.ts` (pure: `deriveLegacyItems`, `mergeServerItems`,
    `bucketize`, `applySeen` (daemon `seenUpTo` when present, else local map; optimistic pending
    marks overlay both), `applyFilters`), `hooks/useInboxSeen.ts` (feature-routed; `session_seen`
    listener patches items in place without a re-fetch; offline queue; one-time local→daemon
    upload), SessionView open-and-visible mark, `hooks/useFleetInbox.ts`
    (poll every 5s while mounted & document visible; subscribe to `fleet_inbox_changed` where
    supported and refetch only that server; bounded legacy enrichment; keep last-known items for
    disconnected servers marked `stale`).
13. **Tests (daemon):** `fleet-attention.test.ts` — permission pending (Bash + Edit), AUQ pending in
    JSONL, live pane AUQ (reuse fixtures from `auq-side-panel.test.ts` /
    `input-injector-overlay.test.ts`), multi-question AUQ, ExitPlanMode, worker waiting with
    question, worker error, error_detected after last input (and acknowledged/older → ignored),
    finished turn inside/outside window, working, idle, inactive, priority ordering when several
    reasons apply. `live-prompt-probe.test.ts` — 2 concurrent calls → 1 capture; TTL reuse; cache
    invalidated when `lastModified` changes; >4 candidates → never >4 captures in flight; capture
    throws/timeout → null; non-candidates (recent JSONL write, missing tmux session) never captured.
    `fleet-inbox-handler.test.ts` — sort order, previews truncated, host info present, legacy
    `get_server_summary` unchanged, `expectPromptId` mismatch returns `prompt_changed` and does not
    call `sendChoice`, items carry `seenUpTo`. `seen-store.test.ts` — max-wins (lower/equal value
    is a no-op, returns effective marker, `advanced=false`); future `upTo` clamped to now; two
    interleaved "devices" converge; persistence round-trip via atomic write; corrupt file → empty
    store; prune (gone + old) and cap; no file I/O and no timer before first use; writes coalesced.
    Handler tests: `mark_seen` → `session_seen` sent to fleet-subscribed clients only (non-subscribed
    and other daemons' clients get nothing), not sent when not advanced; escalation acked;
    `send_input`/`send_choice` advance the marker for the answered session (not the active one).
14. **Tests (web, vitest):** `fleetInbox.test.ts` — legacy derivation mapping, merge of modern +
    legacy + disconnected servers, bucket ordering, seen logic (daemon `seenUpTo` before/after turn
    end, local fallback only for servers without `inbox_seen_sync_v1`, optimistic overlay, incoming
    `session_seen` patch, setting OFF), filters. `useInboxSeen` logic: offline queue keeps latest
    per session and flushes on reconnect; one-time local→daemon upload then local entries cleared. `capabilities.test.ts` — `features` present → modern; caps without features →
    legacy-caps; `Unknown message type` error → legacy; reconnect clears cache.
15. **UI components:** `InboxPrompt.tsx` (reuse `QuestionBlock`; permission/plan buttons; worker
    question; quick reply), `InboxCard.tsx`, `FleetInbox.tsx` (sections with counts, Idle collapsed,
    filter bar, empty state "Nothing needs you", legacy/offline chips). CSS with existing variables
    only.
16. **Wire into Dashboard/MobileDashboard:** segmented toggle, view-mode state (persist last mode
    only if "Inbox as home" is set), open-session-from-inbox with back affordance, Android back
    handling via existing `eventBus`/history pattern, Needs-you badge (C4 gating).
17. **Settings:** home view, finished-as-needs toggle, recent window; storage keys.
18. **Manual verification** (see test plan), then `cd web && npx tsc --noEmit`, `npm test` in daemon
    and web. Builds/deploys only with user approval; daemon restart only with explicit sign-off.
19. **Docs:** FEATURES.md entry on ship; update `CLAUDE.md` WebSocket Protocol list with new message
    types.

#### Test Plan — Manual
- **Default untouched:** fresh install / existing user → app opens on the existing Dashboard; no
  `get_fleet_inbox` or `get_capabilities` in daemon logs until the Inbox toggle is clicked (C4).
- **Mixed fleet:** local daemon on new build + AJ's daemon (or a second local daemon) on the current
  build. Inbox lists both; old one shows the "limited — update daemon" chip; its waiting sessions
  still appear under Needs you; existing Dashboard for the old daemon fully functional.
- **Pre-capabilities daemon:** point at a checkout older than the MCP work (or stub a daemon that
  rejects `get_capabilities`) → treated as legacy, no errors in console beyond one debug line.
- **Answer inline:** (a) single AUQ via live pane, (b) multi-question AUQ advances to Q2 on the card,
  (c) permission prompt (Bash) approve/deny, (d) ExitPlanMode, (e) worker question from a `/work`
  group, (f) quick reply to a finished turn. Each: session proceeds, card moves bucket within ~5s,
  push escalation for that session is cancelled (check notification history `acknowledged`).
- **Staleness:** answer the prompt in the terminal, then press an option on the (stale) card → modern
  daemon returns `prompt_changed`, card refreshes; nothing is typed into the pane.
- **Mobile:** Android APK + mobile web: toggle, scroll, inline answer, tap-through and back gesture
  returns to Inbox, safe-area insets OK.
- **Load / C5:** 20+ tagged sessions with 5 "stalled working" → `get_fleet_inbox` p95 < 200ms warm;
  `pgrep -c tmux` does not climb while Inbox is open for 10 min on two clients; kill a tmux session
  mid-probe → no hung capture.
- **Offline server:** disconnect a daemon → its cards dim with "offline since", prompts disabled,
  reconnect restores.
- **Synced seen:** phone + desktop both on the Inbox. Finish a turn → Needs you on both. Open the
  session on desktop → within ~2s the phone card moves to Recently finished without a manual
  refresh; the pending push for that session is cancelled. Dismiss on phone → desktop updates.
  Restart-free check: `~/.companion/inbox-seen.json` written, `0o600`. Stale mark race: open an
  old turn on one device while a new turn ends → new turn stays Needs you. Legacy daemon in the
  mix: its seen state stays per device and nothing errors; after upgrading it, the device's local
  seen entries appear on the other device.

#### Acceptance Criteria
- [ ] Dashboard remains the default home; Inbox reachable via a toggle on desktop and mobile; the
      "Inbox as home" setting works and is off by default.
- [ ] Every tagged session on every connected daemon appears in exactly one bucket, ordered Needs you
      → Working → Recently finished → Idle, with machine + project tags and preview.
- [ ] Pending AUQ (including live, not-yet-flushed AUQ), permission, plan and worker questions on
      modern daemons render inline and can be answered without opening the session.
- [ ] Inline answers are guarded against stale prompts on modern daemons (`prompt_changed`) and
      cancel push escalation for the answered session.
- [ ] Older daemons: all existing views unchanged; in the Inbox they appear with reduced data and a
      "needs update" indicator; no error banners.
- [ ] No existing WS message/field changed; `get_server_summary` output identical (test-enforced).
- [ ] With the Inbox never opened, no new requests are sent and no new daemon work happens.
- [ ] Pane probes: deduped, cached, concurrency-capped, timeout+SIGKILL, liveness-checked; no
      intervals added on the daemon (push path is event-driven + debounced).
- [ ] Seen state is synced: seeing/answering/dismissing on one device updates every other
      Inbox-open device live (and others on next fetch); markers survive daemon restart; concurrent
      marks converge (max wins); a stale mark never hides a newer turn.
- [ ] Unseen finished turns land in Needs you by default; the per-device setting moves them to
      Recently finished.
- [ ] Daemons without `inbox_seen_sync_v1` fall back to per-device seen state for those servers
      only, with no errors.
- [ ] Unit tests listed above pass; `tsc --noEmit` clean.

#### Open Questions / Risks (Phase 1)
- **Q1** ~~Should "turn finished, not yet seen" count as Needs you by default?~~ **Decided
  2026-09-24: yes**, with the per-device setting to turn it off.
- **Q2** Desktop placement: plan default = Inbox in the main pane with the sidebar kept. Not
  blocking.
- **Q3** ~~Seen state per device or synced?~~ **Decided 2026-09-24: synced via each session's own
  daemon** (`mark_seen`, feature `inbox_seen_sync_v1`).
- **R4** Seen markers are keyed by tmux session name. Sessions that are renamed or killed and
  recreated under the same name are handled by the timestamp watermark, but a rename loses the
  marker (it shows as unseen once). Acceptable.
- **R5** The implicit "answered ⇒ seen" in the answer handlers also fires for answers from old
  clients and the MCP (`remote_send_input`). That is the intended meaning, but it means a
  concierge-driven answer marks a session seen for the user. Revisit if that is confusing
  (could skip the implicit mark when the request comes from an MCP/per-origin token).
- **R1** Live-AUQ detection relies on pane parsing that has been fragile (five `fix(auq)` commits).
  The Inbox multiplies the surface; keep the probe code path identical to `get_highlights` to avoid
  divergence.
- **R2** Permission-prompt option labels depend on Claude Code's current prompt text; reuse whatever
  `extractHighlights` produces today so Chat and Inbox fail/succeed together.
- **R3** Tagged-session only: untagged tmux sessions stay invisible (existing gotcha) — surface a
  hint in the empty state.

---

### Phase 2 — Missions + Mission Notes (design-level)
**Size:** L. ~2 weeks. Absorbs todo "Server-level / session-persistent working memory".

#### Concept
A **Mission** is a persisted object above sessions: `goal`, `type`, `status`, `members` (sessions on
any daemon), per-member status/result, an aggregated `summary`, and **mission notes** — an
append-only log of what was tried / ruled out / being fixed / decided. Notes are injected into any
session that picks up the work (on join, on dispatch, and after compaction), so context survives
daemon restarts, session restarts and compaction.

#### Key Decisions
- **Where state lives: the daemon where the concierge runs (decided 2026-09-24), no replication.**
  There is no separate "Fleet home" setting. Every mission is stored on the concierge's daemon at
  `~/.companion/missions/<id>.json` (atomic tmp+rename via `atomicWriteFileSync`, `0o600`) plus an
  index. Missions created from the web (`adhoc`) are sent to the concierge daemon too: the web
  identifies it as the server whose `get_capabilities` reports `features` ∋ `missions_v1` **and**
  a running/configured concierge (new capabilities field `conciergeHost: boolean`). If several
  daemons report a concierge, the web uses the one the concierge view is attached to and shows the
  others' missions read-only-merged; if none is connected, "New mission" is disabled with "concierge
  daemon offline". Missions carry `homeServer` so a later concierge move is visible, but v1 does not
  migrate them. Justification: daemons never talk to each other except through the MCP/registry; the web
  client is not durable or multi-device; replication would need conflict resolution for little gain
  (one user, low write rate). The web shows missions from all daemons by calling `list_missions` on
  every `missions_v1` daemon and merging — so "global" view without shared state. Cost: if the home
  daemon is offline, its missions are read-only-unavailable (shown as offline).
- **Cross-host member status:** the home daemon tracks remote members through a `MissionTracker`
  that reuses the MCP daemon client (lift `mcp/src/daemon-client.ts` into a shared module or copy)
  with the auto-derived `~/.companion/mcp-servers.json` registry; it polls only *active* missions'
  remote members, event-driven where possible, and follows C5 discipline (in-flight dedup,
  timeouts, backoff, stop when mission done). Members with no registry entry are status `unknown`;
  the web overlays live status from Inbox data for display only.
- **Membership link on the member's daemon (thin, derived):** each member daemon stores
  `~/.companion/mission-links.json` `{ tmuxSessionName → { missionId, homeServer } }` so it can
  answer "which mission is this session in?" locally (for compaction re-injection and Inbox chips).
  It is a cache; the home daemon is the source of truth.
- **Mission types instead of separate state:** `adhoc` (user-created), `concierge_fanout`,
  `work_group`. Work groups are *projected* into missions (read-only adapter over
  `work-groups.json`, additive optional `missionId` on `WorkGroup`) — no migration of
  `WorkGroupManager` in Phase 2. Concierge fan-outs create a mission only when the user starts one
  ("Start as mission" in the concierge view, or asks the concierge to) — plain concierge chat
  unchanged (C1).
- **Note injection:** (a) *dispatch time* — `remote_dispatch` / spawn from a mission prepends a
  capped "Mission brief" (goal, current summary, last N notes, ≤ 4 KB) to the prompt; (b) *join* —
  "Attach session to mission" offers "Send brief" (explicit `send_input`); (c) *after compaction* —
  Claude Code `SessionStart` hook (matcher `compact|resume`) installed into the project repo
  (**approved 2026-09-24**), which calls the local daemon (`get_mission_brief { cwd |
  tmuxSessionName }`, proxied to the concierge/home daemon) and prints the brief as additional
  context. (d) sessions can append notes themselves via new MCP tools.
- **SessionStart hook install rules (approved; all required):**
  - *Opt-in per repo:* installed only by an explicit action ("Install compaction re-injection" on
    the mission/member, or `bin/companion mission-hook install <repo>`); never automatically on
    dispatch or mission creation.
  - *Merge, never clobber:* read `<repo>/.claude/settings.json` (or `settings.local.json` if the
    user picks "don't commit" — default `settings.local.json`, which is normally gitignored, to
    avoid dirtying the repo), JSON-parse, append one entry to `hooks.SessionStart` preserving all
    existing hooks/keys/order, write back atomically. Unparseable file → abort with a message, never
    overwrite.
  - *Idempotent:* our entry is identified by a marker (command path
    `~/.companion/bin/mission-brief-hook` + `"companion-mission-hook": 1` tag in a sibling key or the
    command string); re-install updates it in place, never duplicates.
  - *Easy uninstall:* `bin/companion mission-hook uninstall <repo>` + an in-app button remove only
    our entry (and an empty `SessionStart` array we created); `mission-hook status` lists repos
    with it installed (tracked in `~/.companion/mission-hooks.json`).
  - *No-op without an active mission:* the hook script exits 0 with no output in < 200ms when the
    daemon is unreachable (short timeout), the session/cwd has no mission link, or the mission is not
    `active`. It must never block or fail session start.
  - Brief output capped (4 KB) and clearly delimited ("Mission brief (Companion) …").
- **Summary:** deterministic by default (per-member last result highlight, one line per member); a
  concierge-owned mission may overwrite with an LLM summary via `mission_update`.

#### Data Model (sketch)
```ts
interface Mission {
  id: string; title: string; goal: string;
  type: 'adhoc' | 'concierge_fanout' | 'work_group';
  status: 'active' | 'paused' | 'done' | 'abandoned';
  homeServer: { hostname: string; label?: string };
  createdAt: number; updatedAt: number; createdBy: 'user' | 'concierge' | 'foreman';
  members: MissionMember[]; summary?: string; notes: MissionNote[];
  workGroupId?: string;
}
interface MissionMember {
  id: string; serverName: string; host?: string; port?: number;
  tmuxSessionName: string; sessionId?: string; cwd: string; branch?: string;
  role?: string; status: 'pending' | 'working' | 'needs_you' | 'done' | 'error' | 'unknown';
  result?: string; joinedAt: number; lastSeenAt?: number;
}
interface MissionNote {
  id: string; ts: number; author: string;   // 'user' | 'concierge' | 'session:<name>@<host>'
  kind: 'tried' | 'ruled_out' | 'fixing' | 'decision' | 'result' | 'note';
  text: string; memberId?: string;
}
```

#### New WS Messages (feature `missions_v1`)
`list_missions`, `get_mission`, `create_mission`, `update_mission`, `add_mission_member`,
`remove_mission_member`, `append_mission_note`, `get_mission_brief`, `get_mission_links`;
broadcast `mission_update` (global, only to clients that sent `missions_subscribe`). MCP tools:
`mission_create`, `mission_get`, `mission_add_member`, `mission_note`, `mission_update`,
`mission_brief`. Writes from per-origin tokens require `dispatch` capability; audit-logged.

#### Files (anticipated)
- Create: `daemon/src/missions/mission-store.ts`, `daemon/src/missions/mission-tracker.ts`,
  `daemon/src/missions/brief.ts`, `daemon/src/handlers/missions.ts`,
  `mcp/src/tools/mission_*.ts`, `web/src/hooks/useMissions.ts`,
  `web/src/components/MissionsView.tsx`, `web/src/components/MissionDetail.tsx`,
  `web/src/components/MissionNotes.tsx`, `daemon/src/missions/hook-installer.ts` (merge /
  idempotent / uninstall logic, unit-tested against fixtures with pre-existing hooks),
  `daemon/scripts/mission-brief-hook` (installed to `~/.companion/bin/`),
  `bin/companion mission-hook install|uninstall|status`.
- Modify: `daemon/src/types.ts`, `web/src/types/index.ts`, `daemon/src/handlers/index.ts`,
  `daemon/src/handlers/remote.ts` (brief prefix on dispatch), `daemon/src/work-group-manager.ts`
  (optional `missionId`), `concierge/CLAUDE.md` (mission-aware routing, opt-in),
  `web/src/components/ConciergeView.tsx` ("Start as mission"), `FleetInbox`/`InboxCard` (mission chip
  + group-by-mission filter).

#### Acceptance Criteria
- Missions survive daemon restart and session compaction (brief re-injected after compaction when
  hook installed); nothing changes for users who never create one.
- A concierge fan-out started "as mission" shows all members across machines with live status and a
  summary; the concierge can append notes; a newly dispatched session starts with the brief.
- Work groups appear as missions (read-only projection) without changing `/work` behaviour.
- Missions are stored only on the concierge's daemon; web "New mission" targets it.
- Hook install into a repo with existing `SessionStart`/other hooks preserves them byte-for-byte
  apart from our appended entry; install twice → one entry; uninstall → file equals the
  pre-install content (modulo formatting); hook prints nothing and exits 0 when there is no active
  mission or the daemon is down.

#### Decisions / Plan Defaults
- **Q4** ~~Fleet home setting?~~ **Decided 2026-09-24: mission home = the concierge's daemon**; no
  separate setting.
- **Q5** ~~SessionStart hook into project repos?~~ **Decided 2026-09-24: approved**, under the
  install rules above (opt-in per repo, merge, idempotent, uninstallable, no-op without mission).
- **Q6** Notes explicit only in v1 (user, concierge, sessions via MCP); no LLM auto-extraction.
  Plan default, not blocking.
- **R** Tracker polling across machines is a new recurring network loop — must stop when missions
  are idle and honour C5.

---

### Phase 3 — Routing + Fleet Inventory (design-level)
**Size:** M–L (inventory M, placement S, handoff stretch M).

#### Design
- **Inventory (`inventory_v1`):** new `get_host_inventory` handler returning host facts (hostname,
  platform, arch, OS release, CPUs, loadavg, memory, uptime), toolchains (`claude --version`, node,
  git, xcodebuild, java/gradle, Android SDK, cargo — presence + version), and repos. Repo discovery
  from a bounded set: configured `inventory.repo_roots` (new optional config), dirs in
  `tmux-sessions.json`, concierge `projects.json` cwds, and recent working dirs. Per repo: normalized
  remote URL (to match the same repo across hosts), branch, dirty file count, ahead/behind, last
  commit. All execs on demand, stale-while-revalidate cache (toolchains 1h, repos 60s), in-flight
  dedup, timeout + SIGKILL, max 2 concurrent git processes (C5). No background interval.
- **Reachability:** from the client's perspective (connection state + ping RTT, which the web already
  has) and, for the concierge, from the MCP registry.
- **Remote capabilities:** already available via `get_capabilities`.
- **Placement engine:** pure `web/src/utils/placement.ts` (mirrored as an MCP helper so the concierge
  can use the same rules): input = task hints (explicit tags or keyword match like
  `projects.json`: ios → darwin + xcodebuild; android → Android SDK), target repo remote URL,
  preferences; output = ranked hosts with human-readable reasons ("has repo, clean, Xcode 17,
  load 0.4") and disqualifiers ("dispatch disabled", "offline"). Surfaced in `NewSessionPanel`, the
  mission creation flow and concierge; always a suggestion with one-tap override (C1).
- **Fleet view:** `FleetView.tsx` machines grid (inventory + repos) — later the home for Phase 4.
- **Stretch — session handoff:** `handoff` wizard: source session → (confirm) commit WIP to a
  `handoff/<slug>` branch and push → target host fetch + worktree checkout (`create_worktree_session`
  already exists) → dispatch with mission brief/summary. Each step explicitly confirmed; aborts leave
  the source untouched.

#### New WS Messages
`get_host_inventory { refresh?: boolean }` → `host_inventory`; optional `get_repo_status { path }`.
Feature `inventory_v1`. Config: optional `inventory: { repo_roots?: string[]; scan_depth?: number }`.

#### Plan Defaults (not blocking; revisit at Phase 3 kickoff)
- **Q7** Scan known session dirs always; configured `inventory.repo_roots` only if set (off by
  default).
- **Q8** Handoff pushes WIP to a `handoff/<slug>` branch on the existing remote (each step
  confirmed); git-bundle-over-`remote_write` is a later alternative.

---

### Phase 4 — Fleet Health (design-level)
**Size:** 4a read-only S; 4b confirmed rolling update M.

#### Design
- **Build identity:** `dist/build-info.json` (from Phase 1 stamp) is the only reliable version
  source, required because AJ's box is a file copy without git. `get_capabilities.buildInfo` +
  new `get_health` (`health_v1`): uptime, node version, memory/CPU of the daemon process, listener
  config summary (no secrets), watcher stats (conversations tracked), last errors (existing
  `get_client_errors`-style ring buffer for daemon errors), tmux session count.
- **Drift flags (web, `FleetHealth.tsx`):** reference = the web client's own build sha (stamped via
  Vite define) or the newest sha seen in the fleet; flags: sha differs, dirty build, missing
  features the web uses, `protocolVersion` behind, pre-capabilities daemon ("unknown build"),
  deployed-by-copy hosts noted.
- **Rolling "Update fleet" (4b):** a wizard, one daemon at a time, strictly sequential:
  1. show current → target build and what will run;
  2. **explicit per-daemon in-app confirmation** ("Restart <name> now?") — **this counts as the
     required restart sign-off (decided 2026-09-24)**. Each daemon's restart is individually
     confirmed at the moment it is about to happen; no "confirm all", no pre-approval of the rest
     of the queue, no batch or unattended auto-restart, no auto-advance to the next daemon (C6);
  3. call new `self_update` handler, gated by a new `remote_capabilities.update` flag
     (disabled by default, audited), which runs the host's configured `update_command`
     (e.g. local: build + `COMPANION_ALLOW_RESTART=1 bin/companion restart`; AJ: launchd kickstart
     after rsync is done from the build host via `bin/deploy-aj`) detached (`systemd-run --user` /
     `launchctl`) so it survives the restart;
  4. wait for reconnect, verify new `buildInfo.gitSha`, check for orphan-port symptom (known gotcha:
     restart "succeeds" while an orphaned daemon keeps the port → sha unchanged ⇒ flag, stop);
  5. only then offer the next daemon. Any failure stops the rollout.
  The in-app confirmation is recorded in the audit log (who/when/which build) as the sign-off.
  The `update_command` passes `COMPANION_ALLOW_RESTART=1` only because that confirmation happened;
  the `confirmToken` is minted by `self_update_prepare` for one daemon, single-use, short TTL
  (e.g. 60s), so the sign-off cannot be reused for another daemon or replayed later. Restarts
  initiated by Claude in a terminal still need the user's in-conversation sign-off (unchanged).

#### New WS Messages
`get_health` → `health`; `self_update { targetSha?, confirmToken }` → `self_update_started`
(`self_update_v1`, requires `remote_capabilities.update`). `confirmToken` is a one-time value from a
preceding `self_update_prepare` call so a replayed request cannot restart a daemon.

#### Decisions / Plan Defaults
- **Q9** ~~Does in-app confirmation count as sign-off?~~ **Decided 2026-09-24: yes**, per daemon,
  each restart individually confirmed; no batch auto-restart.
- **Q10** Non-git hosts: build on hexi and push (current `bin/deploy-aj` model) in v1. Plan default,
  not blocking.
- **R** A self-update that fails half-way can take a daemon offline with no way to recover from the
  app; 4b must keep a documented manual fallback per host (`bin/deploy-aj`, `bin/companion`).

---

### Phase Ordering & Dependencies
- Phase 1 first (also delivers the capability handshake + build stamp used by all later phases).
- Phase 2 depends on Phase 1 (Inbox chips, capability detection); Phase 3 inventory can run in
  parallel with Phase 2; placement is most useful once missions exist.
- Phase 4a can be pulled forward anytime after Phase 1 (build stamp exists); 4b last.

---

## Item: Voice Front Layer (working name) — fleet-wide chief of staff
**Status:** in-progress — Phases 1 (text, named "Herald") and 2 (voice: neural TTS, push-to-talk
STT, voice interrupt, "Hey Jarvis" wake word) are merged to `main` and **deployed to the production
daemon (9877/9878) on 2026-09-30**: anthropic provider (`claude-haiku-4-5`), key via
`bin/companion install-secrets`, voice service as the `herald-voice` systemd user unit
(`bin/herald-voice install-unit`). The 9887 sandbox and its Tailscale :9890 front were retired; its
conversation was carried over to `~/.companion/herald/state.json`. Native apps still need an `/apk`
rebuild for the Herald UI (no native mic path yet). See "Phase 2 progress" below. Phases 3-5 planned.

### Goal & Rationale
A fast, always-available conversational entity layered **over** Claude Code sessions across the whole
fleet — the "Iron Man / JARVIS" experience; the bar is "no compromises". Two layers:
- **Deep layer** = the real Claude sessions: slow, heavy, do the actual work (may run 40+ minutes).
- **Front layer** = a fast/cheap model (Haiku-class, currently `claude-haiku-4-5`) that knows
  **about** the work but never does deep work or gives deep answers. A chief of staff. The user talks
  to it (voice via Wispr Flow or its own STT, or typed), it talks back (TTS or text).

Naming: final name TBD. Must NOT reuse "concierge" — that already names the shipped Global Concierge
(`daemon/src/handlers/concierge.ts`, `ConciergeView`, `concierge_open`), which is a *deep* Claude
session that fans work out. The front layer is the opposite: shallow, fast, talks about work.

Builds directly on **Item: Fleet (Inbox → Missions → Routing → Health)** above — the Fleet Inbox
(`get_fleet_inbox`, attention classification, synced `seenUpTo`) is exactly the prioritized inbox
this layer narrates and acts on. Together they are the differentiator vs Anthropic Remote Control
(single-session, no cross-machine awareness, no voice front layer).

### Behaviors
1. **Announce.** "Companion session finished; deploy session is blocked on a question." Waits for a
   gap — never talks over the user. Priority: **blocked-on-input > finished > progress**.
2. **Triage by depth, on request:** one-liner → gist → full read.
3. **Rewrite for ears.** Never read raw markdown, code, paths, or tables aloud; paraphrase ("changed
   the input injector"). Full verbatim only when explicitly asked.
4. **Relay / act.** "Tell it go ahead but skip tests" → `send_input` on the right session, then reads
   back a confirmation.
5. **Instant state lookups:** how long it has been running, what it was doing, what is waiting.
6. **Grounded.** May only paraphrase what sessions actually said. Past that: "I don't know — want me
   to ask it?". **Hallucinated status ("yeah, it deployed") is the #1 risk** — every status claim must
   trace to a session turn / inbox item fetched in this conversation.

### Guardrail Tiers for Actions
The user explicitly wants it to act — with guardrails for both *unclear/unsure* and
*dangerous-even-if-fairly-sure*.

| Tier | Examples | Behavior |
|------|----------|----------|
| **Free** | status, summaries, reads, inbox listing | Just do it. |
| **Echo** | answering an AUQ, "continue", "option 2" | Read back once with session name ("Telling *deploy* option 2, skip tests"); send unless the user says no/wait. |
| **Clarify** | ambiguous target (multiple sessions waiting), low STT confidence, utterance matches no option | Ask. Never guess. |
| **Hard confirm** | deploy, restart (incl. companion daemon), push, delete, force, prod, AJ's box, anything irreversible | Explicit confirm phrase or on-screen tap, even at 99% confidence. |

- **Danger is detected from BOTH sides:** the user's utterance AND the content of the pending
  question. If the session asks "deploy to prod?", a casual "yeah" gets hard-confirm.
- **Never silently batch.** "Tell them all to go ahead" → safe ones proceed (echoed), dangerous ones
  are split out and confirmed individually.
- Daemon restarts inherit the project hard rule (Fleet C6): per-daemon, explicit sign-off, never
  batched.
- Danger classification should be a pure, unit-testable function (keyword/pattern list + pending
  question text + target host), not left solely to the model's judgment; the model can escalate a
  tier but never lower one the classifier set.
- Every action (and its tier + confirmation) goes to the existing audit log
  (`daemon/src/audit-log.ts`).

### Architecture
- **One entity across the whole fleet** (all daemons), single prioritized inbox.
- **Brain runs server-side on a hub**, not on a device, so the conversation persists across devices;
  devices are just mic + speaker endpoints. Device handoff: conversation follows you desk → phone →
  iPad.
- **Inputs already exist:**
  - daemon session state + waiting-for-input detection — `daemon/src/parser.ts`
    (`isWaitingForChoice`, `extractHighlights`, `detectActiveChoicePrompt`);
  - pending AUQ via tmux-pane scraping (not on disk until answered — see `parseTextChoicePrompt`);
  - last-turn text (`get_highlights` / `get_full` in `daemon/src/websocket.ts`);
  - input injection — `send_input` in `daemon/src/handlers/input.ts` → `daemon/src/input-injector.ts`;
  - multi-daemon connections — `web/src/services/ConnectionManager.ts` (client side) and the
    `companion-remote` MCP (`mcp/src/`, `mcp/README.md`: `remote_list_sessions`,
    `remote_get_conversation`, `remote_send_input`, ...) for hub-side cross-daemon access;
  - Fleet Inbox (planned, Fleet Phase 1) for attention-sorted, seen-aware items.
- **Brain tools** (thin wrappers over the above): `inbox()` / `list_sessions()`,
  `summarize(session)`, `read_full(session)`, `send_input(session, text)`. Summaries are produced by
  the front model from fetched text; `read_full` returns verbatim for "read it to me" requests.
- **Pipeline:** STT → Haiku brain (tool use, Anthropic API) → TTS. Wispr Flow is one input path
  (great for dictation into text fields) but hands-free needs its own STT.
- **Hub placement (TBD):** likely a new daemon-side module (or sibling service) on one designated
  daemon, reaching the rest of the fleet the same way the concierge does (companion-remote /
  per-origin tokens). Clients connect to the hub over the existing WS protocol with new additive
  message types (Fleet C2/C3 apply: additive, feature-detected, zero cost when off).
- **Notification interplay:** announcements should coordinate with `daemon/src/escalation.ts`
  (browser → push) so the same event is not both spoken and pushed; an event heard/acknowledged via
  voice should mark it seen (Fleet `mark_seen`).

### Hardware / Hosting
User wants to use their own hardware; if usage is modest, a Mac mini or DGX Spark is an acceptable
host. Evaluation items (none decided):
- Local STT (Whisper-family, e.g. faster-whisper) on a GPU box / Spark for latency + privacy.
- Local TTS on the same box — candidates to evaluate for latency, quality, and voice identity.
- Brain via Anthropic API (Haiku) initially; evaluate a local model later.
- Remote reachability reuses existing tailnet / HAProxy routes.

### Usage Contexts & Devices
- **Desktop (FIRST voice target).** Gaming headphones with boom mic are primary (no echo problem).
  Studio mic is a bonus (needs echo cancellation or self-mute while speaking). Killer use case:
  gaming while sessions work — chime in ear, push-to-talk on a hotkey / mouse button (user is often
  on Discord voice, so no wake word while gaming), "later" snoozes the queue. Wake word + hard mute
  as options outside gaming.
- **Phone + earbuds.** Walking around the house; push-to-talk via earbud tap. iOS background mic is
  restrictive — needs native audio background-mode work in a Tauri plugin (alongside
  `desktop/src-tauri/plugins/`).
- **Park with iPad nearby.** Works whenever the device has connectivity (cellular/hotspot); daemons
  reachable via existing tailnet/HAProxy routes.

### Phases
1. **Text-only front layer** in the existing web app (typed or Wispr-dictated): server-side brain,
   fleet inbox, tools, grounding, guardrail tiers. Tune personality + guardrails before any audio.
2. **Desktop voice:** headphones, push-to-talk hotkey (+ optional wake word), chimes, TTS, local STT.
   Confirmed audio requirements:
   - **(a) Hide the mic from voice chat while talking to Herald.** While the user holds Herald's
     push-to-talk, their mic must not reach voice chat. Linux: PipeWire-mute ONLY Discord's input
     stream (Herald still hears them); restore on release. **On by default.**
   - **(b) Duck other audio while Herald speaks.** Setting: lower (default) / mute / leave alone,
     with an adjustable duck level. Restore when Herald finishes. Phones use OS audio focus
     (transient-may-duck on Android, `.duckOthers` on iOS) instead of per-app volume.
3. **Phone / earbuds push-to-talk** (iOS/Android native audio work).
4. **Device handoff** (conversation follows you across devices).
5. **Wake word / always-listening**, studio-mic echo handling.

### Phase 2 progress (2026-09-30, CPU-only hub)
Local voice service `bin/herald-voice` (Python/aiohttp, 127.0.0.1:9889, nice 10, capped threads;
`voice/`). The browser never talks to it: the daemon proxies over the authenticated WS
(`daemon/src/herald/voice/`, protocol section mirrored in `web/src/types/herald.ts`, test-enforced).
- [x] **Step 1 Neural TTS** (Kokoro fp32 ONNX, default voice `af_heart`, 27 English voices). Web
  requests per sentence; `ServerTtsEngine` plays a gapless WebAudio queue; barge-in cancels
  playback and server synthesis; falls back to Web Speech per sentence if the service drops.
  Measured: synthesis RTF 0.35-0.45; sentence -> audio 0.5-1.3 s (first long sentence is
  clause-split); LLM first token ~0.9 s dominates `message_start` -> first audio (~2.1 s).
- [x] **Step 2 Push-to-talk STT** (faster-whisper base.en int8, 4 threads). AudioWorklet -> 16 kHz
  PCM16 -> WS chunks. Hold the mic button, Space in an empty composer, or Ctrl+Shift+Space
  (configurable). 5.2 s clip -> 0.96 s; release -> transcript in composer 0.62 s (3 s utterance).
  HTTPS for the mic: `bin/herald-sandbox https` (Tailscale serve, tailnet-only, :9890).
- [x] **Step 3 Voice interrupt** (Silero VAD v5 in-browser, assets served locally). Talking over
  Herald stops it (client + server queue) and sends what you said. Arms only once mic permission
  exists; sensitivity low/normal/high.
- [x] **Step 4 Wake word** (openWakeWord `hey_jarvis`, server-side, VAD-gated streaming). Chime,
  capture to end-of-speech, send; one hands-free device at a time; visible indicator; paused when
  the tab is hidden (opt-out). Detection ~90 ms after the wake word; idle hands-free ~7% of one
  browser core, 0% voice service.
- [x] **Step 5 Quiet by default** (done 2026-09-30). Local voice commands (whole utterance only,
  `web/src/services/voice/voiceCommands.ts`): stop / repeat (cached audio) / shorter / go on /
  slower / faster / what's up. Spoken cap 2 sentences / 40 words + "say go on" tail; herald_send
  `mode` (voice -> brief per-turn [Reply style] note) and `intent` (shorter | more | brief);
  verbosity Auto/Brief/Normal/Detailed in Herald state (menu, or the brain's `set_verbosity`).
  Tones instead of unprompted speech: signature G-C-E earcon, one announcing device (daemon
  `herald_presence` arbitration), reminders for unheard blocks; "Brief me" (button, Ctrl+Shift+B,
  "what's up") reads only unheard items, max 3 + "and N more". Whisper vocabulary hints from live
  session names + jargon: base.en WER 20.6% -> 3.6% on Kokoro clips, no added latency; small.en
  measured 1.15-1.54 s for a 5 s clip idle (over the 1.2 s budget), not adopted. Barge-in fixed
  for hands-free (interrupt now arms without the Permissions API; a wake stream open when Herald
  starts speaking turns into an interrupt; "Hey Jarvis" always silences Herald).
- [ ] Not done yet: Discord mic hiding (a) and ducking (b) above; native (Tauri/Android/iOS) mic
  paths; GPU engines (swap in `voice/herald_voice/engines.py`).

#### Planned: custom "Herald" wake word
**Status:** planned
- Train an openWakeWord model on this box's CPU from synthetic clips (Kokoro and Piper voices saying
  "Herald" / "Hey Herald", varied speed, pitch, room noise) plus negative data (similar words,
  "Harold", everyday speech). Expect a few hours of CPU: run it as an overnight job through a
  `bin/` script (e.g. `bin/herald-voice train-wake`), resumable, nice'd.
- Load it with `HERALD_WAKE_MODELS=/path/hey_herald.onnx`; add its Whisper spellings to
  `WAKE_NAMES` in `daemon/src/herald/voice/wake-phrase.ts` (and the web `voiceCommands.ts` names).
- Keep "hey jarvis" loaded as a fallback option (setting to pick either or both).

#### Planned: global triggers & native desktop Herald
**Status:** planned. Machines: Windows gaming PC, this Linux box, a work Mac (Raycast). Mostly the
native apps, the browser a lot too.
1. **Remote trigger API (done 2026-09-30).** `POST /herald/trigger` + `herald_trigger`, scoped
   trigger token (`bin/companion trigger-token`), actions brief/listen/stop/repeat/toggle/claim,
   explicit device claiming with pin ("Take control"), scripts in `triggers/` (AutoHotkey v2 with an
   MX Master 3 gesture button via Logi Options+, Raycast, curl). Original spec:
   Authenticated daemon endpoint (HTTP POST + a WS message) with
   actions `brief`, `listen` (start capture, ends by VAD), `stop`, `repeat`, routed by the daemon to
   the ACTIVE device (same arbitration as tones and hands-free). Scoped trigger token, not the main
   daemon token. Ship ready-made triggers: AutoHotkey v2 script (+ how to map a G Hub / Synapse mouse
   side button to it) on Windows, a Raycast script command on the Mac, a `curl` one-liner for Stream
   Deck and iOS Shortcuts. Pick default keys that do not clash with Discord push-to-talk.
2. **Native desktop Herald (Tauri) (built 2026-09-30, branch `native/herald-voice`; needs on-device
   verification).** Global shortcuts via `tauri-plugin-global-shortcut` (hold Ctrl+Alt+Space to talk,
   Ctrl+Alt+Shift+H toggle, Ctrl+Alt+Shift+B brief; rebindable in the Herald voice menu, conflicts
   shown, Wayland note), tray items (Brief me, Toggle listening, Mute tones, Open, Quit), mic granted
   to the app's own origin on WebKitGTK and WebView2, macOS usage string + audio-input entitlement.
   Native input only emits `herald-native` events; `web/src/services/nativeBridge.ts` +
   `useNativeHerald` run the existing push-to-talk and trigger handlers. Still open: Discord mic
   hiding and ducking (seam: `desktop/src-tauri/src/herald.rs` TODO). Original spec:
   `tauri-plugin-global-shortcut` for system-wide shortcuts with
   true hold-to-talk (press + release), a tray / menu-bar orb, an always-available mic. Bundle with
   the Phase 2 audio items (hide the mic from Discord, duck other audio): both need native OS audio
   control (PipeWire on Linux, Windows audio session APIs, macOS equivalents). Caveats: macOS mic +
   input-monitoring permissions; limited global shortcuts on Linux Wayland.
3. **Mobile (built 2026-09-30, needs on-device verification).** `tauri-plugin-herald-native`:
   Android MediaSession / iOS MPRemoteCommandCenter turn earbud play-pause into trigger `toggle`
   (only while Herald is usable on the device; setting "Earbud button talks to Herald"), transient
   audio focus / an iOS duckOthers audio session duck other audio while Herald speaks, RECORD_AUDIO
   and NSMicrophoneUsageDescription for the WebView mic. iOS limit: remote commands only reach the
   Now Playing app, so with the earbud setting on Herald pauses music instead of ducking it.
   Original spec: an earbud / headset media-button tap triggers `brief` (Media Session / native media
   button handling in the Tauri Android and iOS apps).

Dependencies: Phase 1 needs Fleet Phase 1 (Fleet Inbox + capability handshake) or a minimal
equivalent; later phases are independent of Fleet Phases 2-4, though Missions would give the front
layer richer "what is this work for" context.

### Tests Needed (Phase 1)
- Guardrail classifier: tier for each example above; danger from pending-question text alone;
  "yeah" to a prod-deploy question → hard confirm; batch request splits out dangerous items.
- Grounding: status answers only cite fetched session content; unknown → "want me to ask it?".
- Target resolution: ambiguous target with multiple waiting sessions → clarify, never send.
- Speech rewrite: markdown/code/paths/tables stripped or paraphrased in spoken output.

### Open Questions
- **Name / voice identity** (JARVIS vibe; must not collide with "concierge").
- **Host choice:** own GPU box vs Mac mini vs DGX Spark.
- **Local vs hosted STT/TTS** (latency, privacy, quality, cost).
- **Hard-confirm UX on voice-only devices** (earbuds, no screen): confirm phrase design, anti-
  accidental-match, fallback to phone tap.
- **"What you've already heard" persistence** — reuse Fleet `seenUpTo`, or a separate
  heard/acknowledged watermark per device vs per user?
- **Notification interplay with existing escalation** (browser → push): does a spoken announcement
  suppress/delay push, and what happens when no voice endpoint is connected?

---

## Item: Packaging for friends & devs
**Status:** in-progress (Phase 1 built 2026-10-03; Phase 3 secrets + first-run wizard built 2026-10-03; Phase 2 Docker built 2026-10-03; push relay planned)

Goal: a friend or another developer goes from "never heard of it" to "phone shows my Claude
sessions" without typing a token, without a Firebase project, and without the user's personal
cush-tools / Infisical setup. Order: (1) discovery + pairing, (2) Docker compose, (3) push relay,
secrets cleanup, first-run wizard.

### Phase 1: Discovery + pairing (built)

**Daemon identity.** `~/.companion/daemon-id.json` holds a stable random id (16 bytes hex, created
on first start, 0600). Display name = config `name`, else `Companion on <hostname>`.

**mDNS.** `_companion._tcp`, instance name = display name, unchanged `mdns_enabled` switch. TXT:
`id` (daemon id), `name`, `version` (daemon package version), `pairing` (`1`/`0`), `tls` (`1`/`0`),
`port`, `proto=1`, `ip` (up to 3 LAN IPv4s from physical interfaces: hosts with docker / VPN bridges
advertise dozens of addresses, so the app tries the hint first and uses the first address that
answers `pair_hello`). Never a token, code, OTP or path. A unit test asserts the TXT holds no
listener token and only those keys.

**Device registry.** `~/.companion/devices.json` (0600, atomic temp+rename, dir 0700):
`{version:1, devices:[{id, name, platform, createdAt, lastSeenAt, salt, tokenHash, via, capabilities?}]}`.
Token = `cdt1.<deviceId>.<43 chars base64url = 256 random bits>`; stored as
`sha256(salt || secret)` with a 16-byte per-token salt, compared with `timingSafeEqual` (a dummy
compare runs for unknown ids). scrypt buys nothing for 256-bit random secrets and would cost CPU on
every reconnect. `lastSeenAt` writes are coalesced (at most one disk write per minute). Revoke
deletes the entry (the audit log keeps the history). Trigger tokens stay a separate registry
(`herald-trigger-tokens.json`, triggers only); the two share the hashing / constant-time helpers,
not the file, so a trigger credential can never become a full one.

**Pairing protocol.** Unauthenticated sockets may send exactly `pair_hello`, `pair_request`,
`pair_confirm`, `pair_redeem_qr`; everything else still answers "Not authenticated".
- `pair_hello` -> `{daemonId, name, version, pairing, tls}` (no secrets; lets a browser show what it
  is pairing with).
- `pair_request {deviceName, platform, publicNonce}` -> `{pairingId, expiresAt}`. The daemon makes a
  6-digit code (`crypto.randomInt`), 2-minute expiry, bound to the requesting socket (a dropped
  socket cancels the request). The code goes to: the journal (`Pairing: "Chris's iPad" (ios) wants
  to pair - code 123456`), `bin/companion pair`, and a `pair_pending` broadcast to authenticated
  clients (name, platform, code, address, expiry).
- `pair_confirm {pairingId, code}` (same socket) -> `pair_result {status:'approved', token,
  deviceId, daemonId, daemonName, publicNonce}`; the token is sent once and never stored in clear.
- `pair_approve {pairingId}` / `pair_deny {pairingId}` from an authenticated client (or the CLI)
  push the same `pair_result` (approved / denied) to the waiting requester.
- QR: `pair_qr_create` (authenticated, or `bin/companion pair --qr`) -> one-time secret (32 bytes,
  10-minute expiry, single use, at most 5 outstanding) as
  `companion://pair?host=..&port=..&tls=0|1&id=<daemonId>&name=..&otp=..`. `pair_redeem_qr {otp,
  deviceName, platform}` issues a device token without the code step. The web shows the QR as a
  daemon-rendered PNG data URL (no QR library in the web bundle).
- Limits: 5 wrong codes per pairingId then locked; 10 pending globally; 3 pending and 10 requests
  per 10 min per IP; per-IP exponential backoff after wrong codes / bad OTPs (2^n s, cap 5 min,
  forgotten after 15 quiet minutes); 50 wrong codes daemon-wide in 10 min suspends code pairing for
  10 min. Every request / confirm / approve / deny / QR create+redeem / revoke / rename / upgrade is
  audit-logged (never the code, OTP or token).
- Network trust: `pairing: false` disables it. Code pairing (`pair_request`) is accepted only from
  loopback, RFC 1918, link-local, CGNAT/tailnet 100.64/10 and IPv6 ULA/link-local, unless
  `pairing_allow_public: true`. Behind a reverse proxy the X-Forwarded-For client is used (only when
  the peer itself is trusted), so the public HAProxy route counts as public. QR redemption works from
  anywhere: the OTP is a 256-bit secret the user handed over on purpose.

**Auth.** `authenticate` accepts a device token (scope full, `authKind:'device'`) or the listener
token (`authKind:'legacy'`, unchanged, documented as legacy). The response carries `authKind`,
`deviceId`, `daemonId`. Device `capabilities` narrow remote exec/dispatch/write like per-origin
credentials. Revoke closes that device's sockets immediately (`token_invalidated {reason:
'device_revoked'}`, close 4401); the client stops reconnecting.

**Management.** WS (authenticated, full scope): `devices_list` (+ `currentDeviceId`),
`device_revoke`, `device_rename`, `pair_pending_list`, `device_upgrade {deviceName, platform}`
(legacy-token client gets its own device token silently). CLI: `bin/companion pair [--qr]
[--approve ID|--deny ID]` (watches and prompts y/n/skip), `bin/companion devices
list|revoke|rename`; both talk to the running daemon over loopback with the listener token, and fall
back to editing devices.json when the daemon is down.

**Herald.** Not in Phase 1 (the stuck-session work owns the inbox right now). Follow-up: a
`pair_request` inbox item with a tone for the active device only; approval stays on-screen, never
by voice.

**Clients.**
- Discovery via `plugin:herald-native|discover_daemons {timeoutMs}` -> snapshot list `{name, host,
  port, txt}`: Android NsdManager (serialized resolves), iOS NWBrowser + NWConnection to resolve the
  endpoint (`NSLocalNetworkUsageDescription` + `NSBonjourServices=_companion._tcp` via
  `setup-ios.sh`), desktop `mdns-sd` crate. Browser: none.
- Add server: "Nearby" (name, host, version, Paired badge by daemon id), "Scan QR" (web camera +
  jsQR, works in the WebViews; camera permission added) / "Paste a companion:// link", "Pair by
  address" (code flow; prefilled with the page's own host in a browser), "Enter token manually"
  (the old form, Advanced).
- Pairing screen: "Enter the 6-digit code shown on your server, or approve this device from another
  one you're signed in on", waits live for approval, stores the device token on the server entry.
- `companion://` deep links: Android intent filter (setup-android.sh) + plugin `onNewIntent`; iOS /
  macOS `CFBundleURLTypes` + `RunEvent::Opened`. Linux/Windows desktop: paste the link.
- Approval prompt on every signed-in client (name, platform, code, Approve / Deny).
- Settings -> Devices per server: last seen, This device, rename, revoke, "Show pairing QR",
  "Upgrade to a device token" for legacy-token entries.

**Threat model.**
- *LAN attacker spamming pair requests*: per-IP and global caps, prompts are deduped and expire in 2
  minutes; requests never auto-approve; pairing can be turned off; public networks refused by
  default.
- *Code guessing*: 6 digits, 5 tries per request, 3 concurrent per IP, exponential backoff, global
  suspension; the code only appears where the user already is (journal, CLI, signed-in apps), so a
  guesser has ~5e-6 odds per request and gets throttled long before 1e6 tries.
- *Replayed QR*: single-use, 10-minute expiry, stored hashed; a leaked old QR is dead. A QR that
  leaks while fresh pairs one device the user can see in Devices and revoke.
- *Revocation*: deletes the hash, closes live sockets at once, refused on reconnect.
- *Token storage on device*: the existing localStorage + tauri-plugin-store (app-private storage on
  Android/iOS). Keystore/Keychain wrapping is a follow-up (needs a native secure-store command);
  device tokens are per-device and revocable, which bounds the damage.
- *TXT leakage*: TXT holds id, name, version, pairing/tls flags and port only (test-enforced); the
  daemon id is not a credential.
- *Legacy token*: unchanged and still all-powerful; the app offers the one-tap upgrade, and once all
  devices are paired the user can rotate it.

### Phase 2: Docker compose (built 2026-10-03)
As built (differs from the sketch below where noted): named volumes `claude` / `companion` / `local`
(Claude Code via Anthropic's native installer into `~/.local`, `CLAUDE_CONFIG_DIR=~/.claude`), projects
bind mount at `~/projects`, runtime `PUID`/`PGID` remap (root entrypoint + setpriv, tini PID 1), root-exec
wrappers for `claude`/`tmux`/`companion`, `/health` = `{ok, version, setupComplete}`, profiles `voice`
and `tailscale` (sidecar in userspace mode on the compose network, `tailscale serve` -> `companion:9877`;
the daemon reads its state over the shared LocalAPI socket), `docker-compose.host.yml` for mDNS,
`COMPANION_MDNS` now overrides the config on every start, `COMPANION_APP_FEED_URL` fallback for
"Get the apps". Ops: `bin/docker`, `bin/e2e-docker`; CI `.github/workflows/docker.yml`. Guide:
docs/docker.md.

Original sketch:
- Image `ghcr.io/hexidecibel/companion` (multi-arch amd64 + arm64 via buildx in release.yml),
  `node:20-bookworm-slim` + tmux, git, ripgrep, curl, tini; non-root user `companion` (uid 1000,
  overridable with build args to match the host). Daemon + web dist baked in; no Claude Code.
- `docker-compose.yml`:
  - `companion`: ports `9877:9877`; volumes `./data/claude:/home/companion/.claude` (Claude Code
    auth + transcripts), `${PROJECTS_DIR:-./projects}:/home/companion/projects`,
    `./data/companion:/home/companion/.companion` (config, devices.json, audit, state),
    `./data/npm-global:/home/companion/.npm-global` (Claude Code install survives image upgrades);
    healthcheck `curl -fs http://localhost:9877/health` (new unauthenticated endpoint: `{ok,
    version}`); `restart: unless-stopped`; `init: true`. tmux runs inside the container (the daemon
    starts the server on demand); `network_mode: host` documented as optional for mDNS (bridge
    networks do not carry multicast).
  - `herald-voice` (profile `voice`): the `voice/` service image, model cache volume, GPU block
    commented; daemon gets `herald.voice_url=http://herald-voice:8790` through env.
  - `tailscale` (profile `tailnet`): `tailscale/tailscale` with `TS_AUTHKEY`, `TS_SERVE_CONFIG`
    serving `https://companion.<tailnet>.ts.net` -> `companion:9877`; companion uses
    `network_mode: service:tailscale` in that profile so it is reachable on the tailnet only.
- Setup step: `docker compose run --rm companion setup-claude` installs Claude Code
  (`npm i -g @anthropic-ai/claude-code` into the npm-global volume) and runs `claude /login`
  interactively; the daemon prints "Claude Code not installed / not logged in" on /health and in the
  app until done.
- Config from env (`COMPANION_PORT`, `COMPANION_NAME`, `COMPANION_PAIRING_ALLOW_PUBLIC`, ...) layered
  over the config file; first start generates the legacy token and prints the pairing QR.

### Phase 3: Push relay, secrets, wizard
**Push relay** (`relay/`, small Node service on hexinas behind HAProxy, `push.cush.rocks`):
- Holds the one Firebase service account. Daemons never get FCM credentials.
- Registration: daemon generates an Ed25519 key pair on first use, `POST /v1/daemons` with its
  public key -> relay id. Devices register their FCM/APNs token with their daemon (as today); the
  daemon sends `POST /v1/push {deviceToken, title, body, data}` signed with its key (timestamp +
  nonce, 60 s skew).
- Abuse limits: per daemon 60 pushes/hour, 500/day; per device token 30/hour; at most 20 device
  tokens per daemon; registration rate-limited per IP (5/day); unknown or revoked keys refused; an
  admin can ban a daemon id.
- Privacy: payload carries the session name and at most a 100-character preview; daemon setting
  `push_preview: false` sends only "Session needs input"; the relay logs counts, not bodies, and
  keeps no payloads. PRIVACY.md updated.
- Self-hosters keep `fcm_credentials_path` (direct FCM wins over the relay).

**Secrets.** Daemon reads secrets from env first (`ANTHROPIC_API_KEY`, `COMPANION_HERALD_*`), then
`~/.companion/secrets.env` (0600, `KEY=value`), then config. `install-secrets` keeps cush-tools as an
optional backend only when `.cush-secrets` and the inject tool exist; otherwise it prompts and writes
secrets.env. Nothing in the repo assumes cush-tools or Infisical.

**First-run wizard (built 2026-10-03).** Setup mode = config `setup_complete: false` (written only
when the daemon generates a fresh config; an absent key is an existing install, never setup mode).
The wizard lives in the normal web app (`/web/`): it opens on a device with no saved servers and from
Settings > Setup.
- Bootstrap: `setup_pair_local` (unauthenticated) pairs a loopback browser with no code, only in setup
  mode with zero devices, loopback TCP peer, no X-Forwarded-For / Forwarded / X-Real-IP /
  X-Forwarded-Host, loopback Host header, and an Origin (when present) equal to that Host. Everything
  else uses code pairing / QR. `pair_hello` adds `setupMode` / `localAutoPair` only in setup mode and
  only to trusted networks.
- Setup API (`setup_status`, `_checks`, `_update`, `_list_dirs`, `_set_secret`, `_mark_step`,
  `_complete`, `_start_session`, `_session_progress`, `_session_hello`, `_services`,
  `_install_service`, `_remote`, `_downloads`): authKind device or legacy, full scope, network
  local / lan / tailnet (setup/gate.ts). Contract: daemon/src/setup/protocol.ts mirrored to
  web/src/types/setup.ts.
- Checks run through execFile (no shell) with timeouts, SIGKILL and in-flight dedup; Claude login =
  existence of `~/.claude/.credentials.json` (macOS: Keychain item presence, never `-w`).
- Wizard step marks live in `~/.companion/setup-state.json`; settings go to the config through
  `updateConfigFile` (other keys preserved); secrets to `secrets.env`.
- E2E: `bin/e2e-setup-wizard` (fresh sandbox, private tmux, stub claude, headless Chrome).

**Docker phase leftovers for the wizard.** Prereq checks assume a host install: in the image, the
service step should hide (the container is the service), "Starts on boot" becomes the compose
`restart:` policy, the Claude Code install command becomes `docker compose run --rm companion
setup-claude`, and tmux / node / git are always present. Loopback auto-pair does not work through
Docker's port mapping (the peer is the bridge gateway, not 127.0.0.1): first pairing in a container
uses the code from `docker compose logs` (or `docker compose exec companion companion pair`).
`COMPANION_PORT` / `COMPANION_NAME` / `COMPANION_MDNS` / `COMPANION_WEB_DIR` / `COMPANION_SECRETS_FILE`
already exist for the compose file; `/health` and the bridge-network mDNS note are still to do.

**Distribution.** Android: the existing sideload updater feed (`publish-update --apk`) on
`dev.cush.rocks`; friends install the first APK from a link, updates arrive in-app. Desktop: the
existing signed updater feed (`publish-update --run`). iOS: TestFlight external testers. Phase 3
adds a per-friend-safe public download page listing the current APK / desktop builds.

### Tests Needed (Phase 1)
- Registry persistence, mode 0600, hashing, constant-time verify, rename / revoke.
- Pairing state machine: expiry, lockout, rate limits, approve/deny/confirm races, single-use QR OTP.
- Auth with device token, legacy token, revoked token; revoke closes live sockets.
- mDNS TXT has no secrets.
- Web: discovery list, code entry, approval prompt, Devices settings, deep-link parsing.
