# Implementation Plan

Detailed plans for upcoming work items. Completed items are moved to FEATURES.md.

---

## Item: Add Server Button Styling
**Status:** done
**Complexity:** Low (CSS only)

### Requirements
- Make the "+ Add Server" button in sidebar full width underneath the server/session list
- Currently looks janky on web (narrow, floating)
- Should look consistent between desktop sidebar and mobile views

### Files to Modify
- `web/src/styles/global.css` — Update `.sidebar-add-server-btn` styles
- `web/src/components/SessionSidebar.tsx` — Move button placement if needed (currently at bottom of `.sidebar-sessions`)

### Implementation Steps
1. Move button outside the scrollable session list so it's always visible at the bottom
2. Make it full-width with proper padding/margins matching the sidebar width
3. Ensure it doesn't scroll with the session list (sticky bottom position)
4. Test on both desktop sidebar and mobile views

---

## Item: Open in Editor Improvements
**Status:** done
**Complexity:** Medium

### Requirements
- Only show "Open in Editor" button when viewing from the host machine (not remote browser/mobile)
- Currently hidden on Tauri mobile (`!isTauriMobile()`), but still shows on remote browsers
- The daemon knows it's the host — add a flag to the connection/auth response

### Files to Modify
- `daemon/src/websocket.ts` — Add `isLocalConnection` check to auth response or file view response
- `web/src/components/FileViewerModal.tsx` — Use connection context to conditionally show button
- `web/src/services/ServerConnection.ts` — Store/expose `isLocal` flag from auth response

### Implementation Steps
1. In daemon auth handler, detect if connection is from localhost (127.0.0.1, ::1, or same-host IP)
2. Include `isLocal: boolean` in the auth success response
3. Store `isLocal` on `ServerConnection` instance
4. In `FileViewerModal`, check `isLocal` instead of just `!isTauriMobile()`
5. For Tauri desktop, always treat as local (it's running on the same machine)

### Edge Cases
- User connecting via LAN IP from the same machine — check all local interfaces
- Reverse proxy setups — may need X-Forwarded-For header check
- Keep the `!isTauriMobile()` guard as a secondary check

---

## Item: Auto-Approve Improvements
**Status:** done
**Complexity:** Medium-High

### Requirements
- Review and improve auto-approve effectiveness
- Current approach: sends "yes" string via tmux send-keys when pending approval detected
- Issues: timing-dependent, no verification that approval was accepted, 3s dedup window may miss rapid approvals

### Current Flow (Analysis)
1. Parser detects pending approval tools in JSONL
2. Watcher emits `pending-approval` event
3. Handler in `index.ts` waits 300ms, then sends "yes" via tmux
4. No verification — returns success after spawn regardless of outcome
5. 3-second dedup window prevents re-approval

### Files to Modify
- `daemon/src/index.ts` — Improve auto-approve handler logic
- `daemon/src/input-injector.ts` — Add verification method (check terminal content after send)
- `daemon/src/watcher.ts` — Improve pending-approval detection reliability
- `daemon/src/parser.ts` — Ensure pending tool detection is robust

### Implementation Steps
1. **Verify approval was accepted**: After sending "yes", wait briefly and re-check if the tool is still pending. If still pending, retry once.
2. **Reduce dedup window**: 3 seconds is too long when multiple tools need sequential approval. Reduce to 1 second or use per-tool tracking.
3. **Terminal content check**: Before sending "yes", capture tmux pane content and verify there's actually an approval prompt visible. Prevents sending "yes" to the wrong prompt.
4. **Better logging**: Log what tool is being approved, whether it succeeded, and any mismatches.
5. **Session-level toggle improvement**: When session toggle is ON, auto-approve ALL tools for that session (currently works but could be more explicit in UI about what's approved).

### Tests Needed
- Verify single tool approval works end-to-end
- Verify rapid sequential approvals (2+ tools in quick succession)
- Verify dedup doesn't skip legitimate re-approvals
- Verify "yes" doesn't get sent to wrong prompt

---

## Item: Multi-Choice Prompt UX
**Status:** done
**Complexity:** Medium

### Requirements
- Show prompts one at a time (not all at once) — already partially implemented!
- Prevent out-of-order answers
- Add review/submit button like Claude CLI does
- Current multi-question step-through exists in MessageBubble.tsx but needs polish

### Current State
- Multi-question flow exists (lines 120-219 of MessageBubble.tsx): steps through questions sequentially with Back/Next/Review
- Single question renders option buttons immediately
- "Other..." input for custom responses exists
- Multi-select with "Submit (n)" button exists

### Files to Modify
- `web/src/components/MessageBubble.tsx` — Polish multi-question flow, improve single-question UX
- `web/src/styles/global.css` — Style improvements for prompt cards

### Implementation Steps
1. **Review screen improvements**: Show all selected answers in a summary card before final submit
2. **Visual polish**: Add progress indicator (dots or bar), animate transitions between questions
3. **Prevent interaction with previous prompts**: Once a prompt is answered and a new one appears, grey out/disable the old one
4. **Single-question enhancement**: For single questions with 3+ options, show them in a card layout with descriptions visible (not just button labels)
5. **Keyboard support**: Number keys (1-4) to select options, Enter to confirm, Escape to go back

### Tests Needed
- Single question with 2 options
- Single question with 4+ options
- Multi-question flow with back/next
- Multi-select question
- Custom "Other" input
- Keyboard navigation

---

## Item: Edit/Cancel Sent Message
**Status:** done
**Complexity:** Medium

### Requirements
- Allow canceling a pending message before the CLI processes it
- Allow re-sending corrected text after cancel
- Only works while message is still in `pendingSentMessages` (before JSONL confirmation)
- Once CLI has processed it, editing is not possible

### Architecture
- Client tracks optimistic messages with `clientMessageId`
- Daemon tracks them in `pendingSentMessages` map with TTL
- Cancel = remove from pending + send Ctrl+C to tmux to abort the input
- Re-send = user types corrected message normally after cancel

### Files to Modify
- `daemon/src/websocket.ts` — Add `cancel_input` message handler, remove from pendingSentMessages
- `daemon/src/input-injector.ts` — Add `cancelInput()` method that sends Ctrl+C to tmux
- `web/src/hooks/useConversation.ts` — Add `cancelMessage(clientMessageId)` method
- `web/src/components/MessageBubble.tsx` — Add cancel/edit button on pending user messages
- `web/src/types/index.ts` — Add `isPending` flag to ConversationHighlight

### Implementation Steps
1. **Identify pending messages in UI**: Messages with `clientMessageId` starting with "sent-" that haven't been confirmed by JSONL are pending. Add visual indicator (e.g., clock icon, "Sending..." label).
2. **Add cancel button**: Show small "x" button on pending messages. Clicking sends `cancel_input` to daemon.
3. **Daemon cancel handler**: Remove message from `pendingSentMessages`. Send Ctrl+C to tmux session to abort the pending input (in case it's still being typed/processed).
4. **Client cancel handler**: Remove optimistic message from highlights. Focus input bar with the original text pre-filled for editing.
5. **Race condition handling**: If cancel arrives after JSONL confirmation, it's a no-op (message already processed).

### Edge Cases
- Message sends instantly and is already in tmux before cancel arrives — Ctrl+C may interrupt the CLI
- Multiple rapid cancels — debounce
- Network latency — message may be processed before cancel reaches daemon

### Tests Needed
- Cancel message before it appears in JSONL
- Cancel message that's already confirmed (no-op)
- Cancel and re-send corrected text
- Visual indicator for pending state

---
