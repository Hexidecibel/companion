# Implementation Plan - Overnight Session

Items ordered by priority: bug fixes first, then features, then polish.

---

## 1. Server card not clickable when no sessions (Bug Fix)
**Status:** done

### Problem
After killing all sessions, the server card on the dashboard is still tappable and navigates to SessionView showing the last killed conversation.

### Files to Modify
- `app/src/screens/DashboardScreen.tsx` - Disable server card press when no sessions

### Implementation Steps
1. In ServerCard, check if `status.summary?.sessions.length === 0` or no summary
2. When no sessions: disable `onPress` on the outer TouchableOpacity (or make it a no-op)
3. Add visual feedback - muted text like "No active sessions" instead of "Tap to connect"
4. Keep the server header (name, connection dot, enable toggle) always interactive
5. Session rows already only render when sessions exist, so just guard the card-level press

---

## 2. Debug auto-approve hung prompts (Bug Fix)
**Status:** planned

### Problem
Auto-approve gets hung up at prompts when it should be auto-approving.

### Root Cause Analysis (from exploration)
- `daemon/src/index.ts` lines 88-142: Approval logic
- De-duplication window only 3s (`pendingAutoApprovals` Set)
- Session matching uses workingDir which can be fragile
- Falls back to active session if match fails (could send to wrong session)
- Race condition: approval sent before tool UI is fully rendered in terminal

### Files to Modify
- `daemon/src/index.ts` - Fix approval logic, improve session matching
- `daemon/src/watcher.ts` - Improve pending-approval detection timing
- `daemon/src/input-injector.ts` - Add retry logic for approval sends

### Implementation Steps
1. Add logging to trace approval flow: detection → matching → send → result
2. Increase de-duplication window to 5s and use tool+session composite key
3. Improve session matching: try exact path match first, then fall back to active
4. Add small delay (200ms) after detecting pending approval before sending (let terminal settle)
5. Add retry on approval send failure (1 retry after 500ms)
6. Log when approval is skipped due to dedup or no matching session

---

## 3. Kill session from server dashboard
**Status:** done

### Backend
Already exists: `kill_tmux_session` endpoint in `daemon/src/websocket.ts` lines 1082-1127

### Files to Modify
- `app/src/screens/DashboardScreen.tsx` - Add kill button/swipe action per session row
- `app/src/hooks/useMultiServerStatus.ts` - Already has `sendRequest`

### Implementation Steps
1. Add a small "X" or trash icon button on each session row (right side, before the chevron area)
2. On press: show Alert.alert confirmation dialog ("Kill session 'name'?")
3. On confirm: call `sendRequest(serverId, 'kill_tmux_session', { sessionName })`
4. On success: trigger a refresh of the server summary to update the UI
5. Handle errors (show alert with error message)
6. The daemon already handles cleanup (switches active session, broadcasts change)

---

## 4. Create new session from server dashboard
**Status:** done

### Backend
Already exists: `create_tmux_session` endpoint, `list_tmux_sessions` for recent data

### Files to Modify
- `app/src/screens/DashboardScreen.tsx` - Add "+" button per server card
- `app/src/screens/NewSessionSheet.tsx` - New: modal/sheet for session creation
- `app/src/hooks/useMultiServerStatus.ts` - sendRequest already available

### Implementation Steps
1. Add "New Session" button in the server card (below sessions list or in server header)
2. Create `NewSessionSheet` modal component with:
   - Text input for project path (required)
   - Recent projects list (fetched from stored tmux session configs)
   - Toggle: "Start Claude" (default on)
3. Fetch recent projects via `sendRequest(serverId, 'list_tmux_sessions')` - shows saved configs with workingDir
4. Tapping a recent project pre-fills the path
5. On create: call `sendRequest(serverId, 'create_tmux_session', { name, workingDir, startClaude })`
6. On success: refresh server summary, optionally navigate to new session

---

## 5. Graceful fallbacks for unrecognized tools/formats
**Status:** done

### Current State
Parser already falls back to tool name for unknown tools. But app rendering has hardcoded switch statements.

