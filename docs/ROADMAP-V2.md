# Companion v2 Roadmap

## Overview

Four major features to transform Companion from a "session monitor" into an "autonomous assistant manager":

1. **Multi-Server Dashboard** - See all servers at a glance
2. **Approval Queue** - Structured tool approval workflow
3. **Sub-Agent Visibility** - Track spawned agents in a tree view
4. **Scheduled Agents** - Define agents that run on triggers

---

## 1. Multi-Server Dashboard

### Goal
See all connected servers and their sessions at a glance. Know which ones need attention without opening each one.

### Current State
- App stores multiple server configs
- User must tap into each server to see status
- Only one WebSocket connection at a time

### Proposed UX
```
┌─────────────────────────────────────┐
│  Companion                 [+ Add]  │
├─────────────────────────────────────┤
│                                     │
│  ┌─────────────────────────────┐    │
│  │ 🟢 Home Server              │    │
│  │    2 sessions               │    │
│  │    ⏳ sitehound - waiting   │    │
│  │    🔄 companion - working   │    │
│  └─────────────────────────────┘    │
│                                     │
│  ┌─────────────────────────────┐    │
│  │ 🟢 Work Server              │    │
│  │    1 session                │    │
│  │    ✅ api-service - idle    │    │
│  └─────────────────────────────┘    │
│                                     │
│  ┌─────────────────────────────┐    │
│  │ 🔴 Raspberry Pi             │    │
│  │    Disconnected             │    │
│  └─────────────────────────────┘    │
│                                     │
└─────────────────────────────────────┘
```

### Technical Approach

**App Changes:**
- New `DashboardScreen` as the home screen
- `useMultiServerStatus` hook that maintains connections to all servers
- Lightweight "status-only" connection mode (subscribe to status updates only)
- Connection pooling with automatic reconnect
- Badge indicators for sessions needing attention

**New Types:**
```typescript
interface ServerStatus {
  serverId: string;
  connected: boolean;
  sessions: SessionSummary[];
  lastUpdated: number;
}

interface SessionSummary {
  id: string;
  name: string;
  projectPath: string;
  status: 'idle' | 'working' | 'waiting' | 'error';
  lastActivity: number;
  pendingApprovals?: number;  // For feature #2
  subAgentCount?: number;     // For feature #3
}
```

