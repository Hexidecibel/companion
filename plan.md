# Implementation Plan

## 1. Fix Session Switching Regression
**Status:** in-progress

### Problem
Session switching from dashboard is slow/hangs/fails. The WebSocket connect guard added in `5ea018a` only checks `connectionState.status` but not `ws.readyState`. When WiFi drops cause the WebSocket to silently die, the status stays 'connected' but the socket is closed. The guard prevents reconnection, and all sends through the dead socket timeout.

Also, after reconnection, `lastSwitchedSessionId` ref isn't reset, so the init effect doesn't re-send `switch_session` to the daemon. And `reconnect()` has a bug where `this.server` is nulled by `disconnect()` before being passed to `connect()`.

### Files Modified
- `app/src/services/websocket.ts` - Fix connect guard to verify `ws.readyState`, fix reconnect() server ref
- `app/src/screens/SessionView.tsx` - Reset lastSwitchedSessionId when connection drops

### Implementation Steps
1. In `wsService.connect()`: for 'connected' status, also check `this.ws?.readyState === WebSocket.OPEN`
2. In `wsService.reconnect()`: save server ref before calling disconnect
3. In SessionView: add effect to reset `lastSwitchedSessionId.current = null` when `isConnected` goes false

---

## 2. Fix New Session Creation/Attaching Bugs
**Status:** planned

### Problem
When creating new sessions from dashboard, various bugs occur:
- Chat shows wrong conversation
- Can't send messages to the new session
- Stale data from previous session displays

### Root Cause Analysis
- Dashboard creates tmux session via `create_tmux_session` endpoint
- Daemon clears active session after creation
- SessionView may still have stale sessionGuard state from previous session
- New conversation JSONL doesn't exist yet, watcher has no entry for new session
- Session ID mismatch between tmux session and conversation session

### Files to Modify
- `app/App.tsx` - Clear pendingSessionId when creating new sessions
- `app/src/screens/SessionView.tsx` - Handle case where conversation doesn't exist yet
- `daemon/src/websocket.ts` - Return new session ID from create_tmux_session

### Implementation Steps
1. When `create_tmux_session` succeeds, have daemon return the expected conversation session ID
2. App.tsx: set `pendingSessionId` to the new session ID so SessionView switches to it
3. SessionView: handle "no conversation yet" state gracefully with a waiting indicator
4. Clear sessionGuard when navigating to a brand new session

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
