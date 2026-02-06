import * as fs from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';
import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ConversationFile, ConversationMessage, SessionStatus, TmuxSession } from './types';
import {
  parseConversationFile,
  extractHighlights,
  detectWaitingForInput,
  detectCurrentActivity,
  detectCurrentActivityFast,
  getRecentActivity,
  getPendingApprovalTools,
  detectCompaction,
  extractTasks,
} from './parser';

const execAsync = promisify(exec);

interface TaskSummary {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  activeTask?: string;
}

interface TrackedConversation {
  path: string;
  projectPath: string;
  lastModified: number;
  messageCount: number;
  isWaitingForInput: boolean;
  isRunning: boolean;
  lastCompactionLine: number;
  cachedMessages: ConversationMessage[] | null;
  cachedTaskSummary?: TaskSummary;
  lastEmittedPendingTools: string; // JSON key of last emitted pending tools to deduplicate
  lastErrorCount: number; // Track error count for dedup
}

export class SessionWatcher extends EventEmitter {
  private codeHome: string;
  private watcher: chokidar.FSWatcher | null = null;
  private conversations: Map<string, TrackedConversation> = new Map();
  private activeSessionId: string | null = null;
  private lastMessageCount: number = 0;
  private isWaitingForInput: boolean = false;
  private initialLoadComplete: boolean = false;
  private startTime: number = Date.now();
  private tmuxProjectPaths: Set<string> = new Set();
  private tmuxFilterEnabled: boolean = true;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private static readonly DEBOUNCE_MS = 150; // Debounce file changes per session

  constructor(codeHome: string) {
    super();
    this.codeHome = codeHome;
    // Refresh tmux paths periodically
    this.refreshTmuxPaths();
    setInterval(() => this.refreshTmuxPaths(), 5000);
  }

  async refreshTmuxPaths(): Promise<void> {
    try {
      // Get list of tmux sessions - only those tagged with COMPANION_APP=1
      // First get all session names, then filter to tagged ones
      const { stdout: sessionList } = await execAsync(
        'tmux list-sessions -F "#{session_name}" 2>/dev/null'
      );
      const sessionNames = sessionList
        .trim()
        .split('\n')
        .filter((s) => s);

      // Check which sessions are tagged as managed by Companion
      const taggedSessions: string[] = [];
      for (const name of sessionNames) {
        try {
          const { stdout: envOut } = await execAsync(
            `tmux show-environment -t "${name}" COMPANION_APP 2>/dev/null`
          );
          if (envOut.trim().includes('COMPANION_APP=1')) {
            taggedSessions.push(name);
          }
        } catch {
          // Not tagged - skip
        }
      }

      // Get pane paths only for tagged sessions
      this.tmuxProjectPaths.clear();
      for (const name of taggedSessions) {
        try {
          const { stdout: paneOut } = await execAsync(
            `tmux list-panes -t "${name}" -F "#{pane_current_path}" 2>/dev/null`
          );
          const paths = paneOut
            .trim()
            .split('\n')
            .filter((p) => p);
          for (const p of paths) {
            // Encode path the same way Claude CLI does: replace / and _ with -
            const projectPath = p.replace(/[/_]/g, '-');
            this.tmuxProjectPaths.add(projectPath);
          }
        } catch {
          // Session may have been killed between list and pane check
        }
      }

      if (this.tmuxProjectPaths.size > 0) {
        console.log(
          `Watcher: Tracking ${this.tmuxProjectPaths.size} paths from ${taggedSessions.length} managed session(s)`
        );
      }
    } catch {
      // tmux not running or no sessions
      this.tmuxProjectPaths.clear();
    }
  }

  private isFromTmuxSession(filePath: string): boolean {
    if (!this.tmuxFilterEnabled || this.tmuxProjectPaths.size === 0) {
      return true; // No filtering if disabled or no tmux sessions
    }

    // Extract project path from file path
    // e.g., ~/.claude/projects/-Users-foo-bar/uuid.jsonl -> -Users-foo-bar
    const projectsDir = path.join(this.codeHome, 'projects');
    const relativePath = path.relative(projectsDir, filePath);
    const projectDir = relativePath.split(path.sep)[0];

    return this.tmuxProjectPaths.has(projectDir);
  }

