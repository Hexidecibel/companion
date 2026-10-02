import * as fs from 'fs';
import {
  PANE_INFO_FORMAT,
  SessionIdentity,
  encodeProjectDir,
  findClaudePid,
  identityChanged,
  parsePaneInfo,
  sanitizeIdentity,
} from './session-identity';
import * as path from 'path';
import * as chokidar from 'chokidar';
import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ConversationFile, ConversationMessage, FeedbackPrompt, SessionStatus, TmuxSession } from './types';
import { InputInjector } from './input-injector';
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
  detectActiveChoicePrompt,
} from './parser';
import { APPROVAL_TOOLS } from './tool-config';
import {
  TMUX_PATH_REFRESH_INTERVAL_MS,
  CHOKIDAR_STABILITY_THRESHOLD_MS,
  CHOKIDAR_POLL_INTERVAL_MS,
  FILE_WATCHER_POLL_INTERVAL_MS,
  INITIAL_LOAD_COMPLETION_DELAY_MS,
  INITIAL_FILE_MAX_AGE_MS,
  INITIAL_LOAD_WINDOW_MS,
  SLOW_FILE_PROCESSING_THRESHOLD_MS,
  SESSION_COMPLETION_MESSAGE_LENGTH,
  MIN_USER_PROMPT_LENGTH,
  CONVERSATION_READ_BUFFER_SIZE,
  CONVERSATION_ID_LOG_LENGTH,
  USER_LINE_LOG_LENGTH,
  RECENT_ACTIVITY_LIMIT,
} from './constants';
import { atomicWriteFileSync, registerShutdownCallback } from './utils';
import { isReadonlySharedState } from './sandbox';

const execAsync = promisify(exec);

/**
 * Parse a feedback prompt from tmux terminal output.
 * The Claude CLI shows this at session end:
 *   * How is Claude doing this session? (optional)
 *     1: Bad    2: Fine    3: Good    0: Dismiss
 */
function parseFeedbackPrompt(tmuxText: string): FeedbackPrompt | null {
  // Strip ANSI escape codes
  const clean = tmuxText.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

  // Look for the question
  const questionMatch = clean.match(/How is Claude doing this session/i);
  if (!questionMatch) return null;

  // Extract digit:label pairs from nearby text
  const optionRegex = /(\d)\s*:\s*(\w+)/g;
  const options: Array<{ key: string; label: string }> = [];
  let match;
  while ((match = optionRegex.exec(clean)) !== null) {
    options.push({ key: match[1], label: match[2] });
  }

  if (options.length === 0) return null;

  return {
    question: 'How is Claude doing this session?',
    options,
  };
}

interface TaskSummary {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  activeTask?: string;
}

/** Snapshot of a session saved to disk for persistence across daemon restarts. */
interface PersistedSessionSnapshot {
  id: string;           // tmux session name
  name: string;
  projectPath: string;
  conversationPath?: string;
  lastActivity: number;
  isWaitingForInput: boolean;
  messageCount: number;
  savedAt: number;      // when this snapshot was taken
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

export interface FileChangeOptions {
  /**
   * Cache-only load (e.g. Herald reading an idle session's transcript on demand):
   * parse and track the conversation but emit no events, so a stale transcript
   * never triggers notifications, escalation, feedback polling or auto-approval.
   */
  quiet?: boolean;
}

export class SessionWatcher extends EventEmitter {
  private codeHome: string;
  private watcher: chokidar.FSWatcher | null = null;
  private loggedReadonlySharedState = false;
  // Internal conversation tracking — keyed by JSONL UUID for parse efficiency
  private conversations: Map<string, TrackedConversation> = new Map();
  // Tmux session maps — the public session model
  // Session IDs exposed to clients are tmux session names, not JSONL UUIDs.
  private tmuxSessionByPath: Map<string, string> = new Map(); // encodedPath -> tmux session name
  private tmuxPathBySession: Map<string, string> = new Map(); // tmux session name -> encodedPath
  private tmuxSessionWorkingDirs: Map<string, string> = new Map(); // tmux session name -> decoded working dir
  private tmuxConversationIds: Map<string, string> = new Map(); // tmux session name -> conversation UUID (direct mapping via PID detection)
  private tmuxConversationHistory: Map<string, string[]> = new Map(); // tmux session name -> ordered conversation UUIDs (oldest first)
  private _lastMappingLog: string = ''; // Dedup mapping log output
  private activeTmuxSession: string | null = null; // public session ID (tmux session name)
  private activeConversationId: string | null = null; // internal UUID for conversation lookups
  private lastMessageCount: number = 0;
  private isWaitingForInput: boolean = false;
  private initialLoadComplete: boolean = false;
  private startTime: number = Date.now();
  private tmuxProjectPaths: Set<string> = new Set(); // encoded paths of tagged sessions only
  private tmuxFilterEnabled: boolean = true;
  private newlyCreatedSessions: Map<string, number> = new Map(); // session name -> creation timestamp
  private tmuxSessionIdentity: Map<string, SessionIdentity> = new Map(); // session name -> current identity
  private mappingIdentity: Map<string, SessionIdentity> = new Map(); // session name -> identity its mapping was made for
  private decodedPathCache: Map<string, string> = new Map(); // encoded project dir -> decoded path
  private compactedSessions: Set<string> = new Set(); // sessions expecting a new JSONL after compaction
  private detectInFlight: Set<string> = new Set(); // sessions currently being probed by detectConversationForSession
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private waitingDebounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private static readonly DEBOUNCE_MS = 150; // Debounce file changes per session
  private static readonly WAITING_DEBOUNCE_MS = 3000; // Delay before confirming "waiting" for non-interactive tools

  // Persisted sessions — loaded from disk on startup, merged with live data
  private persistedSessions: Map<string, PersistedSessionSnapshot> = new Map();

  // Feedback prompt detection
  private inputInjector: InputInjector | null = null;
  private feedbackPollTimer: NodeJS.Timeout | null = null;
  private feedbackPollCount: number = 0;
  private feedbackPrompt: FeedbackPrompt | null = null;
  private feedbackSessionId: string | null = null; // tmux session name that has the feedback prompt
  private static readonly FEEDBACK_POLL_INTERVAL_MS = 3000;
  private static readonly FEEDBACK_POLL_MAX_ATTEMPTS = 10;

  constructor(codeHome: string, inputInjector?: InputInjector) {
    super();
    this.codeHome = codeHome;
    this.inputInjector = inputInjector || null;
    this.loadPersistedMappings();
    this.loadPersistedSessions();
    // Refresh tmux paths periodically
    this.refreshTmuxPaths();
    const tmuxRefreshInterval = setInterval(() => this.refreshTmuxPaths(), TMUX_PATH_REFRESH_INTERVAL_MS);
    registerShutdownCallback(() => {
      clearInterval(tmuxRefreshInterval);
      this.persistSessions();
    });
  }

  private get mappingsPath(): string {
    return path.join(this.codeHome, 'companion-session-mappings.json');
  }

  private loadPersistedMappings(): void {
    try {
      const data = fs.readFileSync(this.mappingsPath, 'utf-8');
      const parsed = JSON.parse(data);
      let loaded = 0;

      // New format: { mappings: {...}, history: {...} }
      // Old format: { "session": "convId", ... } (flat, no "mappings" key)
      const isNewFormat = parsed.mappings && typeof parsed.mappings === 'object';
      const mappings: Record<string, string> = isNewFormat ? parsed.mappings : parsed;

      for (const [session, convId] of Object.entries(mappings)) {
        if (typeof convId === 'string') {
          this.tmuxConversationIds.set(session, convId);
          loaded++;
        }
      }

      // Identity each mapping was made for (absent in older files = adopt on next refresh)
      if (isNewFormat && parsed.identity && typeof parsed.identity === 'object') {
        for (const [session, raw] of Object.entries(parsed.identity)) {
          const id = sanitizeIdentity(raw);
          if (id && this.tmuxConversationIds.has(session)) this.mappingIdentity.set(session, id);
        }
      }

      // Load history if present
      if (isNewFormat && parsed.history) {
        for (const [session, ids] of Object.entries(parsed.history)) {
          if (Array.isArray(ids)) {
            this.tmuxConversationHistory.set(session, ids as string[]);
          }
        }
      }

      if (loaded > 0) {
        console.log(`Watcher: Loaded ${loaded} persisted session mappings`);
      }
    } catch {
      // No persisted mappings or parse error — start fresh
    }
  }

  /** True (and logs once) when shared code_home state must not be written. */
  private sharedStateReadonly(): boolean {
    if (!isReadonlySharedState()) return false;
    if (!this.loggedReadonlySharedState) {
      this.loggedReadonlySharedState = true;
      console.log(
        'Watcher: read-only shared state (sandbox): not writing companion-session-mappings.json / companion-sessions-snapshot.json'
      );
    }
    return true;
  }

