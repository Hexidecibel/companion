# Implementation Plan

## Item 1-4: Previously Completed
**Status:** complete

Settings safe area, permissions bypass toggle, server connection toggle, conversation archive - all done.

---

## Item 5: Expandable Dashboard Tasks
**Status:** in-progress

### Requirements
- Dashboard sessions can expand to show running Claude tasks (TaskCreate/TaskList items)
- Each task shows: subject, status (pending/in_progress/completed), activeForm when running
- Tapping a task opens a new Task Detail screen
- Task Detail screen shows: full description, current output/activity, status

### Files to Modify
- `daemon/src/parser.ts` - Add function to extract tasks from JSONL
- `daemon/src/types.ts` - Add TaskItem type
- `daemon/src/websocket.ts` - Add `get_tasks` endpoint
- `app/src/types/index.ts` - Add TaskItem type
- `app/src/screens/DashboardScreen.tsx` - Add expandable task list under each session
- `app/src/screens/TaskDetailScreen.tsx` - New screen for task details

### Implementation Steps
1. Add TaskItem type: id, subject, description, status, activeForm, owner, blockedBy
2. Add parser function to extract TaskCreate/TaskUpdate tool calls from JSONL
3. Add `get_tasks` WebSocket endpoint that returns tasks for a session
4. Update ServerCard to be expandable with task list
5. Create TaskDetailScreen with task info and live updates
6. Wire up navigation from dashboard to task detail

### Tests Needed
- Tasks parse correctly from JSONL
- Expand/collapse works smoothly
- Task detail screen shows correct info
- Live updates when task status changes

---

## Item 6: Scrolling/Chat Stability
**Status:** planned

### Requirements
- Chat window should be stable when many messages arrive quickly
- No jumping to random positions during streaming
- Maintain scroll position when viewing history
- Auto-scroll only when already at bottom

### Files to Modify
- `app/src/screens/SessionView.tsx` - Improve FlatList configuration
- `app/src/components/ConversationItem.tsx` - Optimize re-renders
- `app/__tests__/scroll-stability.test.tsx` - New test file

### Implementation Steps
1. Audit current FlatList config: maintainVisibleContentPosition, getItemLayout, etc.
2. Add `windowSize` and `maxToRenderPerBatch` tuning
3. Memoize ConversationItem more aggressively with React.memo
4. Add ref tracking for "is at bottom" detection
5. Only auto-scroll if user is already at bottom
6. Write integration tests for scroll behavior

### Tests Needed
- Rapid message arrival doesn't cause jumps
- Scroll position maintained when reading history
- Auto-scroll works when at bottom
- No performance degradation with large message counts

---

## Item 7: Safe Padding on All Screens
**Status:** complete

### Requirements
- All screens should have proper safe area padding
- Bottom content shouldn't spill into gesture area
- Consistent padding across: ServerList, SessionView, Archive, Settings, etc.

### Files to Modify
- `app/src/screens/ServerList.tsx` - Add contentContainerStyle paddingBottom
- `app/src/screens/SessionView.tsx` - Verify padding (may already be handled)
- `app/src/screens/Archive.tsx` - Add contentContainerStyle paddingBottom
- `app/src/screens/NotificationSettings.tsx` - Check and fix if needed
- `app/src/screens/UsageScreen.tsx` - Check and fix if needed
- `app/src/screens/AgentTreeScreen.tsx` - Check and fix if needed

### Implementation Steps
1. Audit all screens for ScrollView/FlatList usage
2. Add `contentContainerStyle={{ paddingBottom: 40 }}` where missing
3. For modal screens, ensure bottom padding accounts for keyboard

### Tests Needed
- Visual check on device with bottom safe area (iPhone X+ style)
- Content is fully visible when scrolled to bottom

---

## Item 8: Text Overflowing Bubble
**Status:** complete

### Requirements
- Long text without word breaks should wrap or truncate properly
- Message bubbles should contain all text within bounds
- Handles: long URLs, code strings, paths without spaces

### Files to Modify
- `app/src/components/ConversationItem.tsx` - Fix text container styling
- `app/src/components/MarkdownRenderer.tsx` - May need overflow handling

### Implementation Steps
1. Add `flexShrink: 1` to text containers
2. Ensure parent has `flex: 1` with bounded width
3. Add `overflow: 'hidden'` to bubble container as safety
4. For code blocks: add horizontal scroll or word-wrap
5. Test with various long strings (URLs, file paths, code)

### Tests Needed
- Long URL doesn't overflow
- Long file path wraps correctly
- Code blocks handle long lines
- Normal text still renders correctly

---

## Item 9: iOS Build
**Status:** deferred (no Apple Developer account yet)

### Requirements
- Create iOS build via EAS
- Configure for TestFlight distribution
- Handle iOS-specific permissions (push notifications)

### Prerequisites
- Apple Developer account ($99/year)
- Link account to EAS via `eas credentials`

### Files to Modify (when ready)
- `app/eas.json` - Add/verify iOS build profile
- `app/app.json` or `app.config.js` - iOS bundle identifier, permissions
- May need `ios/` folder generation via `expo prebuild`

### Implementation Steps (when ready)
1. Sign up for Apple Developer Program
2. Run `eas credentials` to link account
3. Verify eas.json has iOS profile configured
4. Run `eas build --platform ios --profile preview`
5. Submit to TestFlight once build succeeds

---