  start(): void {
    const projectsDir = path.join(this.codeHome, 'projects');

    // Watch for .jsonl files in the projects directory
    const pattern = path.join(projectsDir, '**', '*.jsonl');

    console.log(`Watching for conversations in: ${projectsDir}`);

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

    // Also watch the main directory for any root-level conversation files
    const rootPattern = path.join(this.codeHome, '*.jsonl');
    this.watcher.add(rootPattern);
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  private handleFileChange(filePath: string): void {
    // Skip subagent files - they're not main conversation sessions
    if (filePath.includes('/subagents/') || filePath.includes('\\subagents\\')) {
      return;
    }

    // Skip conversations not from tmux sessions
    if (!this.isFromTmuxSession(filePath)) {
      return;
    }

    const sessionId = this.generateSessionId(filePath);
    // Skip files outside projects directory (like root history.jsonl)
    if (!sessionId) {
      return;
    }

    // Debounce per session - avoid blocking the event loop with rapid
    // successive file parses when the CLI is actively writing
    const existingTimer = this.debounceTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    this.debounceTimers.set(
      sessionId,
      setTimeout(() => {
        this.debounceTimers.delete(sessionId);
        this.processFileChange(filePath, sessionId);
      }, SessionWatcher.DEBOUNCE_MS)
    );
  }

  private processFileChange(filePath: string, sessionId: string): void {
    const stats = fs.statSync(filePath);
    const projectPath = this.extractProjectPath(filePath);

    // Read the file ONCE and share the content
    const content = fs.readFileSync(filePath, 'utf-8');

    // Parse the conversation from content
    const t0 = Date.now();
    const messages = parseConversationFile(filePath, undefined, content);
    const t1 = Date.now();
    const highlights = extractHighlights(messages);
    const t2 = Date.now();
    if (t2 - t0 > 50) {
      console.log(
        `Watcher: processFileChange parse took ${t1 - t0}ms + highlights ${t2 - t1}ms = ${t2 - t0}ms (${messages.length} msgs) for ${sessionId}`
      );
    }
    const wasWaiting = this.isWaitingForInput;
    const conversationWaiting = detectWaitingForInput(messages);

    // Get previous tracking state for compaction detection
    const prevTracked = this.conversations.get(sessionId);
    const lastCompactionLine = prevTracked?.lastCompactionLine || 0;

    // Check for compaction events using already-read content
    const sessionName = projectPath.split('/').pop() || sessionId;
    const { event: compactionEvent, lastLine: newCompactionLine } = detectCompaction(
      filePath,
      sessionId,
      sessionName,
      projectPath,
      lastCompactionLine,
      content
    );

    if (compactionEvent) {
      console.log(`Watcher: Detected compaction in session ${sessionId}`);
      this.emit('compaction', compactionEvent);
    }

    // Extract and cache task summary from already-read content
    let cachedTaskSummary: TaskSummary | undefined;
    try {
      const tasks = extractTasks(content);
      if (tasks.length > 0) {
        const pending = tasks.filter((t) => t.status === 'pending').length;
        const inProgressTasks = tasks.filter((t) => t.status === 'in_progress');
        const completed = tasks.filter((t) => t.status === 'completed').length;
        cachedTaskSummary = {
          total: tasks.length,
          pending,
          inProgress: inProgressTasks.length,
          completed,
          activeTask: inProgressTasks[0]?.activeForm || inProgressTasks[0]?.subject,
        };
      }
    } catch {
      // Silent fail - tasks are optional
    }

    // Detect error tool results for error-detected event
    let errorCount = 0;
    for (const msg of messages) {
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          if (tc.status === 'error') errorCount++;
        }
      }
    }

    // Detect running state: has messages and last message is from assistant with no waiting
    const currentIsRunning = messages.length > 0 && !conversationWaiting;
    const prevWasRunning = prevTracked?.isRunning ?? false;
    const prevErrorCount = prevTracked?.lastErrorCount ?? 0;

