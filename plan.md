# Implementation Plan

Detailed plans for upcoming work items. Completed items are moved to FEATURES.md.

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