  private persistMappings(): void {
    if (this.sharedStateReadonly()) return;
    try {
      const mappings: Record<string, string> = {};
      for (const [session, convId] of this.tmuxConversationIds) {
        mappings[session] = convId;
      }

      // Only persist history for sessions that still have active mappings
      const history: Record<string, string[]> = {};
      for (const [session, ids] of this.tmuxConversationHistory) {
        if (this.tmuxConversationIds.has(session)) {
          history[session] = ids;
        }
      }

      const identity: Record<string, SessionIdentity> = {};
      for (const [session, id] of this.mappingIdentity) {
        if (this.tmuxConversationIds.has(session)) identity[session] = id;
      }

      atomicWriteFileSync(this.mappingsPath, JSON.stringify({ mappings, history, identity }));
    } catch {
      // Not critical
    }
  }

  private get sessionsSnapshotPath(): string {
    return path.join(this.codeHome, 'companion-sessions-snapshot.json');
  }

  private loadPersistedSessions(): void {
    try {
      const data = fs.readFileSync(this.sessionsSnapshotPath, 'utf-8');
      const snapshots: PersistedSessionSnapshot[] = JSON.parse(data);
      let loaded = 0;
      for (const snap of snapshots) {
        // Only load if the conversation file still exists on disk
        if (snap.conversationPath && !fs.existsSync(snap.conversationPath)) {
          continue;
        }
        this.persistedSessions.set(snap.id, snap);
        loaded++;
      }
      if (loaded > 0) {
        console.log(`Watcher: Loaded ${loaded} persisted session snapshots`);
      }
    } catch {
      // No persisted sessions or parse error — start fresh
    }
  }

  /** Save current session list to disk. Called on session changes and shutdown. */
  persistSessions(): void {
    if (this.sharedStateReadonly()) return;
    try {
      const sessions = this.getSessionsInternal(true);
      const snapshots: PersistedSessionSnapshot[] = sessions.map((s) => ({
        id: s.id,
        name: s.name,
        projectPath: s.projectPath || '',
        conversationPath: s.conversationPath,
        lastActivity: s.lastActivity,
        isWaitingForInput: s.isWaitingForInput,
        messageCount: s.messageCount,
        savedAt: Date.now(),
      }));
      atomicWriteFileSync(this.sessionsSnapshotPath, JSON.stringify(snapshots));
    } catch {
      // Not critical
    }
  }

  /**
   * Set a tmux session → conversation mapping and maintain history.
   * @param isChainExtension - true when appending a new file after compaction (preserves old ID in history)
   */
  private setConversationMapping(
    sessionName: string,
    convId: string,
    isChainExtension: boolean = false
  ): void {
    const history = this.tmuxConversationHistory.get(sessionName) || [];

    if (isChainExtension) {
      // Compaction: the old ID should already be in history; append the new one
      if (!history.includes(convId)) {
        history.push(convId);
      }
    } else {
      // Initial discovery / re-detection: ensure current ID is at the end
      if (!history.includes(convId)) {
        history.push(convId);
      }
    }

    this.tmuxConversationHistory.set(sessionName, history);
    this.tmuxConversationIds.set(sessionName, convId);
    const identity = this.tmuxSessionIdentity.get(sessionName);
    if (identity && (!isChainExtension || !this.mappingIdentity.has(sessionName)))
      this.mappingIdentity.set(sessionName, { ...identity });
  }

  /** Forget everything that ties a session name to a transcript. */
  private dropConversationMapping(sessionName: string): boolean {
    const had = this.tmuxConversationIds.delete(sessionName);
    const hadHistory = this.tmuxConversationHistory.delete(sessionName);
    this.mappingIdentity.delete(sessionName);
    this.compactedSessions.delete(sessionName);
    return had || hadHistory;
  }

  /**
   * A reused tmux session name (session created again, maybe in another cwd)
   * or a new claude process in the same session: the old conversation mapping
   * is stale. Drop it and treat the session as new, so the first transcript
   * written after the change is claimed instead of the old one.
   */
  private reconcileSessionIdentities(): void {
    let changed = false;
    for (const [name, cur] of this.tmuxSessionIdentity) {
      if (!this.tmuxConversationIds.has(name)) continue;
      const prev = this.mappingIdentity.get(name);
      if (!prev) {
        // Older mapping file: adopt what runs now.
        this.mappingIdentity.set(name, { ...cur });
        changed = true;
        continue;
      }
      if (identityChanged(prev, cur)) {
        const sessionNew = !!(prev.created && cur.created && prev.created !== cur.created) ||
          !!(prev.panePid && cur.panePid && prev.panePid !== cur.panePid);
        console.log(
          `Watcher: ${name} is a ${sessionNew ? 'new tmux session with a reused name' : 'new claude process'}; dropping stale mapping -> ${this.tmuxConversationIds.get(name)?.substring(0, 8)}`
        );
        this.dropConversationMapping(name);
        const createdMs = Number(cur.created) * 1000;
        this.newlyCreatedSessions.set(
          name,
          sessionNew && createdMs > 0 ? Math.min(createdMs, Date.now()) : Date.now() - 2000
        );
        if (this.activeTmuxSession === name) this.activeConversationId = null;
        changed = true;
        continue;
      }
      // Fill in what was unknown when the mapping was made (claude started later).
      const filled: SessionIdentity = {
        created: prev.created || cur.created,
        panePid: prev.panePid || cur.panePid,
        encodedPath: prev.encodedPath || cur.encodedPath,
        claudePid: prev.claudePid ?? cur.claudePid,
      };
      if (filled.created !== prev.created || filled.panePid !== prev.panePid || filled.claudePid !== prev.claudePid) {
        this.mappingIdentity.set(name, filled);
        changed = true;
      }
    }
    if (changed) this.persistMappings();
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
      this.tmuxSessionIdentity.clear();

      for (const name of sessionNames) {
        try {
          // Check if this session is tagged with COMPANION_APP=1
          const { stdout: envOut } = await execAsync(
            `tmux show-environment -t "${name}" COMPANION_APP 2>/dev/null`
          );
          if (!envOut.trim().includes('COMPANION_APP=1')) {
            continue; // Skip untagged sessions
          }

          // Active pane's working directory + session identity, in one call
          const { stdout: paneOut } = await execAsync(
            `tmux display-message -t "${name}" -p "${PANE_INFO_FORMAT}" 2>/dev/null`
          );
          const pane = parsePaneInfo(paneOut);
          const workingDir = pane.workingDir;
          if (!workingDir) continue;

          const encodedPath = encodeProjectDir(workingDir);
          this.tmuxProjectPaths.add(encodedPath);
          this.tmuxSessionByPath.set(encodedPath, name);
          this.tmuxPathBySession.set(name, encodedPath);
          this.tmuxSessionWorkingDirs.set(name, workingDir);
          this.tmuxSessionIdentity.set(name, {
            created: pane.created,
            panePid: pane.panePid,
            encodedPath,
            claudePid: await findClaudePid(pane.panePid),
          });
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

      // Drop mappings whose session name was reused / claude restarted
      this.reconcileSessionIdentities();

      // Refresh direct session→conversation mappings (PID detection + elimination)
      await this.refreshConversationMappings();

      // Safety net: re-process any tracked conversation whose on-disk file has
      // advanced past our cached snapshot. Chokidar (even with polling) can drop
      // a 'change' event — observed with the assistant message carrying a pending
      // AskUserQuestion tool_use, which then never re-parses or broadcasts, leaving
      // the choice invisible in the app. This guarantees a conversation-update push
      // (and a refreshed cache) within one refresh interval.
      await this.reconcileTrackedConversations();

      // Persist session snapshots so they survive daemon restarts
      this.persistSessions();
    } catch {
      // tmux not running or no sessions
      this.tmuxProjectPaths.clear();
      this.tmuxSessionByPath.clear();
      this.tmuxPathBySession.clear();
      this.tmuxSessionWorkingDirs.clear();
      this.tmuxConversationIds.clear();
      this.tmuxConversationHistory.clear();
      this.tmuxSessionIdentity.clear();
      this.mappingIdentity.clear();
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
        stabilityThreshold: CHOKIDAR_STABILITY_THRESHOLD_MS,
        pollInterval: CHOKIDAR_POLL_INTERVAL_MS,
      },
      depth: 2,
      usePolling: true,
      interval: FILE_WATCHER_POLL_INTERVAL_MS,
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
    }, INITIAL_LOAD_COMPLETION_DELAY_MS);

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
    for (const timer of this.waitingDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.waitingDebounceTimers.clear();
    // Clear feedback poll timer
    this.stopFeedbackPolling();
  }

