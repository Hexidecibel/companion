# Implementation Plan

## Item 1: Settings page safe area padding
**Status:** complete

### Requirements
- About section at bottom of Settings screen needs padding
- Currently spills into the safe area on devices with bottom notches/gestures

### Files to Modify
- `app/src/screens/Settings.tsx` - Add contentContainerStyle with paddingBottom

### Implementation Steps
1. Add `contentContainerStyle` to ScrollView with `paddingBottom: 40`

### Tests Needed
- Visual check on device with bottom safe area

---

## Item 2: Permissions bypass toggle
**Status:** complete (types and server form updated; parser already handles running tools)

### Requirements
- Per-server setting to indicate if Claude has auto-approve enabled
- When enabled, don't show yes/no prompts (tools run automatically)
- Prevents UI showing stale prompts for already-running tools

### Files to Modify
- `app/src/types/index.ts` - Add `autoApproveEnabled?: boolean` to Server interface
- `app/src/services/storage.ts` - Handle new field
- `app/src/screens/ServerEdit.tsx` or create new - Add toggle in server config
- `app/src/components/ConversationItem.tsx` - Check server setting before showing options

### Implementation Steps
1. Add `autoApproveEnabled` boolean to Server type
2. Add toggle in server edit/add screen
3. Pass server config to ConversationItem
4. Skip rendering options when autoApproveEnabled is true

### Tests Needed
- Toggle persists after app restart
- Options don't show when autoApproveEnabled is true
- Options still show when autoApproveEnabled is false

---

## Item 3: Server connection on/off toggle
**Status:** complete

### Requirements
- Quick toggle to disable a server without deleting it
- Useful for VPN servers that aren't always accessible
- Visual indicator on dashboard showing disabled state

### Files to Modify
- `app/src/types/index.ts` - Add `enabled?: boolean` to Server interface (default true)
- `app/src/services/storage.ts` - Handle new field
- `app/src/screens/Dashboard.tsx` - Add toggle switch to server cards, skip connecting to disabled servers
- `app/src/hooks/useConnection.ts` - Check enabled flag before connecting

### Implementation Steps
1. Add `enabled` boolean to Server type (defaults to true)
2. Add Switch component to each server card on dashboard
3. Skip auto-connect for disabled servers
4. Gray out disabled server cards visually

### Tests Needed
- Toggle persists after app restart
- Disabled servers don't attempt connection
- Visual difference between enabled/disabled

---

## Item 4: Conversation archive & search
**Status:** complete (MVP - save compacted convos, list view, delete)

### Requirements
- Save compacted conversation summaries when Claude compacts
- Store locally on device for offline access
- Basic list view of saved conversations
- Full search can come later

### Files to Modify
- `app/src/services/archive.ts` - New service for storing/retrieving archived convos
- `app/src/types/index.ts` - Add ArchivedConversation type
- `app/src/screens/Archive.tsx` - New screen to list archived convos
- `app/src/screens/Settings.tsx` - Add link to Archive screen
- `daemon/src/parser.ts` - Detect compaction events and emit

### Implementation Steps
1. Create ArchivedConversation type with id, sessionId, summary, timestamp
2. Create archiveService with save/list/delete methods using AsyncStorage
3. Detect compaction in daemon parser (look for summary message pattern)
4. Emit archive event via WebSocket
5. App listens for archive events and saves
6. Create Archive screen with FlatList of saved convos
7. Add Archive link in Settings

### Tests Needed
- Archive saves correctly
- Archive persists after app restart
- Archive list displays properly
- Can delete archived items

---

## Item 5: Daemon CLI
**Status:** skipped

### Reason
Current `/up` and `/down` skills work fine for now. Revisit later.

---
