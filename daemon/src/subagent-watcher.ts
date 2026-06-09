import * as fs from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';
import { EventEmitter } from 'events';
import { SubAgent, AgentTree, ConversationHighlight } from './types';
import { parseConversationFile, extractHighlights } from './parser';

// On the initial chokidar scan, skip sub-agent files that haven't been written
// to recently. Without this guard the watcher reads + JSON-parses every historical
// sub-agent file (potentially thousands, hundreds of MB total) on startup and on
// every poll tick, pegging the CPU. Active agents are always tracked because their
// file mtime is fresh; once tracked they keep updating regardless of age.
const SUBAGENT_INITIAL_MAX_AGE_MS = 10 * 60 * 1000; // 10 min

interface SubAgentJsonlEntry {
  agentId?: string;
  slug?: string;
  sessionId?: string;
  type?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
    stop_reason?: string | null;
  };
  timestamp?: string;
}

interface TrackedSubAgent {
  agentId: string;
  slug: string;
  sessionId: string;
  filePath: string;
  startedAt: number;
  completedAt?: number;
  description?: string;
  subagentType?: string;
  messageCount: number;
  lastActivity: number;
  lastContent?: string;
  isComplete: boolean;
}

export class SubAgentWatcher extends EventEmitter {
  private codeHome: string;
  private watcher: chokidar.FSWatcher | null = null;
  private agents: Map<string, TrackedSubAgent> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  // True until the initial chokidar scan has settled. While true we ignore stale
  // historical files so startup doesn't parse the entire sub-agent backlog.
  private initialScanActive = true;

  constructor(codeHome: string) {
    super();
    this.codeHome = codeHome;
  }