  /**
   * Start polling the tmux pane for a feedback prompt.
   * Called when a session transitions to "waiting for input" with no pending tool approvals.
   */
  private startFeedbackPolling(tmuxSessionName: string): void {
    // Don't poll if we don't have an injector
    if (!this.inputInjector) return;

    // Clear any existing timer
    this.stopFeedbackPolling();

    this.feedbackPollCount = 0;
    this.feedbackSessionId = tmuxSessionName;

    // Track the signature (header + question + option labels) of the last live choice
    // we broadcast for. A single AskUserQuestion tool_use can hold multiple question
    // groups that advance Q1 -> Q2 -> ... entirely on the tmux pane, with NO JSONL change
    // (the tool_use is only flushed once fully answered). We must therefore re-emit a
    // conversation-update whenever the on-pane question CONTENT changes — not just once —
    // or the chat freezes on Q1 while the terminal moves on. A null signature means we
    // have not broadcast for any choice yet this poll session.
    let lastChoiceSig: string | null = null;

    this.feedbackPollTimer = setInterval(async () => {
      this.feedbackPollCount++;

      // Give up after max attempts
      if (this.feedbackPollCount > SessionWatcher.FEEDBACK_POLL_MAX_ATTEMPTS) {
        this.stopFeedbackPolling();
        return;
      }

      try {
        const paneText = await this.inputInjector!.captureTmuxPane(tmuxSessionName);
        if (!paneText) return;

        const prompt = parseFeedbackPrompt(paneText);
        if (prompt) {
          this.feedbackPrompt = prompt;
          this.stopFeedbackPolling();

          // Emit feedback-prompt-detected event and a status-change so clients get it
          this.emit('feedback-prompt-detected', {
            sessionId: tmuxSessionName,
            feedbackPrompt: prompt,
          });
          this.emit('status-change', {
            sessionId: tmuxSessionName,
            isWaitingForInput: true,
            currentActivity: undefined,
            lastMessage: undefined,
            feedbackPrompt: prompt,
          });
        } else {
          // Live AskUserQuestion / choice selector: the AUQ tool_use is never written
          // to JSONL while pending, so no file change fires. When we spot the live box
          // on the pane, nudge clients to refetch so get_highlights can surface the
          // tappable options. The question itself is resolved on-demand in get_highlights.
          // Re-broadcast whenever the question CONTENT changes (e.g. a multi-question AUQ
          // advancing to the next question) so the chat keeps pace with the terminal,
          // but stay quiet while the same question lingers across polls.
          const choice = detectActiveChoicePrompt(paneText);
          if (choice) {
            const sig = [
              choice.header || '',
              choice.question || '',
              ...choice.options.map((o) => o.label),
            ].join(' ');
            if (sig !== lastChoiceSig) {
              lastChoiceSig = sig;
              console.log(
                `Watcher: Detected live choice prompt for "${tmuxSessionName}" (${choice.options.length} options, multiSelect: ${choice.multiSelect})`
              );
              this.emit('conversation-update', { sessionId: tmuxSessionName });
            }
          }
        }
      } catch {
        // Silent fail — polling is best-effort
      }
    }, SessionWatcher.FEEDBACK_POLL_INTERVAL_MS);
  }

  private stopFeedbackPolling(): void {
    if (this.feedbackPollTimer) {
      clearInterval(this.feedbackPollTimer);
      this.feedbackPollTimer = null;
    }
    this.feedbackPollCount = 0;
  }

  /**
   * Get the current feedback prompt (if any).
   */
  getFeedbackPrompt(sessionId?: string): FeedbackPrompt | null {
    if (sessionId && sessionId !== this.feedbackSessionId) return null;
    return this.feedbackPrompt;
  }

