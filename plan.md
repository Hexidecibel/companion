# Implementation Plan

## 1. Fix Session Switching Regression
**Status:** done

---

## 2. Fix New Session Creation/Attaching Bugs
**Status:** done

---

## 3. Beef Up New Project Helper
**Status:** planned

### Requirements
- Let Claude help choose language/stack through back-and-forth discussion
- Analyze the project idea and order template options by recommendation
- Option to create a private GitHub repo during project creation
- More interactive wizard experience

### Files to Modify
- `app/src/screens/NewProjectScreen.tsx` - Add interactive discussion flow
- `daemon/src/scaffold/templates.ts` - Add template metadata for recommendations
- `daemon/src/websocket.ts` - Add GitHub repo creation endpoint

### Implementation Steps
1. Add project analysis step before template selection
2. Order templates by relevance to user's description
3. Add GitHub integration (gh CLI) for private repo creation
4. Multi-step wizard with back-and-forth refinement

---

## 4. Session Header Redesign
**Status:** done

### Requirements
- Replace text-character icons with proper SVG icons (`@expo/vector-icons`, bundled with Expo)
- Keep all 4 header buttons: terminal, refresh, auto-approve, settings
- Auto-approve toggle: **header only** - remove from settings modal
- Instant notify: **session settings modal only** - remove from notification settings screen
- Settings modal becomes a single-toggle instant-notify panel (or expand later)

### Current Header Layout
```
‹ Back | ServerName + SessionPicker | >_ | ↻ | AA | ⚙
```
Icons are text chars: `>_` (terminal), `↻` (refresh), `AA` (auto-approve), `⚙` (settings gear emoji)

### New Header Layout
```
‹ Back | ServerName + SessionPicker | [terminal] | [refresh] | [shield] | [gear]
```
All icons from `@expo/vector-icons` (Ionicons or MaterialCommunityIcons):
- Terminal: `Ionicons/terminal-outline`
- Refresh: `Ionicons/refresh`
- Auto-approve: `Ionicons/shield-checkmark` (active) / `Ionicons/shield-outline` (inactive)
- Settings: `Ionicons/settings-outline`

### Files to Modify
- `app/src/screens/SessionView.tsx`
  - Import `Ionicons` from `@expo/vector-icons`
  - Replace text icons with `<Ionicons>` components in header
  - Remove auto-approve row from settings modal
  - Keep instant notify as the sole toggle in settings modal
  - Update auto-approve button styling for icon-based toggle
- `app/src/screens/NotificationSettings.tsx`
  - Remove the "Instant Notify" toggle (now session-only)
- `app/src/services/notificationPrefs.ts`
  - Remove `instantNotify` from notification prefs interface (optional cleanup)

### Implementation Steps
1. Add `@expo/vector-icons` import to SessionView (already available via Expo)
2. Replace header button text with Ionicons:
   - Back: keep `‹ Back` text or use `Ionicons/chevron-back`
   - Terminal: `<Ionicons name="terminal-outline" size={20} color="#9ca3af" />`
   - Refresh: `<Ionicons name="refresh" size={20} color="#9ca3af" />` (with disabled opacity)
   - Auto-approve: `<Ionicons name="shield-checkmark" size={20} />` with active/inactive colors
   - Settings: `<Ionicons name="settings-outline" size={20} color="#9ca3af" />`
3. Remove auto-approve `<Switch>` from the session settings modal
4. Update modal title from "Session Settings" to something appropriate (e.g., "Notifications" or keep "Session Settings")
5. Remove instant notify toggle from NotificationSettings.tsx
6. Type check: `cd app && npx tsc --noEmit`

### Tests Needed
- Header renders all 4 icon buttons
- Auto-approve toggle works from header (on/off visual state)
- Settings modal opens with only instant notify toggle
- NotificationSettings screen no longer shows instant notify
- Icons render correctly on Android

---

## 5. Dashboard Waiting/Idle Distinction
**Status:** done

