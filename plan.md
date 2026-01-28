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
**Status:** complete

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

## Item 10: Installable Skills System
**Status:** planned

### Vision
Allow users to install pre-built skill templates that auto-configure for their codebase. Take working skills (like /todo, /up, /down, /work) and make them generic shells that users can apply to their environment.

### Skill Template Format
```json
{
  "id": "todo",
  "name": "Quick Todo Capture",
  "description": "Add items to a todo file with /todo <text>",
  "author": "claude-companion",
  "version": "1.0.0",
  "variables": {
    "TODO_FILE": {
      "detect": ["todo.md", "TODO.md", "tasks.md", "TASKS.md"],
      "prompt": "Path to your todo file",
      "default": "todo.md",
      "required": true
    }
  },
  "template": "# Add Todo Item\n\n1. Read {{TODO_FILE}}\n2. Add item as bullet point\n..."
}
```

### Starter Skill Templates
1. **todo** - Quick capture to todo file
   - Variables: TODO_FILE
   - Detects: todo.md, TODO.md, tasks.md

2. **work** - Work on tasks from queue
   - Variables: TASKS_FILE, CLAUDE_MD
   - Detects: TASKS.md, tasks.md + CLAUDE.md

3. **plan** - Process todos into plans
   - Variables: TODO_FILE, PLAN_FILE
   - Detects: todo.md + plan.md

4. **up/down** - Start/stop services
   - Variables: SERVICE_TYPE (docker-compose|systemd|pm2), SERVICE_NAME, CONFIG_FILE
   - Detects: docker-compose.yml, systemd units, ecosystem.config.js

5. **test** - Run project tests
   - Variables: TEST_COMMAND
   - Detects: package.json scripts, pytest.ini, Cargo.toml

6. **build** - Build project
   - Variables: BUILD_COMMAND
   - Detects: package.json, Makefile, build.gradle

### Files to Create/Modify

**Daemon:**
- `daemon/src/skills/types.ts` - SkillTemplate, InstalledSkill types
- `daemon/src/skills/templates/` - JSON template files for each skill
- `daemon/src/skills/detector.ts` - Auto-detect variable values from codebase
- `daemon/src/skills/installer.ts` - Write skills to Claude Code settings
- `daemon/src/websocket.ts` - Add skill endpoints

**App:**
- `app/src/screens/SkillsScreen.tsx` - Browse and manage skills
- `app/src/screens/SkillInstallScreen.tsx` - Install wizard with variable preview
- `app/src/components/SkillCard.tsx` - Skill display component
- `app/src/services/skills.ts` - Skill service for API calls

### API Endpoints
```
GET  /skills/available     - List all skill templates
GET  /skills/installed     - List user's installed skills
POST /skills/detect        - Detect variables for a skill template
POST /skills/install       - Install skill with variable values
POST /skills/uninstall     - Remove installed skill
POST /skills/update        - Update skill variables
```

### Implementation Steps

**Phase 1: Core Infrastructure**
1. Define SkillTemplate and InstalledSkill types
2. Create skill template JSON format
3. Implement variable detection logic
4. Add installer that writes to `.claude/settings.json`

**Phase 2: Daemon Endpoints**
5. Add `skills/available` endpoint
6. Add `skills/detect` endpoint with codebase scanning
7. Add `skills/install` endpoint
8. Add `skills/installed` and `skills/uninstall` endpoints

**Phase 3: App UI**
9. Create SkillsScreen with available/installed tabs
10. Create SkillCard component
11. Create SkillInstallScreen wizard
12. Add navigation from settings/dashboard

**Phase 4: Starter Templates**
13. Convert current /todo skill to template
14. Convert /work and /plan skills
15. Convert /up and /down skills
16. Add /test and /build generic skills

### Variable Detection Examples

**TODO_FILE detection:**
```typescript
async function detectTodoFile(projectPath: string): Promise<string | null> {
  const candidates = ['todo.md', 'TODO.md', 'tasks.md', 'TASKS.md'];
  for (const file of candidates) {
    if (await fileExists(path.join(projectPath, file))) {
      return file;
    }
  }
  return null;
}
```

**SERVICE_TYPE detection:**
```typescript
async function detectServiceType(projectPath: string): Promise<string | null> {
  if (await fileExists(path.join(projectPath, 'docker-compose.yml'))) {
    return 'docker-compose';
  }
  if (await fileExists(path.join(projectPath, 'ecosystem.config.js'))) {
    return 'pm2';
  }
  // Check for systemd in common locations...
  return null;
}
```

### User Flow
1. User opens Skills screen in app
2. Browses available skill templates
3. Taps "Install" on desired skill
4. App calls `/skills/detect` - daemon scans codebase
5. Install wizard shows detected values with edit option
6. User confirms, app calls `/skills/install`
7. Daemon writes to `.claude/settings.json`
8. Skill is now available as `/skill-name` in Claude Code

### Future Enhancements
- Skill sharing/marketplace
- Custom user-created templates
- Skill versioning and updates
- Team/organization skill libraries
- Skill dependencies (one skill requires another)

### Tests Needed
- Variable detection finds correct files
- Install writes valid JSON to settings
- Uninstall cleanly removes skill
- App displays available vs installed correctly
- Install wizard shows detected values
- Edge cases: no detection match, invalid paths

---