**Daemon Changes:**
- Add `get_server_summary` endpoint (lightweight, returns all sessions with status)
- Optimize for polling (cache parsed data, don't re-parse on every request)

### Implementation Steps
1. Create `DashboardScreen` component with server cards
2. Create `useMultiServerStatus` hook
3. Add `get_server_summary` daemon endpoint
4. Implement connection pooling (max 5 concurrent connections)
5. Add pull-to-refresh and background refresh
6. Add notification badges for waiting sessions

### Estimate: 1-2 days

---

## 2. Approval Queue

### Goal
Show pending tool calls that need approval. Enable batch approve/reject. Set auto-approve rules.

### Current State
- The CLI shows tool calls in conversation
- User must read conversation to find pending approvals
- No structured way to approve/reject from app

### How CLI Approvals Work
When the CLI wants to use a tool that requires approval:
1. Tool call appears in conversation with `tool_use` block
2. The CLI waits for user input (y/n/yes/no or custom response)
3. After approval, `tool_result` block appears

We can detect pending approvals by finding `tool_use` blocks without corresponding `tool_result`.

### Proposed UX
```
┌─────────────────────────────────────┐
│  ← Approvals (3)           [Rules]  │
├─────────────────────────────────────┤
│                                     │
│  ┌─────────────────────────────┐    │
│  │ 📝 Edit                     │    │
│  │ src/components/Button.tsx   │    │
│  │ Lines 45-52                 │    │
│  │                             │    │
│  │ [View Diff]                 │    │
│  │                             │    │
│  │ [Reject]  [Approve]         │    │
│  └─────────────────────────────┘    │
│                                     │
│  ┌─────────────────────────────┐    │
│  │ 🖥️ Bash                     │    │
│  │ npm install lodash          │    │
│  │                             │    │
│  │ [Reject]  [Approve]         │    │
│  └─────────────────────────────┘    │
│                                     │
│  ┌─────────────────────────────┐    │
│  │ 📖 Read                     │    │
│  │ /etc/passwd                 │    │
│  │                             │    │
│  │ [Reject]  [Approve]         │    │
│  └─────────────────────────────┘    │
│                                     │
│  ─────────────────────────────────  │
│  [Reject All]      [Approve All]    │
│                                     │
└─────────────────────────────────────┘
```

### Auto-Approve Rules Screen
```
┌─────────────────────────────────────┐
│  ← Auto-Approve Rules      [+ Add]  │
├─────────────────────────────────────┤
│                                     │
│  ✅ Read - any file                 │
│  ✅ Glob - any pattern              │
│  ✅ Grep - any pattern              │
│  ✅ Bash - git status, git diff     │
│  ✅ Edit - src/** only              │
│  ❌ Bash - rm, sudo, chmod          │
│                                     │
└─────────────────────────────────────┘
```

### Technical Approach

**Daemon Changes:**

```typescript
interface PendingApproval {
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  timestamp: number;
  context?: string;  // Surrounding conversation context
}

// New endpoints
'get_pending_approvals' -> PendingApproval[]
'approve_tool' -> { approvalId: string, response?: string }
'reject_tool' -> { approvalId: string, reason?: string }
'get_auto_rules' -> AutoApproveRule[]
'set_auto_rules' -> { rules: AutoApproveRule[] }
```

**Parser Changes:**
- Add `extractPendingApprovals(messages)` function
- Track tool_use blocks and match with tool_result
- Handle edge cases (multiple pending, cancelled tools)

**App Changes:**
- New `ApprovalsScreen` with list of pending approvals
- `ApprovalCard` component with tool-specific rendering
- Diff viewer for Edit tool
- Command preview for Bash tool
- Auto-rules management screen
- Push notification for new pending approvals

### Implementation Steps
1. Add `extractPendingApprovals` to parser.ts
2. Add daemon endpoints for approvals
3. Create `ApprovalsScreen` and `ApprovalCard` components
4. Add diff viewer for Edit approvals (use react-native-diff-view or similar)
5. Implement auto-approve rules storage and matching
6. Add approval count badge to dashboard
7. Push notification for pending approvals

### Open Questions
- How to handle approvals that timeout or are handled elsewhere?
- Should auto-approve happen in daemon or require app to be connected?
- How to show approval context (what was the CLI trying to do?)

### Estimate: 2-3 days

---

## 3. Sub-Agent Visibility

### Goal
When the CLI spawns Task agents, show them in a tree view. See what each is doing, cancel specific ones.

### How CLI Sub-Agents Work
1. The CLI calls the `Task` tool with a prompt
2. The CLI spawns a sub-process
3. Sub-agent output is written to `~/.claude/projects/<project>/subagents/agent-<id>.jsonl`
4. Parent conversation shows Task tool_use and eventually tool_result

### Proposed UX
```
┌─────────────────────────────────────┐
│  ← Agent Tree              [Cancel] │
├─────────────────────────────────────┤
│                                     │
│  📋 Main Agent                      │
│  │  "Refactor authentication"       │
│  │  🔄 Working...                   │
│  │                                  │
│  ├─ 🔍 Explorer Agent               │
│  │     "Find auth-related files"    │
│  │     ✅ Completed (2m ago)        │
│  │                                  │
│  ├─ 📝 Editor Agent                 │
│  │     "Update auth middleware"     │
│  │     🔄 Working...                │
│  │     └─ 🔍 Sub-Explorer           │
│  │           "Check test files"     │
│  │           ⏳ Waiting for input   │
│  │                                  │
│  └─ 🧪 Test Agent                   │
│        "Run auth tests"             │
│        ⏸️ Queued                     │
│                                     │
│  ─────────────────────────────────  │
│  Tap agent to view conversation     │
│                                     │
└─────────────────────────────────────┘
```

### Technical Approach

**Daemon Changes:**

```typescript
interface AgentNode {
  id: string;
  parentId: string | null;
  sessionId: string;
  conversationPath: string;
  description: string;
  status: 'queued' | 'working' | 'waiting' | 'completed' | 'error';
  startTime: number;
  endTime?: number;
  childAgents: AgentNode[];
}

// Endpoints
'get_agent_tree' -> { sessionId: string } -> AgentNode
'get_agent_conversation' -> { agentId: string } -> ConversationMessage[]
'cancel_agent' -> { agentId: string } -> { success: boolean }
```

**Watcher Changes:**
- Watch `subagents/` directory for new agent files
- Parse Task tool calls to correlate parent-child relationships
- Track agent status based on conversation state
- Emit `agent_spawned`, `agent_completed`, `agent_status_change` events

**App Changes:**
- `AgentTreeScreen` with expandable tree view
- `AgentNode` component with status indicator
- Tap to view agent's conversation
- Cancel button (sends interrupt to specific agent)
- Notification when sub-agent needs input

### Implementation Steps
1. Update watcher to monitor `subagents/` directory
2. Parse Task tool calls to build parent-child relationships
3. Create `AgentNode` type and tree-building logic
4. Add daemon endpoints for agent tree
5. Create `AgentTreeScreen` with react-native tree view
6. Add agent status to session summary
7. Implement cancel functionality (tricky - may need to track PIDs)

### Open Questions
- How to reliably cancel a specific sub-agent? May need to track process IDs
- How deep can agent trees go? Need to handle arbitrary depth
- Should completed agents be pruned after some time?

### Estimate: 3-4 days

---

## 4. Scheduled Agents

### Goal
Define agents that run on schedules or triggers. "Every morning, check PRs." "When CI fails, investigate."

### Proposed UX

**Agent List:**
```
┌─────────────────────────────────────┐
│  ← Scheduled Agents        [+ New]  │
├─────────────────────────────────────┤
│                                     │
│  ┌─────────────────────────────┐    │
│  │ 🔄 PR Reviewer              │    │
│  │    Every 2 hours            │    │
│  │    Last run: 45m ago ✅     │    │
│  │    Next run: 1h 15m         │    │
│  │                    [Run Now]│    │
│  └─────────────────────────────┘    │
│                                     │
│  ┌─────────────────────────────┐    │
│  │ 🔀 Auto Merger              │    │
│  │    When PR approved         │    │
│  │    Last run: 2h ago ✅      │    │
│  │    Waiting for trigger...   │    │
│  │                    [Run Now]│    │
│  └─────────────────────────────┘    │
│                                     │
│  ┌─────────────────────────────┐    │
│  │ 🧪 Test Monitor             │    │
│  │    Every hour               │    │
│  │    Last run: 10m ago ❌     │    │
│  │    [View Error]    [Run Now]│    │
│  └─────────────────────────────┘    │
│                                     │
└─────────────────────────────────────┘
```

**Create/Edit Agent:**
```
┌─────────────────────────────────────┐
│  ← New Scheduled Agent     [Save]   │
├─────────────────────────────────────┤
│                                     │
│  Name                               │
│  ┌─────────────────────────────┐    │
│  │ PR Reviewer                 │    │
│  └─────────────────────────────┘    │
│                                     │
│  Working Directory                  │
│  ┌─────────────────────────────┐    │
│  │ /home/user/myrepo      [📁]│    │
│  └─────────────────────────────┘    │
│                                     │
│  Trigger                            │
│  ○ Schedule (cron)                  │
│  ● Interval                         │
│  ○ Webhook                          │
│  ○ File change                      │
│                                     │
│  Every [ 2 ] [ hours ▼]             │
│                                     │
│  Prompt                             │
│  ┌─────────────────────────────┐    │
│  │ Check for open PRs that     │    │
│  │ need review. For each one,  │    │
│  │ provide a summary of the    │    │
│  │ changes and any concerns.   │    │
│  │                             │    │
│  └─────────────────────────────┘    │
│                                     │
│  Auto-Approve Rules                 │
│  ☑ Read, Glob, Grep                 │
│  ☑ Bash: git *                      │
│  ☐ Edit (require approval)          │
│                                     │
│  Notifications                      │
│  ☑ On completion                    │
│  ☑ On error                         │
│  ☑ When needs input                 │
│                                     │
└─────────────────────────────────────┘
```

### Technical Approach

**Daemon Changes:**

```typescript
interface ScheduledAgent {
  id: string;
  name: string;
  workingDir: string;
  prompt: string;
  trigger: AgentTrigger;
  autoApproveRules: string[];
  notifications: {
    onComplete: boolean;
    onError: boolean;
    onWaitingForInput: boolean;
  };
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

type AgentTrigger =
  | { type: 'cron'; expression: string }
  | { type: 'interval'; minutes: number }
  | { type: 'webhook'; path: string }
  | { type: 'fileChange'; patterns: string[] };

interface AgentRun {
  id: string;
  agentId: string;
  status: 'running' | 'completed' | 'error' | 'waiting';
  startTime: number;
  endTime?: number;
  tmuxSession: string;
  conversationPath: string;
  error?: string;
  summary?: string;
}

// Endpoints
'list_scheduled_agents' -> ScheduledAgent[]
'create_scheduled_agent' -> ScheduledAgent
'update_scheduled_agent' -> ScheduledAgent
'delete_scheduled_agent' -> { success: boolean }
'run_agent_now' -> { agentId: string } -> AgentRun
'get_agent_runs' -> { agentId: string, limit?: number } -> AgentRun[]
'get_agent_run' -> { runId: string } -> AgentRun & { conversation: Message[] }
```

**New Daemon Components:**

1. **SchedulerService** - Manages cron jobs, intervals, triggers
2. **AgentRunner** - Spawns tmux sessions, runs the CLI, monitors status
3. **AgentStore** - Persists agent configs and run history

**Agent Execution Flow:**
1. Trigger fires (cron, interval, webhook, file change)
2. SchedulerService calls AgentRunner.spawn(agent)
3. AgentRunner creates tmux session: `tmux new -d -s agent-<id>`
4. AgentRunner runs the CLI: `claude --prompt "<prompt>" --dangerously-skip-permissions` (with auto-approve rules)
5. Watcher picks up the new conversation file
6. AgentRunner monitors for completion/error/waiting
7. On completion, parse final message for summary
8. Send push notification based on agent config
9. Clean up tmux session (or keep for debugging)

**App Changes:**
- `ScheduledAgentsScreen` - List of agents with status
- `AgentEditorScreen` - Create/edit agent config
- `AgentRunsScreen` - History of runs for an agent
- `AgentRunDetailScreen` - View conversation from a specific run
- Push notification handling for agent events

### Config Storage
```json
// ~/.companion/scheduled-agents.json
{
  "agents": [
    {
      "id": "abc123",
      "name": "PR Reviewer",
      "workingDir": "/home/user/myrepo",
      "prompt": "Check for open PRs...",
      "trigger": { "type": "interval", "minutes": 120 },
      "autoApproveRules": ["Read", "Glob", "Grep", "Bash(git *)"],
      "notifications": {
        "onComplete": true,
        "onError": true,
        "onWaitingForInput": true
      },
      "enabled": true
    }
  ],
  "runs": [
    {
      "id": "run-xyz",
      "agentId": "abc123",
      "status": "completed",
      "startTime": 1706000000000,
      "endTime": 1706000300000,
      "tmuxSession": "agent-abc123-1706000000",
      "conversationPath": "~/.claude/projects/-home-user-myrepo/abc.jsonl"
    }
  ]
}
```

### Implementation Steps
1. Create `SchedulerService` with node-cron integration
2. Create `AgentRunner` for spawning and monitoring
3. Create `AgentStore` for persistence
4. Add daemon endpoints for CRUD operations
5. Add webhook endpoint support (optional HTTP server)
6. Create app screens for agent management
7. Implement push notifications for agent events
8. Add file watcher trigger support (using chokidar)
9. Testing and edge case handling

### Open Questions
- How to handle long-running agents? Timeout?
- Should agents be able to spawn other scheduled agents?
- How to handle multiple triggers firing at once?
- How to pass context to webhook-triggered agents?
- Resource limits (max concurrent agents, max run time)?

### Estimate: 3-5 days

---

## Implementation Order

```
Phase 1: Foundation (1-2 days)
└── Multi-Server Dashboard
    - Quick win, foundational for other features
    - Gets users comfortable with new UI paradigm

Phase 2: Approvals (2-3 days)
└── Approval Queue
    - High daily value
    - Builds on existing conversation parsing
    - Needed for scheduled agents' auto-approve

Phase 3: Visibility (3-4 days)
└── Sub-Agent Visibility
    - Builds on approval queue work
    - Parser improvements benefit scheduled agents

Phase 4: Automation (3-5 days)
└── Scheduled Agents
    - Most complex, depends on all previous work
    - Uses approval rules from Phase 2
    - Uses agent tree from Phase 3
```

**Total: ~10-14 days**

---

## Dependencies

```
npm packages needed:

Daemon:
- node-cron (scheduling)
- chokidar (already have, for file triggers)
- express (if adding webhook HTTP endpoint)

App:
- react-native-diff-view (for Edit approvals)
- react-native-tree-view (for agent tree) - or build custom
```

---

## Testing Strategy

1. **Unit tests** for parser functions (extractPendingApprovals, buildAgentTree)
2. **Integration tests** for scheduler service
3. **E2E tests** for critical flows:
   - Create scheduled agent → trigger → view results
   - Approve tool from queue → verify execution
   - View sub-agent tree while agent is running

---

## Future Considerations

- **Team collaboration** - Share scheduled agents, approval workflows
- **Audit log** - Track all approvals and agent runs
- **Cost tracking** - Estimate token usage per agent
- **Templates** - Pre-built agent templates (PR reviewer, test runner, etc.)
- **MCP integration** - Scheduled agents that use MCP servers