### Files to Modify
- `app/src/components/ConversationItem.tsx` - Add generic fallback rendering
- `daemon/src/parser.ts` - Add fallback for unknown tool input parsing

### Implementation Steps
1. In `getToolSummary()` default case: extract first string-valued field from input as summary
2. In `getToolIcon()` default: already returns gear emoji - good
3. In tool detail rendering (the expanded card): add generic fallback that shows all input fields as key-value pairs when tool name is not recognized
4. In parser `detectCurrentActivityFast()`: unknown tools show as "Using ToolName" (already works)
5. In parser `parseEntry()`: ensure unknown tool inputs are passed through as-is to toolCalls array

---

## 6. Add logging for unknown parser structures
**Status:** done

### Files to Modify
- `daemon/src/parser.ts` - Add structured warnings for unknowns
- `daemon/src/watcher.ts` - Log unexpected JSONL shapes

### Implementation Steps
1. In parser, add `logParserWarning(type, details)` function that logs to console with `[PARSER_WARN]` prefix
2. Log when tool name not in known descriptions map
3. Log when JSONL entry has unexpected `type` field
4. Log when tool_use block has no `name` or `input`
5. In watcher, log when file change produces no parseable entries
6. Rate-limit repeated warnings (max 1 per unknown tool name per minute)

---

## 7. Terminal output viewer
**Status:** planned

### Overview
Way to see raw terminal output from tmux sessions. Useful for debugging when it's unclear if a session is frozen or working.

### Files to Modify
- `daemon/src/websocket.ts` - Add `get_terminal_output` endpoint
- `daemon/src/tmux-manager.ts` - Add capture-pane function
- `app/src/screens/TerminalScreen.tsx` - New screen for terminal output
- `app/src/screens/SessionView.tsx` - Add "Terminal" button to session header
- `app/App.tsx` - Add navigation

### Implementation Steps
1. **Daemon**: Add `capturePane(sessionName)` to tmux-manager using `tmux capture-pane -p -t sessionName -S -100` (last 100 lines)
2. **Daemon**: Add `get_terminal_output` WebSocket endpoint that calls capturePane and returns text
3. **App**: Create TerminalScreen with monospace text display, dark background, auto-refresh (poll every 2s)
4. **App**: Add "Terminal" icon button in SessionView header bar
5. **App**: Wire up navigation in App.tsx
6. Terminal view: horizontal scroll for long lines, pull-to-refresh, auto-scroll to bottom

---

## 8. Move tool definitions to config
**Status:** planned

### Overview
Tool names, descriptions, approval status, and input field mappings should be in a config file.

### Files to Modify
- `daemon/src/tool-config.ts` - New: tool definition config
- `daemon/src/parser.ts` - Read from config instead of hardcoded maps
- `daemon/src/config.ts` - Load tool config from file
- `app/src/components/ConversationItem.tsx` - Fetch tool config from daemon or use bundled defaults

### Implementation Steps
1. Create `daemon/src/tool-config.ts` with `ToolDefinition` type:
   ```
   { name, displayName, icon, description, inputFields: { summary: string, detail: string[] }, requiresApproval }
   ```
2. Define all known tools in a `DEFAULT_TOOL_CONFIG` map
3. Load overrides from `~/.claude-companion/tools.json` if it exists
4. Add `get_tool_config` WebSocket endpoint for app to fetch
5. Update parser to use tool config for descriptions and input field extraction
6. Update app ConversationItem to use fetched config (with bundled defaults as fallback)
7. App caches tool config per server connection

---

## 9. Better write operation viewer
**Status:** planned

### Current State
- Write: shows file path + full content (truncated at 1000 chars)
- Edit: shows file path + DiffView with old/new (truncated at 20 lines each)

### Files to Modify
- `app/src/components/ConversationItem.tsx` - Enhance Write/Edit display
- `app/src/components/DiffView.tsx` - Improve diff rendering (if exists as separate component)

