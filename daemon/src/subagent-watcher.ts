import * as fs from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';
import { EventEmitter } from 'events';
import { SubAgent, AgentTree } from './types';

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
  private claudeHome: string;
  private watcher: chokidar.FSWatcher | null = null;
  private agents: Map<string, TrackedSubAgent> = new Map();

  constructor(claudeHome: string) {
    super();
    this.claudeHome = claudeHome;
  }

  start(): void {
    const projectsDir = path.join(this.claudeHome, 'projects');
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
      interval: 200,
    });

    this.watcher.on('add', (filePath) => this.handleFileChange(filePath));
    this.watcher.on('change', (filePath) => this.handleFileChange(filePath));
    this.watcher.on('error', (error) => {
      console.error('SubAgentWatcher error:', error);
    });
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private handleFileChange(filePath: string): void {
    try {
      const agentData = this.parseSubAgentFile(filePath);
      if (!agentData) return;

      const key = `${agentData.sessionId}:${agentData.agentId}`;
      const existing = this.agents.get(key);
      const isNew = !existing;

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

  private parseSubAgentFile(filePath: string): TrackedSubAgent | null {
    if (!fs.existsSync(filePath)) return null;

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    if (lines.length === 0) return null;

    let agentId = '';
    let slug = '';
    let sessionId = '';
    let startedAt = 0;
    let completedAt: number | undefined;
    let description = '';
    let subagentType = '';
    let messageCount = 0;
    let lastActivity = 0;
    let lastContent = '';
    let isComplete = false;

    for (const line of lines) {
      try {
        const entry: SubAgentJsonlEntry = JSON.parse(line);

        if (!agentId && entry.agentId) agentId = entry.agentId;
        if (!slug && entry.slug) slug = entry.slug;
        if (!sessionId && entry.sessionId) sessionId = entry.sessionId;

        const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();

        if (startedAt === 0) startedAt = timestamp;
        lastActivity = timestamp;

        if (entry.type === 'user' && entry.message?.content) {
          messageCount++;
          const content = typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content.map(c => c.text || '').join('');

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

          // Extract last activity content
          if (entry.message.content) {
            if (typeof entry.message.content === 'string') {
              lastContent = entry.message.content.substring(0, 50);
            } else if (Array.isArray(entry.message.content)) {
              for (const block of entry.message.content) {
                if (block.type === 'text' && block.text) {
                  lastContent = block.text.substring(0, 50);
                } else if (block.type === 'tool_use') {
                  lastContent = `Using tool...`;
                }
              }
            }
          }
        }
      } catch {
        // Skip malformed lines
      }
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

  getAgentTree(sessionId?: string): AgentTree {
    const agents: SubAgent[] = [];
    let runningCount = 0;
    let completedCount = 0;

    for (const tracked of this.agents.values()) {
      // Filter by session if specified
      if (sessionId && tracked.sessionId !== sessionId) continue;

      const status = tracked.isComplete ? 'completed' : 'running';
      if (status === 'running') runningCount++;
      else completedCount++;

      agents.push({
        agentId: tracked.agentId,
        slug: tracked.slug,
        sessionId: tracked.sessionId,
        status,
        startedAt: tracked.startedAt,
        completedAt: tracked.completedAt,
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
      sessionId: sessionId || 'all',
      agents,
      totalAgents: agents.length,
      runningCount,
      completedCount,
    };
  }

  getAgentsForSession(sessionId: string): SubAgent[] {
    return this.getAgentTree(sessionId).agents;
  }
}
