import * as fs from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';
import { EventEmitter } from 'events';
import { ConversationFile, ConversationMessage, SessionStatus, TmuxSession } from './types';
import { parseConversationFile, extractHighlights, detectWaitingForInput, detectCurrentActivity } from './parser';

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
        stabilityThreshold: 500,
        pollInterval: 100,
      },
      depth: 2,
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
    const stats = fs.statSync(filePath);
    const projectPath = this.extractProjectPath(filePath);
    const sessionId = this.generateSessionId(filePath);

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

    // Auto-switch to most recently active conversation
    let mostRecent: { id: string; time: number } | null = null;
    for (const [id, conv] of this.conversations) {
      if (!mostRecent || conv.lastModified > mostRecent.time) {
        mostRecent = { id, time: conv.lastModified };
      }
    }

    if (mostRecent) {
      this.activeSessionId = mostRecent.id;
      const activeConv = this.conversations.get(mostRecent.id);
      if (activeConv) {
        this.isWaitingForInput = activeConv.isWaitingForInput;
      }
    }

    // Only emit for the active session or if this is now active
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
    return parts[0] || 'default';
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
}
