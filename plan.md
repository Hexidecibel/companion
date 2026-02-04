# Implementation Plan

Completed items have been moved to FEATURES.md.

---

## 13. Web/Mobile Parity
**Status:** done

Two remaining gaps between web and mobile clients: conversation search and plan viewer.

### 13a. Mobile Search
**Status:** done

Port the web client's SearchBar and match highlighting to React Native.

#### Requirements
- Search icon button in session header toggles a search bar below the header
- Text input with 150ms debounce, case-insensitive substring matching on highlight content
- Match count display: "3/12"
- Prev/next navigation (▲/▼ buttons), Enter = next, wrap-around at ends
- Yellow background highlighting on matching text within messages
- Current match gets distinct styling (outline or brighter highlight)
- Auto-scroll to current match
- Escape or X button closes search bar and clears highlights

#### Implementation Steps
1. Create `app/src/components/SearchBar.tsx` — TextInput with match count, prev/next buttons, close button
2. Add search state to `SessionView.tsx` — `showSearch`, `searchTerm`, `currentMatchIndex`, `searchMatches` memo
3. Add search icon button to session header (Ionicons `search-outline`, between refresh and auto-approve)
4. Extend `ConversationItem` props with `searchTerm?: string | null` and `isCurrentMatch?: boolean`
5. Add `HighlightedText` helper inside `ConversationItem` — splits text by search term, wraps matches in yellow `<Text>`
6. When `searchTerm` is set, render content as plain highlighted text instead of markdown (matching web behavior)
7. Add `isCurrentMatch` outline style to the message container
8. Auto-scroll to current match via `scrollToIndex` or `scrollTo` with item measurement in SessionView's FlatList/ScrollView

#### Files to Modify

| File | Change |
|------|--------|
| `app/src/components/SearchBar.tsx` (new) | Search input bar with nav controls |
| `app/src/screens/SessionView.tsx` | Search state, header button, SearchBar rendering, scroll-to-match |
| `app/src/components/ConversationItem.tsx` | `searchTerm`/`isCurrentMatch` props, HighlightedText rendering |

---

### 13b. Mobile Plan Viewer
**Status:** done

Detect plan file references in conversation and add a Plan button to the session header.

#### Requirements
- Detect plan file paths from `ExitPlanMode`/`EnterPlanMode` tool calls in highlights
- Show "Plan" icon button in session header when a plan file is detected
- Tapping opens the plan file in the existing FileViewer (already supports markdown rendering)
- Render inline PlanCard for `ExitPlanMode` tool calls showing "Plan Ready" with approval status and "View Plan" button

#### Implementation Steps
1. Add `extractPlanFilePath()` utility — port from web's `MessageBubble.tsx` regex logic, check tool call outputs and message content for `.claude/plans/*.md` or `*plan.md` paths
2. Add `latestPlanFile` memo to `SessionView.tsx` — scan highlights backwards for plan file reference
3. Add plan icon button to session header (Ionicons `document-text-outline`), only visible when `latestPlanFile` is set, opens FileViewer
4. In `ConversationItem.tsx`, detect `ExitPlanMode` tool calls and render a styled PlanCard with "Plan Ready" label, approval status, and "View Plan" button

#### Files to Modify

| File | Change |
|------|--------|
| `app/src/screens/SessionView.tsx` | `latestPlanFile` memo, plan header button |
| `app/src/components/ConversationItem.tsx` | `extractPlanFilePath()`, PlanCard rendering for ExitPlanMode |

---

### File Overlap Analysis

13a and 13b both modify `SessionView.tsx` (header buttons, state) and `ConversationItem.tsx` (rendering). Work sequentially — 13a first (search), then 13b (plan viewer).

---

## Deferred

### 10. OpenAI Codex CLI Parser
**Status:** deferred (roadmap)

Discover Codex conversation files, parse format, translate to internal types. Not prioritized — focusing on Claude Code integration first.

### 18. macOS Desktop — Nice to Have
**Status:** deferred

Global hotkey (Ctrl+Shift+C), deep links (`companion://` URL scheme), CI build pipeline, code signing & notarization, auto-update via `tauri-plugin-updater`. Post-launch polish.
