import * as fs from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';
import { EventEmitter } from 'events';
import { ConversationFile, ConversationMessage, SessionStatus } from './types';
import { parseConversationFile, extractHighlights, detectWaitingForInput, detectCurrentActivity } from './parser';

export class ClaudeWatcher extends EventEmitter {
  private claudeHome: string;
  private watcher: chokidar.FSWatcher | null = null;
  private activeConversation: ConversationFile | null = null;
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
    // Update active conversation to the most recently modified file
    const stats = fs.statSync(filePath);
    const projectPath = this.extractProjectPath(filePath);

    const conversation: ConversationFile = {
      path: filePath,
      projectPath,
      lastModified: stats.mtimeMs,
    };

    if (!this.activeConversation || stats.mtimeMs > this.activeConversation.lastModified) {
      this.activeConversation = conversation;
    }

    // Parse and emit updates
    const messages = parseConversationFile(filePath);
    const highlights = extractHighlights(messages);
    const wasWaiting = this.isWaitingForInput;
    this.isWaitingForInput = detectWaitingForInput(messages);

    // Emit events
    const hasNewMessages = messages.length !== this.lastMessageCount;
    if (hasNewMessages) {
      this.lastMessageCount = messages.length;
      this.emit('conversation-update', {
        path: filePath,
        messages,
        highlights,
      });
    }

    // Emit status-change if waiting status changed OR if there's a new message
    const lastMessage = messages[messages.length - 1];
    const newAssistantMessage = hasNewMessages && lastMessage?.type === 'assistant';
    const currentActivity = detectCurrentActivity(messages);

    if (this.isWaitingForInput !== wasWaiting || hasNewMessages) {
      this.emit('status-change', {
        isWaitingForInput: this.isWaitingForInput,
        currentActivity,
        lastMessage,
      });
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

  getActiveConversation(): ConversationFile | null {
    return this.activeConversation;
  }

  getMessages(): ConversationMessage[] {
    if (!this.activeConversation) {
      return [];
    }
    return parseConversationFile(this.activeConversation.path);
  }

  getStatus(): SessionStatus {
    const messages = this.getMessages();
    const lastMessage = messages[messages.length - 1];

    return {
      isRunning: this.activeConversation !== null,
      isWaitingForInput: this.isWaitingForInput,
      lastActivity: lastMessage?.timestamp || 0,
      conversationId: this.activeConversation?.path,
      projectPath: this.activeConversation?.projectPath,
      currentActivity: detectCurrentActivity(messages),
    };
  }

  isWaiting(): boolean {
    return this.isWaitingForInput;
  }
}