### Requirements
- Finished sessions currently show "waiting" and rise to top over actually-working ones
- Add "idle" state for sessions that have finished their task
- Gray out idle sessions on dashboard
- Sort order: waiting > working > idle > error

### Files to Modify
- `daemon/src/watcher.ts` or `daemon/src/parser.ts` - Detect idle vs waiting state
- `daemon/src/websocket.ts` - Include idle status in session summary
- `app/src/types/index.ts` - Add 'idle' to SessionSummary status type
- `app/src/screens/DashboardScreen.tsx` - Gray styling for idle sessions, updated sort

### Implementation Steps
1. Define "idle" state: session exists but Claude has finished (no pending input, no active tool calls, last activity > N seconds ago)
2. Update daemon parser to distinguish waiting-for-user-input vs idle-finished
3. Update session summary to report idle status
4. Update app types to include 'idle' in status union
5. Update DashboardScreen sort priority and add gray styling for idle sessions
6. Add idle icon (e.g., checkmark or dash) to SessionStatusIcon

### Tests Needed
- Idle sessions sort below working/waiting sessions
- Idle sessions render with gray styling
- Session transitions correctly between working → idle and idle → waiting

---

## 6. Settings Cog Icon on Dashboard FAB
**Status:** done

### Requirements
- Change the bottom-right FAB on the dashboard from the current circle+border to a proper cog icon

### Files to Modify
- `app/App.tsx` - Replace the `settingsGear` View with an Ionicons cog

### Implementation Steps
1. Import `Ionicons` from `@expo/vector-icons`
2. Replace `<View style={styles.settingsGear} />` with `<Ionicons name="settings-sharp" size={22} color="#9ca3af" />`
3. Remove unused `settingsGear` style

### Tests Needed
- Cog icon renders on dashboard
- Tap opens settings screen

---

## 7. Show Password Toggle on Token Field
**Status:** done

### Requirements
- Server edit screen token field should have a show/hide password toggle

### Files to Modify
- `app/src/screens/EditServerScreen.tsx` - Add secureTextEntry toggle to token input

### Implementation Steps
1. Add `showToken` state (default false)
2. Set `secureTextEntry={!showToken}` on the token TextInput
3. Add eye icon toggle button next to the field: `Ionicons/eye-outline` / `Ionicons/eye-off-outline`

### Tests Needed
- Token field obscured by default
- Tap eye icon reveals token text
- Tap again hides it

---

## 8. Fix AskUserQuestion Multi-Select and Multiple Questions
**Status:** done

### Problem
AskUserQuestion with multiple options doesn't work properly in the app. Two issues:
1. **Multi-select response format**: Selected options are joined as `"opt1, opt2"` and sent as plain text via tmux. Claude Code expects a JSON `answers` object keyed by question index/ID, not comma-separated text.
2. **Only first question rendered**: The parser (`daemon/src/parser.ts:272-273`) only extracts `questions[0]`. When Claude sends multiple questions (up to 4), only the first is shown. The others are silently dropped.

### Requirements
- Support rendering all questions (1-4) from a single AskUserQuestion call
- Support multi-select checkboxes per question
- Support "Other" freetext option per question (Claude Code always adds this)
- Send responses in the JSON format Claude Code expects
- Single-select should still work with immediate tap-to-send

### Response Format Research
Claude Code's AskUserQuestion tool expects the response as user text input. When the user selects options in the terminal UI, Claude Code receives the selected labels as text. For multi-select, the labels are comma-separated. For "Other", the custom text is sent. The key issue is that when multiple questions are asked, each question needs a separate answer - but currently we can only send one text response.

Claude Code processes AskUserQuestion responses sequentially - it sends one AskUserQuestion at a time and waits for a single text response. The `questions` array with 1-4 questions is presented as a single interactive UI in the terminal, and the response is a single user message. Looking at actual Claude Code behavior: when there are multiple questions, each question's answer is on a separate line in the response.