    // Track this conversation with cached parse result
    const tracked: TrackedConversation = {
      path: filePath,
      projectPath,
      lastModified: stats.mtimeMs,
      messageCount: messages.length,
      isWaitingForInput: conversationWaiting,
      isRunning: currentIsRunning,
      lastCompactionLine: newCompactionLine,
      cachedMessages: messages,
      cachedTaskSummary,
      lastEmittedPendingTools: prevTracked?.lastEmittedPendingTools || '',
      lastErrorCount: errorCount,
    };
    this.conversations.set(sessionId, tracked);

    // Emit error-detected when new errors appear
    if (errorCount > prevErrorCount) {
      const lastErrorTool = messages
        .flatMap((m) => m.toolCalls || [])
        .filter((tc) => tc.status === 'error')
        .pop();
      this.emit('error-detected', {
        sessionId,
        projectPath,
        sessionName,
        content: lastErrorTool?.output || 'Tool error detected',
      });
    }

    // Emit session-completed when running transitions to not-running (idle)
    // Only emit after initial load to avoid false positives on startup
    if (prevWasRunning && !currentIsRunning && prevTracked) {
      const lastMsg = messages[messages.length - 1];
      this.emit('session-completed', {
        sessionId,
        projectPath,
        sessionName,
        content: lastMsg?.content?.substring(0, 200) || 'Session completed',
      });
    }

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
      }

      // Check for pending tools - only emit when the set of pending tools CHANGES
      // to avoid spamming auto-approve on every 100ms file poll.
      const pendingTools = getPendingApprovalTools(messages);
      const pendingKey = pendingTools.length > 0 ? pendingTools.sort().join(',') : '';
      if (pendingKey && pendingKey !== tracked.lastEmittedPendingTools) {
        tracked.lastEmittedPendingTools = pendingKey;
        this.emit('pending-approval', {
          sessionId,
          projectPath,
          tools: pendingTools,
        });
      } else if (!pendingKey) {
        // Clear when no more pending tools (so next approval triggers fresh)
        tracked.lastEmittedPendingTools = '';
      }
    } else {
      // Emit activity notification for non-active sessions
      const hadMessages = prevTracked?.messageCount || 0;
      const wasWaitingOther = prevTracked?.isWaitingForInput || false;
      const hasNewMessages = messages.length > hadMessages;
      const waitingStatusChanged = conversationWaiting !== wasWaitingOther;

      // Notify on new messages OR when waiting-for-input status changes
      if (hasNewMessages || waitingStatusChanged) {
        const lastMessage = messages[messages.length - 1];
        this.emit('other-session-activity', {
          sessionId,
          projectPath,
          sessionName: projectPath.split('/').pop() || sessionId,
          isWaitingForInput: conversationWaiting,
          lastMessage,
          newMessageCount: hasNewMessages ? messages.length - hadMessages : 0,
        });

        // Check for pending tools in non-active sessions too (only on change)
        const pendingTools = getPendingApprovalTools(messages);
        const pendingKey = pendingTools.length > 0 ? pendingTools.sort().join(',') : '';
        if (pendingKey && pendingKey !== tracked.lastEmittedPendingTools) {
          tracked.lastEmittedPendingTools = pendingKey;
          this.emit('pending-approval', {
            sessionId,
            projectPath,
            tools: pendingTools,
          });
        } else if (!pendingKey) {
          tracked.lastEmittedPendingTools = '';
        }
      }
    }
  }

  private extractProjectPath(filePath: string): string {
    // Extract project path from conversation file path
    // e.g., ~/.claude/projects/-Users-foo-bar/abc123.jsonl -> /Users/foo/bar
    const projectsDir = path.join(this.codeHome, 'projects');
    const relative = path.relative(projectsDir, filePath);
    const parts = relative.split(path.sep);

    if (parts.length >= 1) {
      const encoded = parts[0];
      // Smart decode: try to find which interpretation of dashes is correct
      // by checking if the path exists on the filesystem
      const decoded = this.smartDecodePath(encoded);
      return decoded;
    }

    return '';
  }

  private smartDecodePath(encoded: string): string {
    // Remove leading dash
    const withoutLeading = encoded.replace(/^-/, '');
    const parts = withoutLeading.split('-');

    // Try to find the real path by progressively building it
    // and checking which segments should be joined with / vs -
    let currentPath = '';
    let i = 0;

    while (i < parts.length) {
      const part = parts[i];
      const testWithSlash = currentPath ? `${currentPath}/${part}` : `/${part}`;

      // Look ahead to see if joining with dash creates a valid path
      let foundWithDash = false;
      if (currentPath && i < parts.length) {
        // Check if path with dash exists
        for (let j = i; j < parts.length; j++) {
          const dashJoined = currentPath + '-' + parts.slice(i, j + 1).join('-');
          if (fs.existsSync(dashJoined) && fs.statSync(dashJoined).isDirectory()) {
            // Found a valid path with dashes
            currentPath = dashJoined;
            i = j + 1;
            foundWithDash = true;
            break;
          }
        }
      }

      if (!foundWithDash) {
        // Use slash separator
        currentPath = testWithSlash;
        i++;
      }
    }

    // If the smart decode didn't find a valid path, fall back to simple decode
    if (!fs.existsSync(currentPath)) {
      // Simple fallback: replace all dashes with slashes
      return '/' + withoutLeading.replace(/-/g, '/');
    }

    return currentPath;
  }

  private generateSessionId(filePath: string): string {
    // Use the directory name as session ID
    const projectsDir = path.join(this.codeHome, 'projects');
    const relative = path.relative(projectsDir, filePath);
    const parts = relative.split(path.sep);
    const sessionId = parts[0] || 'default';
    // Skip files outside the projects directory (like history.jsonl in root)
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

    // Check if file has been modified since our cache (catches race with debounce)
    if (tracked.cachedMessages) {
      try {
        const currentMtime = fs.statSync(tracked.path).mtimeMs;
        if (currentMtime > tracked.lastModified) {
          // File changed since cache — re-parse and update cache
          const messages = parseConversationFile(tracked.path);
          tracked.cachedMessages = messages;
          tracked.lastModified = currentMtime;
          return messages;
        }
      } catch {
        // stat failed, use cache
      }
      return tracked.cachedMessages;
    }
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

    // Use cached messages instead of re-parsing
    const messages = tracked.cachedMessages || parseConversationFile(tracked.path);
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

        // Use cached messages instead of re-parsing
        const messages = tracked.cachedMessages || parseConversationFile(tracked.path);
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

  clearActiveSession(): void {
    this.activeSessionId = null;
    this.isWaitingForInput = false;
    this.lastMessageCount = 0;

    // Emit empty update so clients clear their UI
    this.emit('conversation-update', {
      path: '',
      sessionId: null,
      messages: [],
      highlights: [],
    });

    this.emit('status-change', {
      sessionId: null,
      isWaitingForInput: false,
      currentActivity: undefined,
      lastMessage: undefined,
    });
  }

  isWaiting(): boolean {
    return this.isWaitingForInput;
  }

  /**
   * Get all conversation JSONL files for a session, sorted oldest-first.
   * Used for cross-session infinite scroll — when the client exhausts the
   * current file's messages, older files in the same project dir are loaded.
   */
  getConversationChain(sessionId: string): string[] {
    const tracked = this.conversations.get(sessionId);
    if (!tracked) return [];

    const dir = path.dirname(tracked.path);
    try {
      // Get birthtime of the tracked file to exclude newer unrelated sessions
      const trackedBirthtime = fs.statSync(tracked.path).birthtimeMs;

      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl') && !f.includes('subagents'))
        .map((f) => {
          const fullPath = path.join(dir, f);
          try {
            const stats = fs.statSync(fullPath);
            return { path: fullPath, birthtime: stats.birthtimeMs };
          } catch {
            return null;
          }
        })
        .filter((f): f is { path: string; birthtime: number } => f !== null)
        // Only include files born at or before the tracked file — newer files
        // are separate conversations, not part of this session's chain
        .filter((f) => f.birthtime <= trackedBirthtime);

      // Sort oldest-first so index 0 is the oldest file
      files.sort((a, b) => a.birthtime - b.birthtime);

      // Limit to last 20 files to prevent memory issues
      const chain = files.map((f) => f.path);
      return chain.length > 20 ? chain.slice(-20) : chain;
    } catch {
      // Directory read failed — fall back to just the tracked file
      return [tracked.path];
    }
  }

  /**
   * Check the active session for pending approval tools and emit if found.
   * Called externally when auto-approve is toggled on to retroactively approve.
   */
  checkAndEmitPendingApproval(): void {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;

    const tracked = this.conversations.get(sessionId);
    if (!tracked) return;

    const messages = tracked.cachedMessages || parseConversationFile(tracked.path);
    const pendingTools = getPendingApprovalTools(messages);
    if (pendingTools.length > 0) {
      this.emit('pending-approval', {
        sessionId,
        projectPath: tracked.projectPath,
        tools: pendingTools,
      });
    }
  }

  async getServerSummary(tmuxSessions?: Array<{ name: string; workingDir?: string }>): Promise<{
    sessions: Array<{
      id: string;
      name: string;
      projectPath: string;
      status: 'idle' | 'working' | 'waiting' | 'error';
      lastActivity: number;
      currentActivity?: string;
      tmuxSessionName?: string;
      taskSummary?: {
        total: number;
        pending: number;
        inProgress: number;
        completed: number;
        activeTask?: string;
      };
    }>;
    totalSessions: number;
    waitingCount: number;
    workingCount: number;
  }> {
    // Get tmux sessions to filter - only show conversations with active tmux sessions
    // Encode the tmux paths the same way the CLI does: /a/b_c -> -a-b-c
    const activeTmuxEncodedPaths = new Map<string, string>();
    if (tmuxSessions) {
      for (const s of tmuxSessions) {
        const encoded = s.workingDir?.replace(/[/_]/g, '-');
        if (encoded) {
          activeTmuxEncodedPaths.set(encoded, s.name);
        }
      }
    }

    const sessions: Array<{
      id: string;
      name: string;
      projectPath: string;
      status: 'idle' | 'working' | 'waiting' | 'error';
      lastActivity: number;
      currentActivity?: string;
      tmuxSessionName?: string;
      taskSummary?: {
        total: number;
        pending: number;
        inProgress: number;
        completed: number;
        activeTask?: string;
      };
    }> = [];

    let waitingCount = 0;
    let workingCount = 0;

    for (const [id, conv] of this.conversations) {
      // Skip if no matching tmux session (unless tmuxSessions wasn't provided)
      // Compare using the session ID which is the encoded path (e.g., -Users-foo-bar)
      if (tmuxSessions && !activeTmuxEncodedPaths.has(id)) {
        continue;
      }

      // Use cached messages for activity detection instead of re-reading large files
      const messages = conv.cachedMessages;
      const currentActivity = messages
        ? detectCurrentActivity(messages)
        : detectCurrentActivityFast(conv.path);

      // Determine status
      let status: 'idle' | 'working' | 'waiting' | 'error' = 'idle';
      if (conv.isWaitingForInput) {
        status = 'waiting';
        waitingCount++;
      } else if (currentActivity) {
        status = 'working';
        workingCount++;
      }

      // Use cached task summary instead of re-reading multi-MB files on every poll.
      // Task summaries are computed during processFileChange and cached.
      const taskSummary = conv.cachedTaskSummary;

      // Look up the tmux session name from the encoded path map
      const tmuxSessionName = activeTmuxEncodedPaths.get(id);

      sessions.push({
        id,
        name: conv.projectPath.split('/').pop() || id,
        projectPath: conv.projectPath,
        status,
        lastActivity: conv.lastModified,
        currentActivity,
        tmuxSessionName,
        taskSummary,
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
