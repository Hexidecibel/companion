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