  /**
   * Clear the feedback prompt (after feedback is sent or session state changes).
   */
  clearFeedbackPrompt(): void {
    this.feedbackPrompt = null;
    this.feedbackSessionId = null;
    this.stopFeedbackPolling();
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
        if (ageMs > INITIAL_FILE_MAX_AGE_MS) {
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
        void this.processFileChangeAsync(filePath, convId).catch((err) =>
          console.error(`Watcher: processFileChangeAsync failed for ${convId}:`, err)
        );
      }, SessionWatcher.DEBOUNCE_MS)
    );
  }

  /**
   * Schedule a delayed confirmation of "waiting for input" for non-interactive tools.
   * If the file changes again before the timer fires, the timer is cancelled
   * (in processFileChange). This avoids false "waiting" status during tool execution.
   */
  private scheduleWaitingConfirmation(convId: string, filePath: string): void {
    this.waitingDebounceTimers.set(
      convId,
      setTimeout(() => {
        void (async () => {
          this.waitingDebounceTimers.delete(convId);
          const tracked = this.conversations.get(convId);
          if (!tracked) return;

          // Re-parse to confirm still waiting. Read off the event loop so a large
          // conversation file doesn't block pings/pongs.
          let content: string;
          try {
            content = await fs.promises.readFile(filePath, 'utf-8');
          } catch {
            return;
          }
          const messages = parseConversationFile(filePath, undefined, content);
          if (!detectWaitingForInput(messages)) return;

          // Confirmed: tool is genuinely waiting for input (not just running)
          tracked.isWaitingForInput = true;
          tracked.cachedMessages = messages;
          const currentIsRunning = messages.length > 0 && !tracked.isWaitingForInput;
          tracked.isRunning = currentIsRunning;

          if (this.activeConversationId === convId) {
            this.isWaitingForInput = true;
          }

          // Find tmux session name for this conversation
          let sessionId: string | undefined;
          for (const [name, mappedId] of this.tmuxConversationIds) {
            if (mappedId === convId) {
              sessionId = name;
              break;
            }
          }
          if (!sessionId) return;

          const lastMessage = messages[messages.length - 1];
          this.emit('status-change', {
            sessionId,
            isWaitingForInput: true,
            currentActivity: detectCurrentActivity(messages),
            lastMessage,
          });
        })();
      }, SessionWatcher.WAITING_DEBOUNCE_MS)
    );
  }

  /**
   * Process a JSONL file change. convId is the internal conversation UUID
   * (JSONL filename). External events use the tmux session name as sessionId.
   */
  private processFileChange(filePath: string, convId: string, opts: FileChangeOptions = {}): void {
    // Synchronous entry point (blocking I/O). Retained for one-time / on-demand
    // loads whose callers verify the result immediately afterwards. Recurring hot
    // paths should use processFileChangeAsync() so a large-file read never stalls
    // the event loop long enough to delay WebSocket pongs.
    let stats: fs.Stats;
    let content: string;
    try {
      stats = fs.statSync(filePath);
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      console.log(`Watcher: processFileChange read failed for ${convId}: ${err}`);
      return;
    }
    this.applyFileChange(filePath, convId, content, stats, opts);
  }

  /**
   * Non-blocking entry point: performs the JSONL stat + read via fs.promises so
   * the single-threaded event loop stays free to service pings/pongs while the
   * (possibly multi-MB) conversation file is read off disk. The parse itself is
   * still synchronous CPU work but is unchanged for correctness.
   */
  private async processFileChangeAsync(filePath: string, convId: string): Promise<void> {
    let stats: fs.Stats;
    let content: string;
    try {
      [stats, content] = await Promise.all([
        fs.promises.stat(filePath),
        fs.promises.readFile(filePath, 'utf-8'),
      ]);
    } catch (err) {
      console.log(`Watcher: processFileChangeAsync read failed for ${convId}: ${err}`);
      return;
    }
    this.applyFileChange(filePath, convId, content, stats);
  }

  private applyFileChange(
    filePath: string,
    convId: string,
    content: string,
    stats: fs.Stats,
    opts: FileChangeOptions = {}
  ): void {
    const quiet = opts.quiet === true;
    const projectPath = this.extractProjectPath(filePath);

    // Parse the conversation from content (already read by the caller)
    const t0 = Date.now();
    const messages = parseConversationFile(filePath, undefined, content);
    const t1 = Date.now();
    const highlights = extractHighlights(messages);
    const t2 = Date.now();
    if (t2 - t0 > SLOW_FILE_PROCESSING_THRESHOLD_MS) {
      console.log(
        `Watcher: processFileChange parse took ${t1 - t0}ms + highlights ${t2 - t1}ms = ${t2 - t0}ms (${messages.length} msgs) for ${convId}`
      );
    }
    const parserSaysWaiting = detectWaitingForInput(messages);

    // Cancel any pending waiting debounce for this conversation (file changed, re-evaluate)
    const existingWaitTimer = this.waitingDebounceTimers.get(convId);
    if (existingWaitTimer) {
      clearTimeout(existingWaitTimer);
      this.waitingDebounceTimers.delete(convId);
    }

    // For non-interactive pending tools (Bash, Edit, Write), delay the "waiting" state
    // by 3 seconds to avoid false positives from tools that are still running.
    // Interactive tools (AskUserQuestion, ExitPlanMode) get instant detection.
    const lastMsg = messages[messages.length - 1];
    const hasInteractivePending =
      lastMsg?.type === 'assistant' &&
      lastMsg.toolCalls?.some(
        (tc) => tc.status === 'pending' && ['AskUserQuestion', 'ExitPlanMode'].includes(tc.name)
      );

    // Get previous tracking state for compaction detection
    const prevTracked = this.conversations.get(convId);
    const prevWasWaiting = prevTracked?.isWaitingForInput || false;

    // Determine effective waiting state:
    // - Interactive tools (AskUserQuestion, ExitPlanMode): instant
    // - Already confirmed waiting: keep immediately
    // - Pending approval tools (Bash, Edit, Write): delay 3s to avoid false positives
    //   from auto-approved tools that are still executing
    // - Assistant finished (no pending tools): instant
    // - Transition to NOT waiting: instant (tool completed → clear immediately)
    let conversationWaiting: boolean;
    if (!parserSaysWaiting) {
      conversationWaiting = false;
    } else if (hasInteractivePending || prevWasWaiting) {
      // Interactive tool or already confirmed waiting → set immediately
      conversationWaiting = true;
    } else {
      // New transition to waiting — check if it's due to pending approval tools
      const hasPendingApprovalTools =
        lastMsg?.type === 'assistant' &&
        lastMsg.toolCalls?.some(
          (tc) => tc.status === 'pending' && APPROVAL_TOOLS.includes(tc.name) && tc.name !== 'Task'
        );
      if (hasPendingApprovalTools && quiet) {
        // Quiet (on-demand) load of an untouched file: nothing is still running,
        // and the delayed confirmation would emit a status-change.
        conversationWaiting = true;
      } else if (hasPendingApprovalTools) {
        // Delay: auto-approved tool might still be running
        conversationWaiting = false;
        this.scheduleWaitingConfirmation(convId, filePath);
      } else {
        // Assistant finished with text only, or all tools completed → genuine waiting
        conversationWaiting = true;
      }
    }
    const lastCompactionLine = prevTracked?.lastCompactionLine || 0;

    // Find which tmux session owns this conversation
    const encodedDir = this.getEncodedDirName(filePath);
    let tmuxName: string | undefined;

    // Check direct mapping first (reverse lookup — most accurate for shared dirs)
    for (const [name, mappedId] of this.tmuxConversationIds) {
      if (mappedId === convId) {
        tmuxName = name;
        break;
      }
    }

    // Fall back: determine from path-based mapping
    if (!tmuxName) {
      const sessionsForPath: string[] = [];
      for (const [name, ePath] of this.tmuxPathBySession) {
        if (ePath === encodedDir) sessionsForPath.push(name);
      }
      if (sessionsForPath.length === 1) {
        tmuxName = sessionsForPath[0];
        this.setConversationMapping(tmuxName, convId);
      } else if (sessionsForPath.length > 1) {
        // Multiple sessions share this path — try elimination
        const convAlreadyMapped = Array.from(this.tmuxConversationIds.values()).includes(convId);
        if (!convAlreadyMapped) {
          const unmapped = sessionsForPath.filter((name) => !this.tmuxConversationIds.has(name));
          if (unmapped.length === 1) {
            tmuxName = unmapped[0];
            this.setConversationMapping(tmuxName, convId);
          } else if (unmapped.length === 0) {
            // All sessions mapped — check if one recently compacted and expects a new JSONL
            const compactedInPath = sessionsForPath.filter((name) =>
              this.compactedSessions.has(name)
            );
            if (compactedInPath.length === 1) {
              const oldId = this.tmuxConversationIds.get(compactedInPath[0]);
              console.log(
                `Watcher: Re-mapping ${compactedInPath[0]}: ${oldId?.substring(0, 8)} -> ${convId.substring(0, 8)} (post-compaction)`
              );
              tmuxName = compactedInPath[0];
              this.setConversationMapping(tmuxName, convId, true);
              this.compactedSessions.delete(tmuxName);
            }
          }
        }
      }
    }

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

    if (compactionEvent && !quiet) {
      console.log(`Watcher: Detected compaction in session ${tmuxName || convId}`);
      this.emit('compaction', compactionEvent);
      // Mark this session as expecting a new JSONL (compaction creates a continuation file)
      // Only for live compaction events (prevTracked exists), not initial file loads
      if (tmuxName && prevTracked) {
        this.compactedSessions.add(tmuxName);
      }
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

    if (quiet) {
      // Cache-only load: record the pending-tool set as already seen so a later
      // real change does not replay a stale approval, and emit nothing (no
      // status-change -> escalation/push, no pending-approval -> auto-approve).
      const quietPending = getPendingApprovalTools(messages);
      tracked.lastEmittedPendingTools = quietPending.map((t) => t.id).sort().join(',');
      return;
    }

    // Only emit external events if we identified the owning tmux session
    if (!tmuxName) return;

    // Skip if a different conversation is mapped to this session
    const mappedForSession = this.tmuxConversationIds.get(tmuxName);
    if (mappedForSession && mappedForSession !== convId) return;

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
        content: lastMsg?.content?.substring(0, SESSION_COMPLETION_MESSAGE_LENGTH) || 'Session completed',
      });
    }

    // Auto-select: during initial load pick the most recent; after that only if no active session
    const isInitialLoad = Date.now() - this.startTime < INITIAL_LOAD_WINDOW_MS;
    if (
      isInitialLoad ||
      !this.activeTmuxSession ||
      !this.tmuxPathBySession.has(this.activeTmuxSession)
    ) {
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

    // Emit events for ALL sessions using per-conversation state for dedup
    const prevMessageCount = prevTracked?.messageCount || 0;
    const hasNewMessages = messages.length !== prevMessageCount;
    const waitingStatusChanged = conversationWaiting !== prevWasWaiting;

    if (hasNewMessages) {
      // Update global lastMessageCount if this is the active session (for compat)
      if (tmuxName === this.activeTmuxSession) {
        this.lastMessageCount = messages.length;
      }
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

    // Feedback prompt polling: start when transitioning to waiting with no pending tool approvals
    const hasPendingToolCalls = lastMessage?.type === 'assistant' &&
      lastMessage.toolCalls?.some((tc) => tc.status === 'pending');
    if (waitingStatusChanged && conversationWaiting && !hasPendingToolCalls) {
      this.startFeedbackPolling(sessionId);
    } else if (waitingStatusChanged && !conversationWaiting) {
      // Session stopped waiting — clear feedback prompt
      if (this.feedbackSessionId === sessionId) {
        this.clearFeedbackPrompt();
      }
    }

    if (waitingStatusChanged || hasNewMessages) {
      this.emit('status-change', {
        sessionId,
        isWaitingForInput: conversationWaiting,
        currentActivity,
        lastMessage,
        feedbackPrompt: this.feedbackSessionId === sessionId ? this.feedbackPrompt : undefined,
      });
    }

    // Emit activity notification for non-active sessions (sidebar badges)
    if (tmuxName !== this.activeTmuxSession && (hasNewMessages || waitingStatusChanged)) {
      this.emit('other-session-activity', {
        sessionId,
        projectPath,
        sessionName,
        isWaitingForInput: conversationWaiting,
        lastMessage,
        newMessageCount: hasNewMessages ? messages.length - prevMessageCount : 0,
      });
    }

    // Check for pending tools - only emit when the set of pending tool IDs CHANGES.
    // Using tool IDs (not just names) so that consecutive same-named tools
    // (e.g., Bash A completes, Bash B pending) are correctly detected as new.
    const pendingTools = getPendingApprovalTools(messages);
    const pendingKey =
      pendingTools.length > 0
        ? pendingTools
            .map((t) => t.id)
            .sort()
            .join(',')
        : '';
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

  private extractProjectPath(filePath: string): string {
    // Extract project path from conversation file path
    // e.g., ~/.claude/projects/-Users-foo-bar/abc123.jsonl -> /Users/foo/bar
    const projectsDir = path.join(this.codeHome, 'projects');
    const relative = path.relative(projectsDir, filePath);
    const parts = relative.split(path.sep);

    if (parts.length >= 1) {
      const encoded = parts[0];
      // Exact: a live session's working directory that encodes to this name
      for (const dir of this.tmuxSessionWorkingDirs.values()) {
        if (encodeProjectDir(dir) === encoded) return dir;
      }
      // Smart decode: try to find which interpretation of dashes is correct
      // by checking if the path exists on the filesystem (memoized: this runs
      // on every file change)
      const hit = this.decodedPathCache.get(encoded);
      if (hit !== undefined) return hit;
      const decoded = this.smartDecodePath(encoded);
      if (this.decodedPathCache.size >= 256) this.decodedPathCache.clear();
      this.decodedPathCache.set(encoded, decoded);
      return decoded;
    }

    return '';
  }

  private smartDecodePath(encoded: string): string {
    // Claude Code turns every non-alphanumeric character into '-', so '/', '.',
    // '_' and '-' are all ambiguous. Walk the parts, joining with '/' unless a
    // run joined with '-', '.' or '_' names an existing directory. An empty part
    // ("--") is a segment that started with a non-alphanumeric, usually '.'
    // (~/.cache -> "-home-u--cache").
    const withoutLeading = encoded.replace(/^-/, '');
    const raw = withoutLeading.split('-');
    const parts: string[] = [];
    for (let k = 0; k < raw.length; k++) {
      if (raw[k] === '' && k + 1 < raw.length) {
        parts.push('.' + raw[k + 1]);
        k++;
      } else {
        parts.push(raw[k]);
      }
    }
    const isDir = (p: string): boolean => {
      try {
        return fs.existsSync(p) && fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    };

    let currentPath = '';
    let i = 0;

    while (i < parts.length) {
      const part = parts[i];
      const testWithSlash = currentPath ? `${currentPath}/${part}` : `/${part}`;

      // Look ahead: does joining the next parts with '-', '.' or '_' (onto the
      // current segment) name an existing directory?
      let foundJoined = false;
      if (currentPath) {
        for (let j = parts.length - 1; j >= i && !foundJoined; j--) {
          for (const sep of ['-', '.', '_']) {
            const joined = currentPath + sep + parts.slice(i, j + 1).join(sep);
            if (isDir(joined)) {
              currentPath = joined;
              i = j + 1;
              foundJoined = true;
              break;
            }
          }
        }
      }

      if (!foundJoined) {
        currentPath = testWithSlash;
        i++;
      }
    }

    // If the smart decode didn't find a valid path, fall back to simple decode
    if (!fs.existsSync(currentPath)) {
      return '/' + parts.join('/');
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
  private getBestConversationForPath(
    encodedPath: string
  ): { id: string; conv: TrackedConversation } | null {
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
   * Mark a session as newly created (no JSONL yet).
   * Prevents path-based fallback from returning a stale conversation.
   */
  markSessionAsNew(sessionName: string): void {
    // A reused name must not keep the previous session's transcript.
    if (this.dropConversationMapping(sessionName)) this.persistMappings();
    if (this.activeTmuxSession === sessionName) this.activeConversationId = null;
    this.newlyCreatedSessions.set(sessionName, Date.now());
  }

  /**
   * Drop all watcher state for a session: persisted snapshot, in-memory
   * conversations matching the session, tmux mapping, and history. Used by
   * the `remove_session` handler so a removed session does not get
   * re-discovered. The caller is responsible for archiving the JSONL.
   *
   * Returns flags describing what was removed.
   */
  forgetSession(sessionId: string): {
    persistedRemoved: boolean;
    conversationsRemoved: number;
    mappingRemoved: boolean;
  } {
    let persistedRemoved = false;
    let mappingRemoved = false;
    let conversationsRemoved = 0;

    // Drop persisted snapshot
    if (this.persistedSessions.delete(sessionId)) {
      persistedRemoved = true;
    }

    // Collect conversation UUIDs associated with this tmux session, both via
    // direct mapping and via history (post-compaction chains).
    const convIds = new Set<string>();
    const direct = this.tmuxConversationIds.get(sessionId);
    if (direct) convIds.add(direct);
    const history = this.tmuxConversationHistory.get(sessionId);
    if (history) {
      for (const id of history) convIds.add(id);
    }

    // Also accept the session id itself if it happens to be a JSONL UUID
    // (some persisted entries use the conversation UUID as the id).
    if (this.conversations.has(sessionId)) {
      convIds.add(sessionId);
    }

    for (const id of convIds) {
      const existed = this.conversations.delete(id);
      if (existed) conversationsRemoved++;
      const timer = this.debounceTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        this.debounceTimers.delete(id);
      }
      const wTimer = this.waitingDebounceTimers.get(id);
      if (wTimer) {
        clearTimeout(wTimer);
        this.waitingDebounceTimers.delete(id);
      }
    }

    if (this.tmuxConversationIds.delete(sessionId)) mappingRemoved = true;
    if (this.tmuxConversationHistory.delete(sessionId)) mappingRemoved = true;
    this.mappingIdentity.delete(sessionId);
    this.newlyCreatedSessions.delete(sessionId);
    this.compactedSessions.delete(sessionId);

    if (this.activeTmuxSession === sessionId) {
      this.activeTmuxSession = null;
      this.activeConversationId = null;
    }
    if (this.feedbackSessionId === sessionId) {
      this.feedbackPrompt = null;
      this.feedbackSessionId = null;
    }

    // Persist updated state to disk so the snapshot/mappings on disk match.
    this.persistMappings();
    this.persistSessions();

    return { persistedRemoved, conversationsRemoved, mappingRemoved };
  }

  /**
   * Resolve tmux session name to the conversation it's running.
   * Uses direct PID-based mapping first, falls back to path-based best-match.
   */
  private resolveConversationForSession(
    sessionName: string
  ): { id: string; conv: TrackedConversation } | null {
    // Direct mapping (most accurate, especially for shared project dirs)
    const directId = this.tmuxConversationIds.get(sessionName);
    if (directId) {
      const conv = this.conversations.get(directId);
      if (conv) {
        // Direct mapping found — session is no longer "new"
        this.newlyCreatedSessions.delete(sessionName);
        return { id: directId, conv };
      }
    }
    // If session was just created and has no direct mapping yet, don't fall back
    // to path-based matching (would return a stale conversation from same dir)
    if (this.newlyCreatedSessions.has(sessionName)) {
      return null;
    }
    // Fall back to path-based best-match
    const encodedPath = this.tmuxPathBySession.get(sessionName);
    if (!encodedPath) return null;
    return this.getBestConversationForPath(encodedPath);
  }

  /**
   * Detect which JSONL file a tmux session's process tree has open.
   * Uses /proc/<pid>/fd/ to find open file descriptors pointing to JSONL files.
   */
  private async detectConversationForSession(sessionName: string): Promise<string | null> {
    // Guard against concurrent probes for the same session — if pstree/tmux
    // hangs on a wedged PID, stacked invocations fan out unboundedly.
    if (this.detectInFlight.has(sessionName)) return null;
    this.detectInFlight.add(sessionName);
    try {
      return await this.detectConversationForSessionInner(sessionName);
    } finally {
      this.detectInFlight.delete(sessionName);
    }
  }

  private async detectConversationForSessionInner(sessionName: string): Promise<string | null> {
    const projectsDir = path.join(this.codeHome, 'projects');
    try {
      const { stdout: pidOut } = await execAsync(
        `tmux display-message -t "${sessionName}" -p "#{pane_pid}" 2>/dev/null`,
        { timeout: 2000, killSignal: 'SIGKILL' }
      );
      const rootPid = pidOut.trim();
      if (!rootPid) return null;

      // If the pane's root PID is gone, skip — nothing to trace.
      try {
        process.kill(Number(rootPid), 0);
      } catch {
        return null;
      }

      // Get all descendant PIDs using pstree (single command, bounded).
      // Without a timeout + SIGKILL, a wedged pstree keeps the shell child alive
      // and stacks up across the 5s refresh interval.
      const pids: string[] = [rootPid];
      try {
        const { stdout: tree } = await execAsync(`pstree -p ${rootPid} 2>/dev/null`, {
          timeout: 2000,
          killSignal: 'SIGKILL',
        });
        for (const match of tree.matchAll(/\((\d+)\)/g)) {
          if (match[1] !== rootPid) pids.push(match[1]);
        }
      } catch {
        /* pstree not available or hung — fall back to root PID only */
      }

      // Check /proc/<pid>/fd/ for open JSONL files in the projects directory
      for (const pid of pids) {
        try {
          const fdDir = `/proc/${pid}/fd`;
          const fds = fs.readdirSync(fdDir);
          for (const fd of fds) {
            try {
              const target = fs.readlinkSync(path.join(fdDir, fd));
              if (
                target.startsWith(projectsDir) &&
                target.endsWith('.jsonl') &&
                !target.includes('/subagents/')
              ) {
                return path.basename(target, '.jsonl');
              }
            } catch {
              /* can't read this fd */
            }
          }
        } catch {
          /* can't read /proc/<pid>/fd */
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Refresh direct tmux session → conversation mappings.
   * Strategy: PID detection → terminal content matching → elimination.
   * Also ensures conversations are loaded for all tagged session paths.
   */
  private async refreshConversationMappings(): Promise<void> {
    // Remove stale entries (sessions that no longer exist or conversations pruned)
    for (const name of this.tmuxConversationIds.keys()) {
      if (!this.tmuxPathBySession.has(name)) {
        this.tmuxConversationIds.delete(name);
        this.tmuxConversationHistory.delete(name);
        this.mappingIdentity.delete(name);
      }
    }
    for (const [name, convId] of this.tmuxConversationIds) {
      if (!this.conversations.has(convId)) {
        // Conversation not loaded yet — check if file exists on disk before pruning
        const ePath = this.tmuxPathBySession.get(name);
        if (ePath) {
          const convFile = path.join(this.codeHome, 'projects', ePath, `${convId}.jsonl`);
          if (fs.existsSync(convFile)) continue; // File exists, keep mapping
        }
        this.tmuxConversationIds.delete(name);
      }
    }

    // Clear newlyCreated flag for sessions whose own JSONL has appeared
    // (conversation file created AFTER the session was created)
    for (const [sessionName, createdAt] of this.newlyCreatedSessions) {
      const ePath = this.tmuxPathBySession.get(sessionName);
      if (!ePath) continue;
      // Find a conversation for this path that was modified after session creation
      for (const [id, conv] of this.conversations) {
        if (this.getEncodedDirName(conv.path) === ePath && conv.lastModified > createdAt) {
          // This conversation appeared after the session was created — it's likely ours
          // Only claim it if no other session already has it
          const alreadyMapped = Array.from(this.tmuxConversationIds.values()).includes(id);
          if (!alreadyMapped) {
            console.log(
              `Watcher: New session ${sessionName} -> ${id.substring(0, 8)} (appeared after creation)`
            );
            this.setConversationMapping(sessionName, id);
            this.newlyCreatedSessions.delete(sessionName);
            break;
          }
        }
      }
      // Expire the guard after 2 minutes regardless (fallback)
      if (Date.now() - createdAt > 120_000) {
        console.log(`Watcher: Expiring newlyCreated guard for ${sessionName}`);
        this.newlyCreatedSessions.delete(sessionName);
      }
    }

    // Group sessions by path to find shared-path cases
    const pathSessions = new Map<string, string[]>();
    for (const [name, ePath] of this.tmuxPathBySession) {
      const list = pathSessions.get(ePath) || [];
      list.push(name);
      pathSessions.set(ePath, list);
    }

    // Ensure enough conversations are loaded for shared paths.
    // The watcher's 2-minute age filter may skip older-but-active session files.
    for (const [ePath, sessions] of pathSessions) {
      if (sessions.length < 2) continue;

      // Count how many conversations we have for this path
      let convCount = 0;
      for (const [, conv] of this.conversations) {
        if (this.getEncodedDirName(conv.path) === ePath) convCount++;
      }

      if (convCount >= sessions.length) continue;

      console.log(
        `Watcher: Path ${ePath} has ${sessions.length} sessions but only ${convCount} conversations — scanning`
      );

      // Need more conversations — scan the directory and force-load recent files
      const projectDir = path.join(this.codeHome, 'projects', ePath);
      try {
        const files = fs
          .readdirSync(projectDir)
          .filter((f) => f.endsWith('.jsonl') && !f.includes('subagent'))
          .map((f) => ({
            name: f,
            path: path.join(projectDir, f),
            mtime: fs.statSync(path.join(projectDir, f)).mtimeMs,
          }))
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, sessions.length * 3); // Load extra to cover multiple conversations per session

        for (const file of files) {
          const convId = path.basename(file.name, '.jsonl');
          if (!this.conversations.has(convId)) {
            this.processFileChange(file.path, convId);
          }
        }
      } catch (err) {
        console.log(`Watcher: Failed to scan project dir ${projectDir}: ${err}`);
      }
    }

    // Strategy 1: PID-based detection via /proc/fd (works if Claude keeps files open)
    for (const [sessionName, ePath] of this.tmuxPathBySession) {
      if (this.tmuxConversationIds.has(sessionName)) continue;
      if (this.newlyCreatedSessions.has(sessionName)) continue; // Don't map until JSONL exists
      const convId = await this.detectConversationForSession(sessionName);
      if (convId) {
        if (!this.conversations.has(convId)) {
          // Conversation not yet tracked — load it on demand
          const convFile = path.join(this.codeHome, 'projects', ePath, `${convId}.jsonl`);
          if (fs.existsSync(convFile)) {
            console.log(
              `Watcher: PID detection found unloaded conversation ${convId.substring(0, 8)} for ${sessionName} — loading`
            );
            this.processFileChange(convFile, convId);
          }
        }
        if (this.conversations.has(convId)) {
          this.setConversationMapping(sessionName, convId);
        }
      }
    }

    // Strategy 2: Terminal content matching — capture scrollback and match to JSONL content
    for (const [ePath, sessions] of pathSessions) {
      if (sessions.length < 2) continue;
      const unmapped = sessions.filter((name) => !this.tmuxConversationIds.has(name));
      if (unmapped.length === 0) continue;

      // Get unmapped conversations for this path
      const mappedConvIds = new Set(
        sessions
          .filter((name) => this.tmuxConversationIds.has(name))
          .map((name) => this.tmuxConversationIds.get(name)!)
      );
      const candidateConvs: Array<{ id: string; conv: TrackedConversation }> = [];
      for (const [id, conv] of this.conversations) {
        if (this.getEncodedDirName(conv.path) === ePath && !mappedConvIds.has(id)) {
          candidateConvs.push({ id, conv });
        }
      }

      if (candidateConvs.length === 0) continue;

      for (const sessionName of unmapped) {
        if (this.tmuxConversationIds.has(sessionName)) continue; // Mapped by earlier iteration
        if (this.newlyCreatedSessions.has(sessionName)) continue; // Skip newly created sessions
        try {
          // Capture scrollback history (up to 500 lines) to find user prompts
          const { stdout: paneText } = await execAsync(
            `tmux capture-pane -t "${sessionName}" -p -S -500 2>/dev/null`
          );

          // Extract user prompts from terminal output (lines after ❯ prompt)
          const userLines = paneText
            .split('\n')
            .filter((line) => {
              const trimmed = line.trimStart();
              return trimmed.startsWith('\u276f') || trimmed.startsWith('❯');
            })
            .map((line) => {
              const trimmed = line.trimStart();
              return trimmed.replace(/^[❯\u276f]\s*/, '').trim();
            })
            .filter((line) => line.length > MIN_USER_PROMPT_LENGTH);

          if (userLines.length === 0) continue;

          // Try to match user prompts (most recent first) uniquely to one candidate
          for (let i = userLines.length - 1; i >= 0; i--) {
            const userLine = userLines[i];
            const matchingCandidates = candidateConvs.filter((candidate) => {
              try {
                const stats = fs.statSync(candidate.conv.path);
                const readSize = Math.min(CONVERSATION_READ_BUFFER_SIZE, stats.size);
                const buffer = Buffer.alloc(readSize);
                const fd = fs.openSync(candidate.conv.path, 'r');
                fs.readSync(fd, buffer, 0, readSize, Math.max(0, stats.size - readSize));
                fs.closeSync(fd);
                return buffer.toString('utf-8').includes(userLine);
              } catch {
                return false;
              }
            });

            // Only use this match if it uniquely identifies one file
            if (matchingCandidates.length === 1) {
              console.log(
                `Watcher: Terminal matched ${sessionName} -> ${matchingCandidates[0].id.substring(0, CONVERSATION_ID_LOG_LENGTH)} via "${userLine.substring(0, USER_LINE_LOG_LENGTH)}"`
              );
              this.setConversationMapping(sessionName, matchingCandidates[0].id);
              mappedConvIds.add(matchingCandidates[0].id);
              const idx = candidateConvs.findIndex((c) => c.id === matchingCandidates[0].id);
              if (idx >= 0) candidateConvs.splice(idx, 1);
              break;
            }
          }
        } catch {
          /* tmux capture failed */
        }
      }
    }

    // Strategy 3: Process of elimination
    for (const [ePath, sessions] of pathSessions) {
      if (sessions.length < 2) continue;
      const unmapped = sessions.filter(
        (name) => !this.tmuxConversationIds.has(name) && !this.newlyCreatedSessions.has(name)
      );
      if (unmapped.length !== 1) continue;

      const mappedConvIds = new Set(
        sessions
          .filter((name) => this.tmuxConversationIds.has(name))
          .map((name) => this.tmuxConversationIds.get(name)!)
      );
      const unmappedConvs: string[] = [];
      for (const [id, conv] of this.conversations) {
        if (this.getEncodedDirName(conv.path) === ePath && !mappedConvIds.has(id)) {
          unmappedConvs.push(id);
        }
      }

      if (unmappedConvs.length === 1) {
        this.setConversationMapping(unmapped[0], unmappedConvs[0]);
      }
    }

    if (this.tmuxConversationIds.size > 0) {
      const entries = Array.from(this.tmuxConversationIds.entries())
        .map(([name, id]) => `${name}->${id.substring(0, 8)}`)
        .join(', ');
      const key = entries;
      if (key !== this._lastMappingLog) {
        this._lastMappingLog = key;
        console.log(`Watcher: Session mappings: ${entries}`);
        this.persistMappings();
      }
    }
  }

  /**
   * Resolve a session ID (tmux session name) to the internal conversation UUID.
   * If no sessionId provided, returns the active conversation ID.
   */
  private resolveToConversationId(sessionId?: string): string | null {
    if (!sessionId) return this.activeConversationId;
    const resolved = this.resolveConversationForSession(sessionId);
    return resolved?.id || null;
  }

  /**
   * Get all conversation UUIDs associated with a tmux session name.
   * Includes the current mapping plus the full compaction history.
   */
  getConversationIdsForSession(tmuxSessionName: string): string[] {
    const ids: string[] = [];
    const history = this.tmuxConversationHistory.get(tmuxSessionName);
    if (history) ids.push(...history);
    const current = this.tmuxConversationIds.get(tmuxSessionName);
    if (current && !ids.includes(current)) ids.push(current);
    return ids;
  }

  /**
   * Reverse lookup: given a conversation UUID, find the tmux session name running it.
   */
  getTmuxSessionForConversation(conversationId: string): string | null {
    // Check direct mappings first
    for (const [tmuxName, convId] of this.tmuxConversationIds) {
      if (convId === conversationId) return tmuxName;
    }
    // Fall back: check if only one tmux session maps to this conversation's path
    const tracked = this.conversations.get(conversationId);
    if (!tracked) return null;
    const encodedDir = this.getEncodedDirName(tracked.path);
    const candidates: string[] = [];
    for (const [tmuxName, ePath] of this.tmuxPathBySession) {
      if (ePath === encodedDir) candidates.push(tmuxName);
    }
    return candidates.length === 1 ? candidates[0] : null;
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

  /**
   * Ensure a conversation is loaded for the given session ID.
   * If the session's conversation isn't tracked yet (e.g., skipped by the
   * initial age filter), this searches on disk and force-loads the most
   * recent JSONL file. Returns true if a conversation is available afterward.
   */
  ensureConversationLoaded(sessionId: string, opts: FileChangeOptions = {}): boolean {
    // Already tracked?
    if (this.resolveConversationForSession(sessionId)) {
      return true;
    }

    // Need the encoded project path to find files on disk
    let encodedPath = this.tmuxPathBySession.get(sessionId);

    // For persisted inactive sessions, derive encoded path from conversationPath
    if (!encodedPath) {
      const snap = this.persistedSessions.get(sessionId);
      if (snap?.conversationPath) {
        const projectsDir = path.join(this.codeHome, 'projects');
        const rel = path.relative(projectsDir, snap.conversationPath);
        encodedPath = rel.split(path.sep)[0];
      }
    }
    if (!encodedPath) return false;

    const projectDir = path.join(this.codeHome, 'projects', encodedPath);
    if (!fs.existsSync(projectDir)) return false;

    try {
      const entries = fs.readdirSync(projectDir);
      const jsonlFiles = entries
        .filter((f) => f.endsWith('.jsonl') && !f.includes('subagents'))
        .map((f) => {
          const fullPath = path.join(projectDir, f);
          try {
            const stats = fs.statSync(fullPath);
            return { path: fullPath, mtime: stats.mtimeMs };
          } catch {
            return null;
          }
        })
        .filter((f): f is { path: string; mtime: number } => f !== null)
        .sort((a, b) => b.mtime - a.mtime);

      if (jsonlFiles.length === 0) return false;

      // Load the most recent file
      const best = jsonlFiles[0];
      const convId = path.basename(best.path, '.jsonl');
      console.log(`Watcher: On-demand loading conversation ${convId} for session ${sessionId}`);
      this.processFileChange(best.path, convId, opts);

      // Verify it loaded
      return this.resolveConversationForSession(sessionId) !== null;
    } catch {
      return false;
    }
  }

  getConversationInfo(sessionId: string): ConversationFile | null {
    const resolved = this.resolveConversationForSession(sessionId);
    if (resolved) {
      return {
        path: resolved.conv.path,
        projectPath: resolved.conv.projectPath,
        lastModified: resolved.conv.lastModified,
      };
    }
    // Fall back to persisted session snapshot
    const snap = this.persistedSessions.get(sessionId);
    if (snap?.conversationPath && fs.existsSync(snap.conversationPath)) {
      return {
        path: snap.conversationPath,
        projectPath: snap.projectPath,
        lastModified: snap.lastActivity,
      };
    }
    return null;
  }

  /**
   * Re-process any tracked conversation whose on-disk file is newer than our
   * cached snapshot. This is a safety net for missed/dropped file-watch events:
   * processFileChange re-parses, refreshes the cache, and emits conversation-update
   * (so clients with the session open update live). Called from the periodic tmux
   * refresh. Iterates a snapshot so processFileChange's writes don't disturb it.
   */
  private async reconcileTrackedConversations(): Promise<void> {
    for (const [convId, tracked] of [...this.conversations]) {
      try {
        const st = await fs.promises.stat(tracked.path);
        if (st.mtimeMs > tracked.lastModified) {
          await this.processFileChangeAsync(tracked.path, convId);
        }
      } catch {
        // File missing/unreadable — leave for normal watcher handling.
      }
    }
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

  /**
   * Like getMessages, but ALWAYS re-reads the conversation file from disk
   * instead of trusting the cached snapshot. Used by the get_highlights latest
   * page so a pending AskUserQuestion (whose tool_use lands in the JSONL before
   * any file-watch event the watcher may have missed) is never hidden behind a
   * frozen cache. Intentionally does NOT mutate tracked.lastModified so the
   * periodic reconcile pass still detects the change and emits conversation-update.
   */
  getFreshMessages(sessionId?: string): ConversationMessage[] {
    const targetId = this.resolveToConversationId(sessionId);
    if (!targetId) return [];

    const tracked = this.conversations.get(targetId);
    if (!tracked) return this.getMessages(sessionId);

    try {
      const messages = parseConversationFile(tracked.path);
      // Refresh the cached message snapshot (but not lastModified) so other
      // cache readers (getStatus, etc.) stay consistent with what we just served.
      tracked.cachedMessages = messages;
      // A pending AskUserQuestion / ExitPlanMode can land on disk after a dropped
      // file-watch event, leaving tracked.isWaitingForInput frozen on a stale
      // "not waiting" value. get_status (polled alongside get_highlights) and the
      // get_highlights "suppress options when not waiting" guard both read this
      // flag, so a stale false can hide the live choice. Promote the flag here when
      // the fresh parse shows a pending INTERACTIVE tool — mirroring processFileChange's
      // instant-interactive rule. Never downgrade here: processFileChange owns clearing
      // and the 3s debounce for non-interactive approval tools (Bash/Edit/Write).
      const lastMsg = messages[messages.length - 1];
      const hasInteractivePending =
        lastMsg?.type === 'assistant' &&
        (lastMsg.toolCalls?.some(
          (tc) =>
            tc.status === 'pending' &&
            (tc.name === 'AskUserQuestion' || tc.name === 'ExitPlanMode')
        ) ??
          false);
      if (hasInteractivePending) {
        tracked.isWaitingForInput = true;
      }
      return messages;
    } catch {
      return tracked.cachedMessages || [];
    }
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

    // Determine if this session has a feedback prompt
    // sessionId here is a tmux session name; feedbackSessionId is also a tmux session name
    const feedbackPrompt = sessionId && this.feedbackSessionId === sessionId
      ? this.feedbackPrompt
      : undefined;

    return {
      isRunning: true,
      isWaitingForInput: tracked.isWaitingForInput,
      lastActivity: lastMessage?.timestamp || 0,
      conversationId: tracked.path,
      projectPath: tracked.projectPath,
      currentActivity: detectCurrentActivity(messages),
      recentActivity: getRecentActivity(messages, RECENT_ACTIVITY_LIMIT),
      feedbackPrompt: feedbackPrompt || undefined,
    };
  }

  /**
   * Return one entry per tagged tmux session (instead of one per JSONL file).
   * Session ID = tmux session name.
   * When liveOnly is true, skip persisted inactive sessions (used for snapshotting).
   */
  private getSessionsInternal(liveOnly: boolean): TmuxSession[] {
    const sessions: TmuxSession[] = [];
    const seenIds = new Set<string>();

    // Live tmux sessions first
    for (const [tmuxName] of this.tmuxPathBySession) {
      const best = this.resolveConversationForSession(tmuxName);
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
      seenIds.add(tmuxName);
    }

    // Add persisted sessions that are no longer live in tmux
    if (!liveOnly) {
      for (const [id, snap] of this.persistedSessions) {
        if (seenIds.has(id)) continue;
        // Verify the conversation file still exists
        if (snap.conversationPath && !fs.existsSync(snap.conversationPath)) {
          this.persistedSessions.delete(id);
          continue;
        }
        sessions.push({
          id: snap.id,
          name: snap.name,
          projectPath: snap.projectPath,
          conversationPath: snap.conversationPath,
          lastActivity: snap.lastActivity,
          isWaitingForInput: false, // Not live, can't be waiting
          messageCount: snap.messageCount,
          inactive: true,
        });
        seenIds.add(id);
      }
    }

    // Sort by last activity (most recent first)
    sessions.sort((a, b) => b.lastActivity - a.lastActivity);

    return sessions;
  }

  getSessions(): TmuxSession[] {
    return this.getSessionsInternal(false);
  }

  /**
   * Wait up to `timeoutMs` for a JSONL conversation to be resolved for the given cwd.
   * Returns the JSONL UUID (conversation id) or null if none appeared in time.
   * Used by remote_dispatch_spawn to surface the session id of a freshly spawned Claude.
   */
  waitForSessionInCwd(cwd: string, timeoutMs: number): Promise<string | null> {
    const normalizedCwd = cwd.replace(/\/+$/, '');

    const findExisting = (): string | null => {
      let best: { id: string; lastModified: number } | null = null;
      for (const [id, conv] of this.conversations) {
        if (conv.projectPath === normalizedCwd) {
          if (!best || conv.lastModified > best.lastModified) {
            best = { id, lastModified: conv.lastModified };
          }
        }
      }
      return best?.id || null;
    };

    const existing = findExisting();
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve) => {
      let resolved = false;
      const finish = (id: string | null) => {
        if (resolved) return;
        resolved = true;
        this.off('conversation-update', onUpdate);
        clearTimeout(timer);
        resolve(id);
      };
      const onUpdate = () => {
        const id = findExisting();
        if (id) finish(id);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.on('conversation-update', onUpdate);
    });
  }

  /**
   * Resolve the newest conversation id for a given tmux session name. Tries the
   * tmux-name → conversation mapping first (same path setActiveSession uses), then
   * falls back to the cwd → newest-conversation scan used by waitForSessionInCwd.
   * Returns null if nothing matches.
   */
  resolveSessionByTmuxName(tmuxSessionName: string, cwd: string): string | null {
    // 1. Direct tmux-name → conversation mapping (most accurate).
    const direct = this.resolveConversationForSession(tmuxSessionName);
    if (direct) return direct.id;

    // 2. Fall back to newest conversation whose projectPath matches cwd.
    const normalizedCwd = cwd.replace(/\/+$/, '');
    let best: { id: string; lastModified: number } | null = null;
    for (const [id, conv] of this.conversations) {
      if (conv.projectPath === normalizedCwd) {
        if (!best || conv.lastModified > best.lastModified) {
          best = { id, lastModified: conv.lastModified };
        }
      }
    }
    return best?.id || null;
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
    if (!this.tmuxPathBySession.has(sessionId)) return false;

    const best = this.resolveConversationForSession(sessionId);
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
      feedbackPrompt: this.feedbackSessionId === sessionId ? this.feedbackPrompt : undefined,
    });

    return true;
  }

  clearActiveSession(): void {
    this.activeTmuxSession = null;
    this.activeConversationId = null;
    this.isWaitingForInput = false;
    this.lastMessageCount = 0;

    // Emit a distinct event so clients know the active session cleared.
    // Do NOT emit conversation-update or status-change with null sessionId —
    // those are session-scoped and would be dropped by broadcast filtering.
    this.emit('active-session-cleared', {});
  }

  isWaiting(): boolean {
    return this.isWaitingForInput;
  }

  /**
   * Get the conversation file(s) for a session.
   * sessionId is a tmux session name — resolves to the best conversation.
   */
  getConversationChain(sessionId: string): string[] {
    const history = this.tmuxConversationHistory.get(sessionId);
    if (!history || history.length === 0) {
      // No history — fall back to single current file
      const convId = this.resolveToConversationId(sessionId);
      if (!convId) return [];
      const tracked = this.conversations.get(convId);
      if (!tracked) return [];
      return [tracked.path];
    }

    // Resolve each history ID to a file path (oldest first)
    let encodedPath = this.tmuxPathBySession.get(sessionId);
    if (!encodedPath) {
      // Derive from persisted session snapshot
      const snap = this.persistedSessions.get(sessionId);
      if (snap?.conversationPath) {
        const projectsDir = path.join(this.codeHome, 'projects');
        const rel = path.relative(projectsDir, snap.conversationPath);
        encodedPath = rel.split(path.sep)[0];
      }
    }
    const projectDir = encodedPath ? path.join(this.codeHome, 'projects', encodedPath) : null;

    const chain: string[] = [];
    const MAX_CHAIN = 20;

    for (const id of history) {
      if (chain.length >= MAX_CHAIN) break;

      // Check in-memory tracked conversations first
      const tracked = this.conversations.get(id);
      if (tracked) {
        chain.push(tracked.path);
        continue;
      }

      // Fall back to disk lookup
      if (projectDir) {
        const filePath = path.join(projectDir, `${id}.jsonl`);
        if (fs.existsSync(filePath)) {
          chain.push(filePath);
        }
      }
    }

    return chain;
  }

  /**
   * Check a session for pending approval tools and emit if found.
   * Called externally when auto-approve is toggled on to retroactively approve.
   * If sessionId is provided, checks that specific session; otherwise checks the active session.
   */
  checkAndEmitPendingApproval(sessionId?: string): void {
    const targetTmux = sessionId || this.activeTmuxSession;
    if (!targetTmux) return;

    const resolved = this.resolveConversationForSession(targetTmux);
    if (!resolved) return;

    const messages = resolved.conv.cachedMessages || parseConversationFile(resolved.conv.path);
    const pendingTools = getPendingApprovalTools(messages);
    if (pendingTools.length > 0) {
      this.emit('pending-approval', {
        sessionId: targetTmux,
        projectPath: resolved.conv.projectPath,
        tools: pendingTools,
      });
    }
  }

  /**
   * Get server summary — one entry per tagged tmux session.
   * Uses tmuxSessions from TmuxManager for authoritative tagged status,
   * finds the best conversation for each to determine activity/status.
   */
  async getServerSummary(
    tmuxSessions?: Array<{ name: string; workingDir?: string; tagged?: boolean }>
  ): Promise<{
    sessions: Array<{
      id: string;
      name: string;
      projectPath: string;
      status: 'idle' | 'working' | 'waiting' | 'error';
      lastActivity: number;
      currentActivity?: string;
      tmuxSessionName?: string;
      inactive?: boolean;
      taskSummary?: {
        total: number;
        pending: number;
        inProgress: number;
        completed: number;
        activeTask?: string;
      };
      recentTimestamps?: number[];
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
      inactive?: boolean;
      taskSummary?: {
        total: number;
        pending: number;
        inProgress: number;
        completed: number;
        activeTask?: string;
      };
      recentTimestamps?: number[];
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
      const best = this.resolveConversationForSession(ts.name);

      let status: 'idle' | 'working' | 'waiting' | 'error' = 'idle';
      let currentActivity: string | undefined;
      let taskSummary: TaskSummary | undefined;
      let lastActivity = 0;
      let projectPath = ts.workingDir || '';

      let recentTimestamps: number[] | undefined;

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

        // Extract recent message timestamps for sparkline (last 30 min)
        if (messages) {
          const cutoff = Date.now() - 30 * 60 * 1000;
          recentTimestamps = messages
            .filter(m => m.timestamp >= cutoff)
            .map(m => m.timestamp);
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
        recentTimestamps,
      });
    }

    // Add persisted inactive sessions not present in live tmux
    const liveIds = new Set(sessions.map((s) => s.id));
    for (const [id, snap] of this.persistedSessions) {
      if (liveIds.has(id)) continue;
      // Verify conversation file still exists
      if (snap.conversationPath && !fs.existsSync(snap.conversationPath)) {
        this.persistedSessions.delete(id);
        continue;
      }
      sessions.push({
        id: snap.id,
        name: snap.name,
        projectPath: snap.projectPath,
        status: 'idle',
        lastActivity: snap.lastActivity,
        tmuxSessionName: snap.id,
        inactive: true,
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