  // Remove agents older than 24 hours from memory
  private cleanup(): void {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const [key, agent] of this.agents.entries()) {
      if (agent.lastActivity < oneDayAgo) {
        this.agents.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`SubAgentWatcher: Cleaned up ${removed} old agents`);
    }
  }

  start(): void {
    const projectsDir = path.join(this.codeHome, 'projects');
    const pattern = path.join(projectsDir, '**', 'subagents', '*.jsonl');

    console.log(`SubAgentWatcher: Watching for sub-agents in: ${projectsDir}`);

    this.watcher = chokidar.watch(pattern, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
      depth: 4,
      usePolling: true,
      // Poll less aggressively. With many historical sub-agent files (this can be
      // thousands), a 200ms interval stat-walks the whole tree 5x/sec and pegs the
      // CPU. 1s is responsive enough for the dispatch panel.
      interval: 1000,
      binaryInterval: 1000,
    });

    this.watcher.on('add', (filePath) => this.handleFileChange(filePath));
    this.watcher.on('change', (filePath) => this.handleFileChange(filePath));
    this.watcher.on('error', (error) => {
      console.error('SubAgentWatcher error:', error);
    });
    // Once the initial scan completes, stop ignoring stale files so that an old
    // file which genuinely gets re-touched later is still picked up.
    this.watcher.on('ready', () => {
      this.initialScanActive = false;
    });

    // Run cleanup every hour
    this.cleanupInterval = setInterval(() => this.cleanup(), 60 * 60 * 1000);
    // Also run cleanup on start to clear any stale data
    this.cleanup();
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  private handleFileChange(filePath: string): void {
    try {
      // During the initial scan, skip files that haven't been touched recently.
      // This avoids parsing the entire historical sub-agent backlog (which can be
      // hundreds of MB across thousands of files) on every startup poll tick.
      // Files already tracked, and any file touched after startup, are never skipped.
      if (this.initialScanActive) {
        const key = this.fileKeyIfTracked(filePath);
        if (!key) {
          let ageMs = Infinity;
          try {
            ageMs = Date.now() - fs.statSync(filePath).mtimeMs;
          } catch {
            return;
          }
          if (ageMs > SUBAGENT_INITIAL_MAX_AGE_MS) return;
        }
      }

      const agentData = this.parseSubAgentFile(filePath);
      if (!agentData) return;

      const key = `${agentData.sessionId}:${agentData.agentId}`;
      const existing = this.agents.get(key);
      const isNew = !existing;

      // Latch completion: once an agent has been seen as complete, keep it complete.
      // Sub-agent JSONL can append later lines that make the heuristic flip
      // isComplete back to false, which would otherwise re-emit "completed"
      // repeatedly and thrash listeners.
      if (existing?.isComplete && !agentData.isComplete) {
        agentData.isComplete = true;
        agentData.completedAt = existing.completedAt ?? agentData.completedAt ?? agentData.lastActivity;
      }

      this.agents.set(key, agentData);

      if (isNew) {
        console.log(`SubAgentWatcher: New agent ${agentData.agentId} (${agentData.slug})`);
        this.emit('agent-started', agentData);
      } else if (agentData.isComplete && !existing.isComplete) {
        console.log(`SubAgentWatcher: Agent ${agentData.agentId} completed`);
        this.emit('agent-completed', agentData);
      } else {
        this.emit('agent-update', agentData);
      }
    } catch (err) {
      console.error(`SubAgentWatcher: Error parsing ${filePath}:`, err);
    }
  }

  /** Return the tracking key if a file path is already tracked, else null. */
  private fileKeyIfTracked(filePath: string): string | null {
    for (const [key, agent] of this.agents.entries()) {
      if (agent.filePath === filePath) return key;
    }
    return null;
  }

  private parseSubAgentFile(filePath: string): TrackedSubAgent | null {
    if (!fs.existsSync(filePath)) return null;

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim());

    if (lines.length === 0) return null;

    let agentId = '';
    let slug = '';
    let sessionId = '';
    let startedAt = 0;
    let completedAt: number | undefined;
    let description = '';
    const subagentType = '';
    let messageCount = 0;
    let lastActivity = 0;
    let lastContent = '';
    let isComplete = false;
    let lastEntryIsAssistantText = false;

    for (const line of lines) {
      try {
        const entry: SubAgentJsonlEntry = JSON.parse(line);

        if (!agentId && entry.agentId) agentId = entry.agentId;
        if (!slug && entry.slug) slug = entry.slug;
        if (!sessionId && entry.sessionId) sessionId = entry.sessionId;

        const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();

        if (startedAt === 0) startedAt = timestamp;
        lastActivity = timestamp;
        lastEntryIsAssistantText = false;

        if (entry.type === 'user' && entry.message?.content) {
          messageCount++;
          const content =
            typeof entry.message.content === 'string'
              ? entry.message.content
              : entry.message.content.map((c) => c.text || '').join('');

          if (!description && content) {
            // Use first 100 chars of first user message as description
            description = content.substring(0, 100);
            if (content.length > 100) description += '...';
          }
        }

        if (entry.type === 'assistant' && entry.message) {
          messageCount++;

          // Check for stop_reason to determine if complete
          if (entry.message.stop_reason === 'end_turn') {
            isComplete = true;
            completedAt = timestamp;
          }

          // Track whether last entry is an assistant text response (not tool_use)
          // This is a strong signal the agent is done — Claude Code doesn't set stop_reason in JSONL
          let hasToolUse = false;
          if (entry.message.content) {
            if (typeof entry.message.content === 'string') {
              lastContent = entry.message.content.substring(0, 50);
              lastEntryIsAssistantText = true;
            } else if (Array.isArray(entry.message.content)) {
              for (const block of entry.message.content) {
                if (block.type === 'text' && block.text) {
                  lastContent = block.text.substring(0, 50);
                } else if (block.type === 'tool_use') {
                  lastContent = `Using tool...`;
                  hasToolUse = true;
                }
              }
              lastEntryIsAssistantText = !hasToolUse;
            }
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    // If the last entry is an assistant text response (no tool_use), the agent is done.
    // Claude Code subagent JSONL doesn't reliably set stop_reason, so use this heuristic.
    if (lastEntryIsAssistantText && !isComplete) {
      isComplete = true;
      completedAt = lastActivity;
    }

    if (!agentId || !sessionId) return null;

    return {
      agentId,
      slug,
      sessionId,
      filePath,
      startedAt,
      completedAt,
      description,
      subagentType,
      messageCount,
      lastActivity,
      lastContent,
      isComplete,
    };
  }

  getAgentTree(sessionIds?: string[]): AgentTree {
    const agents: SubAgent[] = [];
    let runningCount = 0;
    let completedCount = 0;

    // Only show running agents + completed agents from last 5 minutes
    const now = Date.now();
    const completedCutoff = now - 5 * 60 * 1000;
    const fiveMinAgo = now - 5 * 60 * 1000;

    const sessionIdSet = sessionIds && sessionIds.length > 0 ? new Set(sessionIds) : null;

    for (const tracked of this.agents.values()) {
      // Filter by session if specified
      if (sessionIdSet && !sessionIdSet.has(tracked.sessionId)) continue;

      // Consider agent completed if explicitly marked OR no activity in 5 minutes
      const isStale = tracked.lastActivity < fiveMinAgo;
      const isActuallyComplete = tracked.isComplete || isStale;
      const status = isActuallyComplete ? 'completed' : 'running';
      const effectiveCompletedAt =
        tracked.completedAt || (isStale ? tracked.lastActivity : undefined);

      // Skip old completed agents
      if (status === 'completed' && effectiveCompletedAt && effectiveCompletedAt < completedCutoff) {
        continue;
      }

      if (status === 'running') runningCount++;
      else completedCount++;

      agents.push({
        agentId: tracked.agentId,
        slug: tracked.slug,
        sessionId: tracked.sessionId,
        status,
        startedAt: tracked.startedAt,
        completedAt: effectiveCompletedAt,
        description: tracked.description,
        subagentType: tracked.subagentType,
        messageCount: tracked.messageCount,
        lastActivity: tracked.lastActivity,
        currentActivity: tracked.lastContent,
      });
    }

    // Sort by last activity (most recent first)
    agents.sort((a, b) => b.lastActivity - a.lastActivity);

    return {
      sessionId: sessionIds?.[0] || 'all',
      agents,
      totalAgents: agents.length,
      runningCount,
      completedCount,
    };
  }

  getAgentsForSession(sessionIds: string[]): SubAgent[] {
    return this.getAgentTree(sessionIds).agents;
  }

  /**
   * Get detailed conversation for a specific sub-agent by parsing its .jsonl file
   */
  getAgentDetail(agentId: string): {
    agent: SubAgent;
    highlights: ConversationHighlight[];
  } | null {
    // Find the tracked agent
    let tracked: TrackedSubAgent | null = null;
    for (const t of this.agents.values()) {
      if (t.agentId === agentId) {
        tracked = t;
        break;
      }
    }

    if (!tracked || !fs.existsSync(tracked.filePath)) {
      return null;
    }

    // Parse the agent's conversation file using the existing parser
    const messages = parseConversationFile(tracked.filePath, 200);
    const highlights = extractHighlights(messages);

    // Build the SubAgent info
    const now = Date.now();
    const fiveMinAgo = now - 5 * 60 * 1000;
    const isStale = tracked.lastActivity < fiveMinAgo;
    const isActuallyComplete = tracked.isComplete || isStale;
    const status = isActuallyComplete ? 'completed' : 'running';

    const agent: SubAgent = {
      agentId: tracked.agentId,
      slug: tracked.slug,
      sessionId: tracked.sessionId,
      status,
      startedAt: tracked.startedAt,
      completedAt: tracked.completedAt || (isStale ? tracked.lastActivity : undefined),
      description: tracked.description,
      subagentType: tracked.subagentType,
      messageCount: tracked.messageCount,
      lastActivity: tracked.lastActivity,
      currentActivity: tracked.lastContent,
    };

    return { agent, highlights };
  }
}
