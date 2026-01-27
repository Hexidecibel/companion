import * as fs from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';
import { EventEmitter } from 'events';
import { ConversationFile, ConversationMessage, SessionStatus, TmuxSession } from './types';
import { parseConversationFile, extractHighlights, detectWaitingForInput, detectCurrentActivity, getRecentActivity, getPendingApprovalTools } from './parser';

interface TrackedConversation {
  path: string;
  projectPath: string;
  lastModified: number;
  messageCount: number;
  isWaitingForInput: boolean;
}

export class ClaudeWatcher extends EventEmitter {
  private claudeHome: string;
  private watcher: chokidar.FSWatcher | null = null;
  private conversations: Map<string, TrackedConversation> = new Map();
  private activeSessionId: string | null = null;
  private lastMessageCount: number = 0;
  private isWaitingForInput: boolean = false;
  private initialLoadComplete: boolean = false;
  private startTime: number = Date.now();

  constructor(claudeHome: string) {
    super();
    this.claudeHome = claudeHome;
  }

  start(): void {
    const projectsDir = path.join(this.claudeHome, 'projects');

    // Watch for .jsonl files in the projects directory
    const pattern = path.join(projectsDir, '**', '*.jsonl');

    console.log(`Watching for Claude conversations in: ${projectsDir}`);

    this.watcher = chokidar.watch(pattern, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
      depth: 2,
      usePolling: true,
      interval: 100,
    });

    this.watcher.on('add', (filePath) => this.handleFileChange(filePath));
    this.watcher.on('change', (filePath) => this.handleFileChange(filePath));
    this.watcher.on('error', (error) => {
      console.error('Watcher error:', error);
      this.emit('error', error);
    });

    // Also watch the main claude directory for any root-level conversation files
    const rootPattern = path.join(this.claudeHome, '*.jsonl');
    this.watcher.add(rootPattern);
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private handleFileChange(filePath: string): void {
    // Skip subagent files - they're not main conversation sessions
    if (filePath.includes('/subagents/') || filePath.includes('\\subagents\\')) {
      return;
    }

    const sessionId = this.generateSessionId(filePath);
    // Skip files outside projects directory (like root history.jsonl)
    if (!sessionId) {
      return;
    }

    const stats = fs.statSync(filePath);
    const projectPath = this.extractProjectPath(filePath);

    // Parse the conversation
    const messages = parseConversationFile(filePath);
    const highlights = extractHighlights(messages);
    const wasWaiting = this.isWaitingForInput;
    const conversationWaiting = detectWaitingForInput(messages);

    // Track this conversation
    const tracked: TrackedConversation = {
      path: filePath,
      projectPath,
      lastModified: stats.mtimeMs,
      messageCount: messages.length,
      isWaitingForInput: conversationWaiting,
    };
    this.conversations.set(sessionId, tracked);

    // During initial load (first 3 seconds), always pick the most recent session
    // After that, only auto-select if no active session exists
    const isInitialLoad = Date.now() - this.startTime < 3000;
    if (isInitialLoad || !this.activeSessionId || !this.conversations.has(this.activeSessionId)) {
      // Find most recently active conversation
      let mostRecent: { id: string; time: number } | null = null;
      for (const [id, conv] of this.conversations) {
        if (!mostRecent || conv.lastModified > mostRecent.time) {
          mostRecent = { id, time: conv.lastModified };
        }
      }

      if (mostRecent) {
        this.activeSessionId = mostRecent.id;
      }
    }

    // Update waiting status for the active session
    if (this.activeSessionId) {
      const activeConv = this.conversations.get(this.activeSessionId);
      if (activeConv && sessionId === this.activeSessionId) {
        this.isWaitingForInput = activeConv.isWaitingForInput;
      }
    }

    // Emit for the active session
    if (sessionId === this.activeSessionId) {
      // Emit events
      const hasNewMessages = messages.length !== this.lastMessageCount;
      if (hasNewMessages) {
        this.lastMessageCount = messages.length;
        this.emit('conversation-update', {
          path: filePath,
          sessionId,
          messages,
          highlights,
        });
      }

      // Emit status-change if waiting status changed OR if there's a new message
      const lastMessage = messages[messages.length - 1];
      const currentActivity = detectCurrentActivity(messages);

      if (this.isWaitingForInput !== wasWaiting || hasNewMessages) {
        this.emit('status-change', {
          sessionId,
          isWaitingForInput: this.isWaitingForInput,
          currentActivity,
          lastMessage,
        });

        // Check for pending tools that might need auto-approval
        const pendingTools = getPendingApprovalTools(messages);
        if (pendingTools.length > 0) {
          this.emit('pending-approval', {
            sessionId,
            tools: pendingTools,
          });
        }
      }
    } else {
      // Emit activity notification for non-active sessions
      const prevTracked = this.conversations.get(sessionId);
      const hadMessages = prevTracked?.messageCount || 0;
      if (messages.length > hadMessages) {
        const lastMessage = messages[messages.length - 1];
        this.emit('other-session-activity', {
          sessionId,
          projectPath,
          sessionName: projectPath.split('/').pop() || sessionId,
          isWaitingForInput: conversationWaiting,
          lastMessage,
          newMessageCount: messages.length - hadMessages,
        });
      }
    }
  }

  private extractProjectPath(filePath: string): string {
    // Extract project path from conversation file path
    // e.g., ~/.claude/projects/-Users-foo-bar/abc123.jsonl -> /Users/foo/bar
    const projectsDir = path.join(this.claudeHome, 'projects');
    const relative = path.relative(projectsDir, filePath);
    const parts = relative.split(path.sep);

    if (parts.length >= 1) {
      // Convert the encoded path back to real path
      // -Users-foo-bar -> /Users/foo/bar
      const encoded = parts[0];
      return encoded.replace(/-/g, '/');
    }

    return '';
  }