### Files to Modify
- `daemon/src/parser.ts` - Extract ALL questions from `input.questions[]`, not just `[0]`
- `app/src/types/index.ts` - Update `ConversationMessage` to support multiple questions
- `app/src/components/ConversationItem.tsx` - Render all questions with per-question options
- `app/src/screens/SessionView.tsx` - Update option handler for multi-question responses

### Type Changes

```typescript
// types/index.ts - Add Question interface
export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

// Update ConversationMessage
export interface ConversationMessage {
  // ... existing fields ...
  options?: QuestionOption[];           // Keep for backward compat (single question)
  questions?: Question[];               // NEW: full questions array
  isWaitingForChoice?: boolean;
  multiSelect?: boolean;                // Keep for backward compat
}
```

### Implementation Steps

1. **Parser: Extract all questions** (`daemon/src/parser.ts`)
   - Change lines 272-282 to extract the full `questions` array, not just `questions[0]`
   - Still set `content` to the first question's text for the message bubble
   - Pass entire `questions` array through to the message

2. **Types: Add Question interface** (`app/src/types/index.ts`)
   - Add `Question` interface with `question`, `header`, `options[]`, `multiSelect`
   - Add `questions?: Question[]` to `ConversationMessage`

3. **ConversationItem: Multi-question UI** (`app/src/components/ConversationItem.tsx`)
   - When `message.questions` has >1 item, render each question in its own section
   - Each section has: header chip, question text, options list
   - Track selections per question: `Map<number, Set<string>>` instead of single `Set<string>`
   - Add "Other" freetext input per question (TextInput that appears when "Other" tapped)
   - Submit button collects all answers and joins with newline separator

4. **SessionView: Update handler** (`app/src/screens/SessionView.tsx`)
   - `handleSelectOption` already passes string to `handleSendInput` - no change needed
   - The ConversationItem will format the multi-answer string before calling `onSelectOption`

### UI Design

**Single question (current behavior, keep as-is):**
```
┌─────────────────────────────┐
│ Which library should we use?│
│                             │
│ [○ React Query]             │
│ [○ SWR]                     │
│ [○ Apollo]                  │
│                             │
└─────────────────────────────┘
```

**Multiple questions (new):**
```
┌─────────────────────────────┐
│ ┌─ Auth method ───────────┐ │
│ │ Which auth method?      │ │
│ │ ○ JWT                   │ │
│ │ ○ Session               │ │
│ └─────────────────────────┘ │
│                             │
│ ┌─ Database ──────────────┐ │
│ │ Which database?         │ │
│ │ ○ PostgreSQL            │ │
│ │ ○ MongoDB               │ │
│ └─────────────────────────┘ │
│                             │
│ [Submit Answers]            │
└─────────────────────────────┘
```

### Tests Needed
- Single question with single-select still works (tap to send immediately)
- Single question with multi-select shows checkboxes and submit button
- Multiple questions render with section headers
- Per-question selections tracked independently
- Submit collects all answers into formatted response
- "Other" freetext input works per question

---

## 9. Improve Sub-Agents UX
**Status:** done

### Problem
Sub-agents (Task tool) display is not useful in its current form:
- Green bar just shows "N sub-agents running" - not informative enough
- Modal shows cards but no way to see what the agent is actually doing
- No click-to-view detailed status or output
- Completed agents linger with no useful information
- Sub-agents that are always running (like background watchers) clutter the view

### Current Implementation
- `daemon/src/subagent-watcher.ts` watches `~/.claude/projects/**/subagents/*.jsonl`
- Tracks: agentId, slug, description, messageCount, status, currentActivity
- `SessionView.tsx` polls `get_agent_tree` every 5 seconds
- Green bar at top when running agents exist, expandable to modal with agent cards
- Cards show: status dot, slug, duration, message count, description (100 chars), current activity (50 chars)