### Implementation Steps
1. **Edit tool**: Add line numbers to diff view, increase visible lines from 20 to 40
2. **Edit tool**: Add syntax highlighting hints (green for additions, red for removals) - already has colors, improve contrast
3. **Write tool**: Add line numbers to content display
4. **Write tool**: Add "Show more" button when truncated (currently hard-cuts at 1000 chars)
5. **Both**: Add file extension-based syntax label (e.g., ".tsx" → "TypeScript React")
6. Increase truncation limits: Write to 2000 chars, Edit to 40 lines

---

## 10. Collapse tool cards improvements
**Status:** planned

### Current State
Already collapses when >= 3 tools. Shows summary bar with counts and last tool.

### Files to Modify
- `app/src/components/ConversationItem.tsx` - Refine collapse UX

### Implementation Steps
1. In collapsed view, show first AND last tool (not just last) for context
2. Add tool name chips in summary bar (e.g., "Bash, Edit, Write" instead of just "3 tools")
3. Group consecutive identical tool types (e.g., "Read x5" instead of listing 5 Read tools)
4. Keep individual expand/collapse per tool when expanded
5. Add smooth animation for expand/collapse transition (LayoutAnimation)

---

## 11. Build info/date in about screen
**Status:** done

### Files to Modify
- `app/app.config.js` - Add build date to extra config
- `app/src/screens/Settings.tsx` - Display dynamic version + build date

### Implementation Steps
1. In `app.config.js`, add `buildDate: new Date().toISOString()` to `extra` config
2. In Settings.tsx, import `Constants` from `expo-constants`
3. Replace hardcoded "v1.0.0" with `Constants.expoConfig?.version`
4. Add build date: `Constants.expoConfig?.extra?.buildDate` formatted as "Jan 29, 2026"
5. Display as: "v1.0.0 - Built Jan 29, 2026"

---

## 12. Move permissions into session settings
**Status:** planned

### Current State
Auto-approve toggle is in a modal in SessionView. User wants it more accessible as part of session settings.

### Files to Modify
- `app/src/screens/SessionView.tsx` - Move auto-approve to a session settings section

### Implementation Steps
1. Add a settings row in the session header area (or a collapsible settings panel)
2. Move auto-approve toggle from modal to inline session setting
3. Keep the toggle behavior the same (saves to AsyncStorage, sends to daemon)
4. Add visual indicator in session header when auto-approve is on (amber dot or icon)

---

## 13. Populate features file
**Status:** planned

### Files to Modify
- `FEATURES.md` - Update with all current features

### Implementation Steps
1. Read current FEATURES.md
2. Add missing features from recent work:
   - Task expansion on dashboard
   - Task detail screen
   - Tool card collapsing
   - New project wizard
   - Session kill/create from dashboard
   - Terminal output viewer
   - Auto-approve debugging improvements
3. Keep format consistent with existing entries

---

## 14. Error boundary with bug reports
**Status:** planned

### Current State
ErrorBoundary already sends errors to daemon via WebSocket. Has copy-to-clipboard and try-again.

### Files to Modify
- `app/src/components/ErrorBoundary.tsx` - Add Sentry user feedback flow

### Implementation Steps
1. Add text input for user description ("What were you doing when this happened?")
2. On submit: send error + user description to Sentry via `Sentry.captureException()` with user feedback context
3. Also keep existing daemon error reporting
4. Add visual feedback: "Bug report sent" confirmation
5. Add "Report Bug" button alongside existing "Copy" and "Try Again"

---

# Execution Order

For overnight autonomous work, execute in this order:

1. **Server card clickability bug** (#1) - Quick fix
2. **Build info in about** (#11) - Quick win
3. **Kill session from dashboard** (#3) - Backend exists
4. **Create new session from dashboard** (#4) - Backend exists
5. **Graceful fallbacks** (#5) - Parser resilience
6. **Parser logging** (#6) - Quick add
7. **Auto-approve debugging** (#2) - Investigation + fix
8. **Terminal output viewer** (#7) - New screen
9. **Better write viewer** (#9) - UI enhancement
10. **Tool collapse improvements** (#10) - UI refinement
11. **Move tool defs to config** (#8) - Infrastructure
12. **Move permissions to session** (#12) - UI move
13. **Error boundary bug reports** (#14) - Enhancement
14. **Populate features file** (#13) - Documentation