  private generateSessionId(filePath: string): string {
    // Use the directory name as session ID
    const projectsDir = path.join(this.claudeHome, 'projects');
    const relative = path.relative(projectsDir, filePath);
    const parts = relative.split(path.sep);
    const sessionId = parts[0] || 'default';
    // Skip files outside the projects directory (like history.jsonl in root .claude)
    if (sessionId === '..' || sessionId.startsWith('..')) {
      return '';
    }
    return sessionId;
  }

  getActiveConversation(): ConversationFile | null {
    if (!this.activeSessionId) return null;
    const tracked = this.conversations.get(this.activeSessionId);
    if (!tracked) return null;

    return {
      path: tracked.path,
      projectPath: tracked.projectPath,
      lastModified: tracked.lastModified,
    };
  }

  getMessages(sessionId?: string): ConversationMessage[] {
    const targetId = sessionId || this.activeSessionId;
    if (!targetId) return [];

    const tracked = this.conversations.get(targetId);
    if (!tracked) return [];

    return parseConversationFile(tracked.path);
  }

  getStatus(sessionId?: string): SessionStatus {
    const targetId = sessionId || this.activeSessionId;
    if (!targetId) {
      return {
        isRunning: false,
        isWaitingForInput: false,
        lastActivity: 0,
      };
    }

    const tracked = this.conversations.get(targetId);
    if (!tracked) {
      return {
        isRunning: false,
        isWaitingForInput: false,
        lastActivity: 0,
      };
    }

    const messages = parseConversationFile(tracked.path);
    const lastMessage = messages[messages.length - 1];

    return {
      isRunning: true,
      isWaitingForInput: tracked.isWaitingForInput,
      lastActivity: lastMessage?.timestamp || 0,
      conversationId: tracked.path,
      projectPath: tracked.projectPath,
      currentActivity: detectCurrentActivity(messages),
      recentActivity: getRecentActivity(messages, 10),
    };
  }

  getSessions(): TmuxSession[] {
    const sessions: TmuxSession[] = [];

    for (const [id, conv] of this.conversations) {
      sessions.push({
        id,
        name: conv.projectPath.split('/').pop() || id,
        projectPath: conv.projectPath,
        conversationPath: conv.path,
        lastActivity: conv.lastModified,
        isWaitingForInput: conv.isWaitingForInput,
        messageCount: conv.messageCount,
      });
    }

    // Sort by last activity (most recent first)
    sessions.sort((a, b) => b.lastActivity - a.lastActivity);

    return sessions;
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  setActiveSession(sessionId: string): boolean {
    if (this.conversations.has(sessionId)) {
      this.activeSessionId = sessionId;
      const tracked = this.conversations.get(sessionId);
      if (tracked) {
        this.isWaitingForInput = tracked.isWaitingForInput;
        this.lastMessageCount = tracked.messageCount;

        // Emit update for the new active session
        const messages = parseConversationFile(tracked.path);
        const highlights = extractHighlights(messages);

        this.emit('conversation-update', {
          path: tracked.path,
          sessionId,
          messages,
          highlights,
        });

        this.emit('status-change', {
          sessionId,
          isWaitingForInput: this.isWaitingForInput,
          currentActivity: detectCurrentActivity(messages),
          lastMessage: messages[messages.length - 1],
        });
      }
      return true;
    }
    return false;
  }

  isWaiting(): boolean {
    return this.isWaitingForInput;
  }

  async getServerSummary(tmuxSessions?: Array<{ name: string; workingDir?: string }>): Promise<{
    sessions: Array<{
      id: string;
      name: string;
      projectPath: string;
      status: 'idle' | 'working' | 'waiting' | 'error';
      lastActivity: number;
      currentActivity?: string;
    }>;
    totalSessions: number;
    waitingCount: number;
    workingCount: number;
  }> {
    // Get tmux sessions to filter - only show conversations with active tmux sessions
    // Encode the tmux paths the same way Claude does: /a/b/c -> -a-b-c
    const activeTmuxEncodedPaths = new Set(
      tmuxSessions?.map(s => s.workingDir?.replace(/\//g, '-')).filter((p): p is string => !!p) || []
    );

    const sessions: Array<{
      id: string;
      name: string;
      projectPath: string;
      status: 'idle' | 'working' | 'waiting' | 'error';
      lastActivity: number;
      currentActivity?: string;
    }> = [];

    let waitingCount = 0;
    let workingCount = 0;

    for (const [id, conv] of this.conversations) {
      // Skip if no matching tmux session (unless tmuxSessions wasn't provided)
      // Compare using the session ID which is the encoded path (e.g., -Users-foo-bar)
      if (tmuxSessions && !activeTmuxEncodedPaths.has(id)) {
        continue;
      }

      const messages = parseConversationFile(conv.path);
      const currentActivity = detectCurrentActivity(messages);

      // Determine status
      let status: 'idle' | 'working' | 'waiting' | 'error' = 'idle';
      if (conv.isWaitingForInput) {
        status = 'waiting';
        waitingCount++;
      } else if (currentActivity) {
        status = 'working';
        workingCount++;
      }

      sessions.push({
        id,
        name: conv.projectPath.split('/').pop() || id,
        projectPath: conv.projectPath,
        status,
        lastActivity: conv.lastModified,
        currentActivity,
      });
    }

    // Sort by last activity (most recent first)
    sessions.sort((a, b) => b.lastActivity - a.lastActivity);

    return {
      sessions,
      totalSessions: sessions.length,
      waitingCount,
      workingCount,
    };
  }
}