### Requirements
- Make sub-agents actually useful to view from the phone
- Click an agent card to see its full conversation/output
- Better status indication (what's it working on right now?)
- Clean separation of running vs completed agents
- Option to dismiss/collapse completed agents
- Consider: inline in conversation vs separate view

### Files to Modify
- `daemon/src/subagent-watcher.ts` - Expose more detail (last N messages, full output)
- `daemon/src/websocket.ts` - Add `get_agent_detail` endpoint for full agent conversation
- `app/src/types/index.ts` - Add `SubAgentDetail` type
- `app/src/screens/SessionView.tsx` - Improve agent bar and modal
- `app/src/screens/SubAgentDetailScreen.tsx` (new) - Full agent conversation view

### New Endpoint

```typescript
// daemon/src/websocket.ts
case 'get_agent_detail':
  // Returns parsed conversation for a specific sub-agent
  // Similar to get_highlights but for a sub-agent's .jsonl file
  {
    agentId: string;
    slug: string;
    description: string;
    status: 'running' | 'completed';
    messages: ConversationHighlight[];  // Full conversation
    startedAt: number;
    completedAt?: number;
  }
```

### Implementation Steps

1. **Daemon: Add agent detail endpoint** (`daemon/src/websocket.ts` + `daemon/src/subagent-watcher.ts`)
   - Add `get_agent_detail` message handler
   - Parse the sub-agent's `.jsonl` file using existing parser functions
   - Return full conversation highlights for the agent
   - Cache parsed results (invalidate on file change)

2. **Types: Add SubAgentDetail** (`app/src/types/index.ts`)
   - `SubAgentDetail` with full conversation messages
   - Reuse `ConversationHighlight` for agent messages

3. **Improve agent bar** (`app/src/screens/SessionView.tsx`)
   - Show agent description snippet in the bar (not just count)
   - When only 1 agent running: "⚡ Exploring codebase..." instead of "1 sub-agent running"
   - When multiple: keep count but add latest activity text

4. **Improve agent modal** (`app/src/screens/SessionView.tsx`)
   - Agent cards become tappable
   - Running agents section at top, completed section below (collapsible)
   - Show more of the description (200 chars) and current activity

5. **Add SubAgentDetailScreen** (`app/src/screens/SubAgentDetailScreen.tsx`)
   - Full-screen view of a sub-agent's conversation
   - Header with agent slug, status, duration
   - Scrollable conversation view (reuse ConversationItem components)
   - Auto-refresh while agent is running (poll every 3 seconds)
   - Navigate here by tapping an agent card in the modal

6. **Navigation** (`app/App.tsx` or `app/src/screens/SessionView.tsx`)
   - Sub-agent detail is a modal/screen pushed from the agents modal
   - Back button returns to agents modal

### UI Design

**Improved agent bar (single agent):**
```
⚡ Exploring codebase structure...                    >
```

**Improved agent bar (multiple):**
```
⚡ 3 agents running · Searching for API endpoints... >
```

**Improved agent modal:**
```
┌──────────────────────────────────┐
│ Sub-Agents                    ✕  │
│                                  │
│ ▼ Running (2)                    │
│ ┌──────────────────────────────┐ │
│ │ ● Explore codebase      2m  │ │
│ │   Searching for API          │ │
│ │   endpoints in src/...   >   │ │
│ └──────────────────────────────┘ │
│ ┌──────────────────────────────┐ │
│ │ ● Run tests             45s │ │
│ │   Running jest suite...  >   │ │
│ └──────────────────────────────┘ │
│                                  │
│ ▸ Completed (1)                  │
└──────────────────────────────────┘
```

**Sub-agent detail screen:**
```
┌──────────────────────────────────┐
│ ‹ Back  Explore codebase    ●   │
│         Running · 2m 15s        │
├──────────────────────────────────┤
│                                  │
│ [Agent conversation messages     │
│  rendered like session view]     │
│                                  │
└──────────────────────────────────┘
```

### Tests Needed
- Agent bar shows description for single agent
- Agent bar shows count + activity for multiple agents
- Agent cards are tappable, navigate to detail screen
- Detail screen shows full agent conversation
- Detail screen auto-refreshes while agent is running
- Completed agents section is collapsible
- Navigation back from detail to modal works
