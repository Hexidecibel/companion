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
  // Internal conversation tracking — keyed by JSONL UUID for parse efficiency
  private conversations: Map<string, TrackedConversation> = new Map();
  // Tmux session maps — the public session model
  // Session IDs exposed to clients are tmux session names, not JSONL UUIDs.
  private tmuxSessionByPath: Map<string, string> = new Map(); // encodedPath -> tmux session name
  private tmuxPathBySession: Map<string, string> = new Map(); // tmux session name -> encodedPath
  private tmuxSessionWorkingDirs: Map<string, string> = new Map(); // tmux session name -> decoded working dir
  private activeTmuxSession: string | null = null; // public session ID (tmux session name)
  private activeConversationId: string | null = null; // internal UUID for conversation lookups
  private lastMessageCount: number = 0;
  private isWaitingForInput: boolean = false;
  private initialLoadComplete: boolean = false;
  private startTime: number = Date.now();
  private tmuxProjectPaths: Set<string> = new Set(); // encoded paths of tagged sessions only
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
      const { stdout: sessionList } = await execAsync(
        'tmux list-sessions -F "#{session_name}" 2>/dev/null'
      );
      const sessionNames = sessionList
        .trim()
        .split('\n')
        .filter((s) => s);

      // Rebuild maps — only include tagged sessions (COMPANION_APP=1)
      this.tmuxProjectPaths.clear();
      this.tmuxSessionByPath.clear();
      this.tmuxPathBySession.clear();
      this.tmuxSessionWorkingDirs.clear();

      for (const name of sessionNames) {
        try {
          // Check if this session is tagged with COMPANION_APP=1
          const { stdout: envOut } = await execAsync(
            `tmux show-environment -t "${name}" COMPANION_APP 2>/dev/null`
          );
          if (!envOut.trim().includes('COMPANION_APP=1')) {
            continue; // Skip untagged sessions
          }

          // Get active pane's working directory
          const { stdout: pwd } = await execAsync(
            `tmux display-message -t "${name}" -p "#{pane_current_path}" 2>/dev/null`
          );
          const workingDir = pwd.trim();
          if (!workingDir) continue;

          const encodedPath = workingDir.replace(/[/_]/g, '-');
          this.tmuxProjectPaths.add(encodedPath);
          this.tmuxSessionByPath.set(encodedPath, name);
          this.tmuxPathBySession.set(name, encodedPath);
          this.tmuxSessionWorkingDirs.set(name, workingDir);
        } catch {
          // Session may have been killed between list and env check
        }
      }

      if (this.tmuxProjectPaths.size > 0) {
        console.log(
          `Watcher: Tracking ${this.tmuxProjectPaths.size} paths from ${this.tmuxPathBySession.size} tagged tmux session(s)`
        );
      }

      // Prune conversations that no longer match any active tagged tmux path
      if (this.tmuxFilterEnabled && this.tmuxProjectPaths.size > 0) {
        let pruned = 0;
        for (const [id, conv] of this.conversations) {
          const encodedDir = this.getEncodedDirName(conv.path);
          if (!this.tmuxProjectPaths.has(encodedDir)) {
            this.conversations.delete(id);
            this.debounceTimers.delete(id);
            pruned++;
          }
        }
        if (pruned > 0) {
          console.log(`Watcher: Pruned ${pruned} conversations from inactive tmux sessions`);
        }
      }

      // Clear active tmux session if it no longer exists
      if (this.activeTmuxSession && !this.tmuxPathBySession.has(this.activeTmuxSession)) {
        this.activeTmuxSession = null;
        this.activeConversationId = null;
      }
    } catch {
      // tmux not running or no sessions
      this.tmuxProjectPaths.clear();
      this.tmuxSessionByPath.clear();
      this.tmuxPathBySession.clear();
      this.tmuxSessionWorkingDirs.clear();
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

  async start(): Promise<void> {
    // Load tmux paths BEFORE starting chokidar so the initial file scan
    // is filtered correctly (avoids loading all historical conversation files)
    await this.refreshTmuxPaths();

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

    // Mark initial load complete after 3 seconds so auto-select stabilizes
    setTimeout(() => {
      this.initialLoadComplete = true;
      console.log('Watcher: Initial load complete');
    }, 3000);

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

    // Skip conversations not from tagged tmux sessions
    if (!this.isFromTmuxSession(filePath)) {
      return;
    }

    const convId = this.generateSessionId(filePath);

    // For newly discovered files (not already tracked), skip if the file
    // hasn't been modified recently. This prevents loading all historical
    // conversation files during the initial chokidar scan while still
    // tracking any file that gets actively written to via 'change' events.
    if (convId && !this.conversations.has(convId)) {
      try {
        const stats = fs.statSync(filePath);
        const ageMs = Date.now() - stats.mtimeMs;
        const MAX_AGE_MS = 2 * 60 * 1000; // 2 minutes
        if (ageMs > MAX_AGE_MS) {
          return;
        }
      } catch {
        return;
      }
    }
    // Skip files outside projects directory (like root history.jsonl)
    if (!convId) {
      return;
    }

    // Debounce per conversation - avoid blocking the event loop with rapid
    // successive file parses when the CLI is actively writing
    const existingTimer = this.debounceTimers.get(convId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    this.debounceTimers.set(
      convId,
      setTimeout(() => {
        this.debounceTimers.delete(convId);
        this.processFileChange(filePath, convId);
      }, SessionWatcher.DEBOUNCE_MS)
    );
  }

  /**
   * Process a JSONL file change. convId is the internal conversation UUID
   * (JSONL filename). External events use the tmux session name as sessionId.
   */
  private processFileChange(filePath: string, convId: string): void {
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
        `Watcher: processFileChange parse took ${t1 - t0}ms + highlights ${t2 - t1}ms = ${t2 - t0}ms (${messages.length} msgs) for ${convId}`
      );
    }
    const wasWaiting = this.isWaitingForInput;
    const conversationWaiting = detectWaitingForInput(messages);

    // Get previous tracking state for compaction detection
    const prevTracked = this.conversations.get(convId);
    const lastCompactionLine = prevTracked?.lastCompactionLine || 0;

    // Find which tmux session owns this file's project directory
    const encodedDir = this.getEncodedDirName(filePath);
    const tmuxName = this.tmuxSessionByPath.get(encodedDir);

    // Use tmux session name as display name, fallback to project dir name
    const sessionName = tmuxName || projectPath.split('/').pop() || convId;
    const { event: compactionEvent, lastLine: newCompactionLine } = detectCompaction(
      filePath,
      tmuxName || convId,
      sessionName,
      projectPath,
      lastCompactionLine,
      content
    );

    if (compactionEvent) {
      console.log(`Watcher: Detected compaction in session ${tmuxName || convId}`);
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

    // Track this conversation with cached parse result (keyed by UUID internally)
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
    this.conversations.set(convId, tracked);

    // Only emit external events if this file belongs to a tagged tmux session
    // and is the best (most recently modified) conversation for that session
    if (!tmuxName) return;

    const best = this.getBestConversationForPath(encodedDir);
    if (!best || best.id !== convId) return;

    // Use tmux session name as the external session ID for all events
    const sessionId = tmuxName;

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
    if (prevWasRunning && !currentIsRunning && prevTracked) {
      const lastMsg = messages[messages.length - 1];
      this.emit('session-completed', {
        sessionId,
        projectPath,
        sessionName,
        content: lastMsg?.content?.substring(0, 200) || 'Session completed',
      });
    }

    // Auto-select: during initial load pick the most recent; after that only if no active session
    const isInitialLoad = Date.now() - this.startTime < 3000;
    if (isInitialLoad || !this.activeTmuxSession || !this.tmuxPathBySession.has(this.activeTmuxSession)) {
      // Find tmux session with most recently modified best conversation
      let bestTmux: { name: string; bestConvId: string; time: number } | null = null;
      for (const [tName, ePath] of this.tmuxPathBySession) {
        const bestConv = this.getBestConversationForPath(ePath);
        if (bestConv && (!bestTmux || bestConv.conv.lastModified > bestTmux.time)) {
          bestTmux = { name: tName, bestConvId: bestConv.id, time: bestConv.conv.lastModified };
        }
      }
      if (bestTmux) {
        this.activeTmuxSession = bestTmux.name;
        this.activeConversationId = bestTmux.bestConvId;
      }
    }

    // If this is the active tmux session, update the active conversation ID
    // (it may have changed if a new JSONL file became the "best")
    if (this.activeTmuxSession === tmuxName) {
      this.activeConversationId = convId;
    }

    // Update waiting status for the active session
    if (this.activeConversationId === convId) {
      this.isWaitingForInput = conversationWaiting;
    }

    // Emit for the active session
    if (tmuxName === this.activeTmuxSession) {
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
          sessionName,
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
    // Use the JSONL filename (UUID) as internal conversation ID
    const projectsDir = path.join(this.codeHome, 'projects');
    const relative = path.relative(projectsDir, filePath);
    const parts = relative.split(path.sep);
    // Skip files outside the projects directory (like history.jsonl in root)
    if (!parts[0] || parts[0] === '..' || parts[0].startsWith('..')) {
      return '';
    }
    // Use filename without extension as conversation ID (e.g., "abc123def456")
    const filename = path.basename(filePath, '.jsonl');
    return filename;
  }

  /**
   * Extract the encoded project directory name from a file path.
   * e.g., ~/.claude/projects/-home-hexi-foo/abc.jsonl -> "-home-hexi-foo"
   */
  private getEncodedDirName(filePath: string): string {
    const projectsDir = path.join(this.codeHome, 'projects');
    const relative = path.relative(projectsDir, filePath);
    return relative.split(path.sep)[0] || '';
  }

  /**
   * Find the best (most recently modified) conversation for a given encoded project path.
   * Returns the conversation with the highest lastModified timestamp.
   */
  private getBestConversationForPath(encodedPath: string): { id: string; conv: TrackedConversation } | null {
    let best: { id: string; conv: TrackedConversation } | null = null;
    for (const [id, conv] of this.conversations) {
      if (this.getEncodedDirName(conv.path) === encodedPath) {
        if (!best || conv.lastModified > best.conv.lastModified) {
          best = { id, conv };
        }
      }
    }
    return best;
  }

  /**
   * Resolve a session ID (tmux session name) to the internal conversation UUID.
   * If no sessionId provided, returns the active conversation ID.
   */
  private resolveToConversationId(sessionId?: string): string | null {
    if (!sessionId) return this.activeConversationId;
    // sessionId is a tmux session name — resolve to internal conversation UUID
    const encodedPath = this.tmuxPathBySession.get(sessionId);
    if (!encodedPath) return null;
    const best = this.getBestConversationForPath(encodedPath);
    return best?.id || null;
  }

  getActiveConversation(): ConversationFile | null {
    if (!this.activeConversationId) return null;
    const tracked = this.conversations.get(this.activeConversationId);
    if (!tracked) return null;

    return {
      path: tracked.path,
      projectPath: tracked.projectPath,
      lastModified: tracked.lastModified,
    };
  }

  getMessages(sessionId?: string): ConversationMessage[] {
    const targetId = this.resolveToConversationId(sessionId);
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
    const targetId = this.resolveToConversationId(sessionId);
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

  /**
   * Return one entry per tagged tmux session (instead of one per JSONL file).
   * Session ID = tmux session name.
   */
  getSessions(): TmuxSession[] {
    const sessions: TmuxSession[] = [];

    for (const [tmuxName, encodedPath] of this.tmuxPathBySession) {
      const best = this.getBestConversationForPath(encodedPath);
      const workingDir = this.tmuxSessionWorkingDirs.get(tmuxName) || '';

      sessions.push({
        id: tmuxName,
        name: tmuxName,
        projectPath: best?.conv.projectPath || workingDir,
        conversationPath: best?.conv.path,
        lastActivity: best?.conv.lastModified || 0,
        isWaitingForInput: best?.conv.isWaitingForInput || false,
        messageCount: best?.conv.messageCount || 0,
      });
    }

    // Sort by last activity (most recent first)
    sessions.sort((a, b) => b.lastActivity - a.lastActivity);

    return sessions;
  }

  getActiveSessionId(): string | null {
    return this.activeTmuxSession;
  }

  /**
   * Set the active session by tmux session name.
   * Resolves to the best (most recent) conversation for that tmux session.
   */
  setActiveSession(sessionId: string): boolean {
    // sessionId is a tmux session name
    const encodedPath = this.tmuxPathBySession.get(sessionId);
    if (!encodedPath) return false;

    const best = this.getBestConversationForPath(encodedPath);
    if (!best) {
      // Tmux session exists but no conversation yet — still allow selection
      this.activeTmuxSession = sessionId;
      this.activeConversationId = null;
      this.isWaitingForInput = false;
      this.lastMessageCount = 0;
      return true;
    }

    this.activeTmuxSession = sessionId;
    this.activeConversationId = best.id;
    this.isWaitingForInput = best.conv.isWaitingForInput;
    this.lastMessageCount = best.conv.messageCount;

    // Use cached messages instead of re-parsing
    const messages = best.conv.cachedMessages || parseConversationFile(best.conv.path);
    const hlights = extractHighlights(messages);

    this.emit('conversation-update', {
      path: best.conv.path,
      sessionId,
      messages,
      highlights: hlights,
    });

    this.emit('status-change', {
      sessionId,
      isWaitingForInput: this.isWaitingForInput,
      currentActivity: detectCurrentActivity(messages),
      lastMessage: messages[messages.length - 1],
    });

    return true;
  }

  clearActiveSession(): void {
    this.activeTmuxSession = null;
    this.activeConversationId = null;
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
   * Get the conversation file(s) for a session.
   * sessionId is a tmux session name — resolves to the best conversation.
   */
  getConversationChain(sessionId: string): string[] {
    const convId = this.resolveToConversationId(sessionId);
    if (!convId) return [];
    const tracked = this.conversations.get(convId);
    if (!tracked) return [];
    return [tracked.path];
  }

  /**
   * Check the active session for pending approval tools and emit if found.
   * Called externally when auto-approve is toggled on to retroactively approve.
   */
  checkAndEmitPendingApproval(): void {
    if (!this.activeTmuxSession || !this.activeConversationId) return;

    const tracked = this.conversations.get(this.activeConversationId);
    if (!tracked) return;

    const messages = tracked.cachedMessages || parseConversationFile(tracked.path);
    const pendingTools = getPendingApprovalTools(messages);
    if (pendingTools.length > 0) {
      this.emit('pending-approval', {
        sessionId: this.activeTmuxSession,
        projectPath: tracked.projectPath,
        tools: pendingTools,
      });
    }
  }

  /**
   * Get server summary — one entry per tagged tmux session.
   * Uses tmuxSessions from TmuxManager for authoritative tagged status,
   * finds the best conversation for each to determine activity/status.
   */
  async getServerSummary(tmuxSessions?: Array<{ name: string; workingDir?: string; tagged?: boolean }>): Promise<{
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

    // Iterate tagged tmux sessions — one sidebar entry per session
    const sessionsToIterate = tmuxSessions
      ? tmuxSessions.filter((s) => s.tagged)
      : Array.from(this.tmuxPathBySession.keys()).map((name) => ({
          name,
          workingDir: this.tmuxSessionWorkingDirs.get(name),
          tagged: true as const,
        }));

    for (const ts of sessionsToIterate) {
      const encodedPath = ts.workingDir?.replace(/[/_]/g, '-');
      const best = encodedPath ? this.getBestConversationForPath(encodedPath) : null;

      let status: 'idle' | 'working' | 'waiting' | 'error' = 'idle';
      let currentActivity: string | undefined;
      let taskSummary: TaskSummary | undefined;
      let lastActivity = 0;
      let projectPath = ts.workingDir || '';

      if (best) {
        const conv = best.conv;
        projectPath = conv.projectPath;
        lastActivity = conv.lastModified;
        taskSummary = conv.cachedTaskSummary;

        // Use cached messages for activity detection instead of re-reading large files
        const messages = conv.cachedMessages;
        currentActivity = messages
          ? detectCurrentActivity(messages)
          : detectCurrentActivityFast(conv.path);

        if (conv.isWaitingForInput) {
          status = 'waiting';
          waitingCount++;
        } else if (currentActivity) {
          status = 'working';
          workingCount++;
        }
      }

      sessions.push({
        id: ts.name,
        name: ts.name,
        projectPath,
        status,
        lastActivity,
        currentActivity,
        tmuxSessionName: ts.name,
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
