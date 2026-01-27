# Claude Companion - Task List

## Completed

### Core Features
- [x] Real-time session monitoring via WebSocket
- [x] Mobile input to send text/images to Claude
- [x] Multi-server support with server list management
- [x] Push notifications (FCM) when Claude is waiting for input
- [x] Android 13+ notification permission prompt
- [x] mDNS discovery for local daemons
- [x] Auto-reconnection with exponential backoff
- [x] TLS support for secure connections

### Session Management
- [x] Tmux session filtering - only show conversations from tmux projects
- [x] Multi-session support - switch between sessions on same server
- [x] Session activity alerts for other sessions needing attention

### UI/UX
- [x] Multi-Server Dashboard with connection status, session counts, waiting/working indicators
- [x] Expandable tool cards showing what Claude is doing
- [x] Tool status (pending/completed) display
- [x] File viewer - tap file paths to view content full-screen
- [x] Quick reply chips for yes/no options
- [x] Slash commands (/yes, /no, /cancel, /switch)
- [x] Auto-scroll to bottom on new messages
- [x] New message indicator
- [x] Queued message display with cancel button
- [x] Scroll-to-bottom button positioning
- [x] Auto-approve for safe tools (Read, Glob, Grep, WebFetch, WebSearch)

### Developer Experience
- [x] Sentry error tracking integration
- [x] /sentry skill for error investigation
- [x] /apk skill for local builds
- [x] EAS build configuration (preview profile)
- [x] Firebase setup for push notifications

---

## Pending

### High Priority

#### Usage/Stats Page
- [ ] Show Claude API token usage
- [ ] Display cost breakdown by session/server
- [ ] Historical usage graphs

#### Dashboard Refinement
- [ ] Fix dashboard connection validation (validate before showing connected)
- [ ] Add session sorting (waiting first, then working, then idle)
- [ ] Add last activity timestamp display

### Medium Priority - Approval Queue (ROADMAP Phase 2)
See `docs/ROADMAP-V2.md` Section 2 for full details.

- [ ] Parse pending approvals from conversation (tool_use without tool_result)
- [ ] Add `get_pending_approvals` daemon endpoint
- [ ] Create `ApprovalsScreen` with list of pending approvals
- [ ] `ApprovalCard` component with tool-specific rendering
- [ ] Diff viewer for Edit tool approvals
- [ ] Command preview for Bash tool approvals
- [ ] Batch approve/reject functionality
- [ ] Auto-approve rules management screen
- [ ] Push notification for new pending approvals

### Medium Priority - Sub-Agent Visibility (ROADMAP Phase 3)
See `docs/ROADMAP-V2.md` Section 3 for full details.

- [ ] Watch `subagents/` directory in daemon
- [ ] Parse Task tool calls to build parent-child relationships
- [ ] Create `AgentNode` type and tree-building logic
- [ ] Add `get_agent_tree` daemon endpoint
- [ ] Create `AgentTreeScreen` with expandable tree view
- [ ] Add agent status to session summary
- [ ] Cancel specific sub-agent functionality

### Lower Priority - Scheduled Agents (ROADMAP Phase 4)
See `docs/ROADMAP-V2.md` Section 4 for full details.

- [ ] `SchedulerService` with node-cron integration
- [ ] `AgentRunner` for spawning and monitoring
- [ ] `AgentStore` for persistence
- [ ] CRUD endpoints for scheduled agents
- [ ] Webhook endpoint support
- [ ] App screens for agent management
- [ ] File watcher trigger support
- [ ] Push notifications for agent events

### Nice to Have
- [ ] iOS build and TestFlight distribution
- [ ] Team collaboration - share agents, approval workflows
- [ ] Audit log for approvals and agent runs
- [ ] Cost tracking - estimate token usage per agent
- [ ] Pre-built agent templates (PR reviewer, test runner, etc.)
- [ ] MCP integration for scheduled agents

---

## Work Queue (Async Tasks)

Tasks suitable for longer autonomous work sessions:

### 1. Approval Queue MVP
```
Implement the basic approval queue feature:
1. Add extractPendingApprovals() to daemon/src/parser.ts
2. Add get_pending_approvals endpoint to daemon/src/websocket.ts
3. Create ApprovalsScreen.tsx in app/src/screens/
4. Create ApprovalCard.tsx component
5. Wire up approve/reject actions to send input to tmux
6. Test with actual pending tool approvals
```

### 2. Usage Statistics Page
```
Add a page showing Claude API usage:
1. Research how to get usage data (may need to track locally or fetch from API)
2. Create UsageScreen.tsx
3. Add navigation to usage page from settings or dashboard
4. Display token counts, costs, and usage over time
5. Consider caching/storing historical data
```

### 3. Sub-Agent Tree View
```
Show sub-agents in a tree view:
1. Update watcher.ts to watch subagents/ directory
2. Parse Task tool calls to identify parent-child relationships
3. Create AgentNode interface and tree-building logic
4. Add get_agent_tree endpoint to daemon
5. Create AgentTreeScreen.tsx with collapsible tree
6. Test with actual sub-agent spawning
```

### 4. Enhanced Tool Card Details
```
Improve tool card information display:
1. Add syntax highlighting for code in tool outputs
2. Show file diffs for Edit tools more clearly
3. Add copy-to-clipboard for tool outputs
4. Show elapsed time for completed tools
5. Add expand-all/collapse-all button
```

---

## Build Status

**Latest EAS Build:** 3c6e9529-12df-45e7-88cf-423610f74ab6 (in progress)
- Platform: Android
- Profile: preview
- Includes: Android 13+ notification permission prompt

**Previous Build:** f2ceb2ce-6e72-4b44-ab75-5c9225de85ee (finished)
- Includes: Tool cards, dashboard fixes, connection validation
