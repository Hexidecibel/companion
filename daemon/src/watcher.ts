import * as fs from 'fs';
import {
  SessionIdentity,
  identityChanged,
  descendantPids,
  processStartMs,
  bornAfter,
  sanitizeIdentity,
  orderConversationChain,
  transcriptStartMs,
  ChainEntry,
} from './session-identity';
import * as path from 'path';
import * as chokidar from 'chokidar';
import { EventEmitter } from 'events';
import { runTmux } from './impact/sub';
import {
  ConversationFile,
  ConversationMessage,
  FeedbackPrompt,
  SessionStatus,
  TerminalChoicePrompt,
  TmuxSession,
} from './types';
import { InputInjector } from './input-injector';
import {
  extractHighlights,
  detectCurrentActivity,
  detectCurrentActivityFast,
  getRecentActivity,
  isTrivialHighlights,
} from './parser';
import {
  codexAdapter,
  defaultAgent,
  DEFAULT_AGENT_ID,
  getAgentAdapter,
  isInteractiveTool,
  isSubagentTool,
  requiresApproval,
  type AgentAdapter,
  type AgentId,
} from './agents';
import {
  CodexRolloutIndex,
  codexProcessInfo,
  findCodexPid,
  isCodexRollout,
  rolloutIdOf,
} from './agents/codex/discovery';
import { detectTurnEndError } from './turn-error';
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
import { atomicWriteFileSync, registerShutdownCallback, BoundedMap } from './utils';
import { transcriptCache, TranscriptSnapshot } from './transcript-cache';
import { tmuxSnapshot } from './tmux-snapshot';
import { isReadonlySharedState } from './sandbox';
import type { BackgroundWork, BackgroundWorkMonitor, SessionOverlay } from './background-work';
import { PANE_APPROVAL_ACTIVITY } from './background-work';
import { ProcEnvCache, ProfileRegistry, type AgentProfile } from './profiles';

/**
 * Parse a feedback prompt from tmux terminal output.
 * The Claude CLI shows this at session end:
 *   * How is Claude doing this session? (optional)
 *     1: Bad    2: Fine    3: Good    0: Dismiss
 */
function parseFeedbackPrompt(tmuxText: string): FeedbackPrompt | null {
  // Strip ANSI escape codes
  // eslint-disable-next-line no-control-regex
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
  id: string; // tmux session name
  name: string;
  projectPath: string;
  conversationPath?: string;
  lastActivity: number;
  isWaitingForInput: boolean;
  messageCount: number;
  savedAt: number; // when this snapshot was taken
  /** Account profile (absent = the agent's default). */
  profileId?: string;
  /**
   * The direct mapping while the session was alive. A dead session's mapping
   * leaves memory at the next refresh; this is what lets Remove Session still
   * archive its own transcript. `conversationPath` is display only: it can be a
   * folder fallback.
   */
  ownedConversationId?: string;
  ownedTranscriptPath?: string;
  /** tmux `created` (seconds) of the session that made that mapping. */
  sessionCreated?: string;
}

/** Why Remove Session left a transcript alone. */
export type TranscriptKeepReason =
  | 'no_mapping'
  | 'claimed_by_other'
  | 'predates_session'
  | 'process_owns_other'
  | 'file_missing';

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
  /** tool_use id of the unresolved error the last ended turn finished on (dedupe for error-detected). */
  lastTurnErrorId: string | null;
}

export interface FileChangeOptions {
  /**
   * Cache-only load (e.g. Herald reading an idle session's transcript on demand):
   * parse and track the conversation but emit no events, so a stale transcript
   * never triggers notifications, escalation, feedback polling or auto-approval.
   */
  quiet?: boolean;
}

/** Key in the path maps for a Codex session (Codex transcripts are not cwd-keyed). */
const CODEX_KEY = 'codex:';
/** Re-discovery after a send to a Codex session without a rollout yet. */
const CODEX_NUDGE_DELAYS_MS = [1500, 2000, 3000];
/** One fs.watch per Codex home's sessions dir at most this many. */
const MAX_ROLLOUT_DIR_WATCHES = 8;
/** An agent's start-up screen is watched (pane captures) this long after it starts. */
const STARTUP_WATCH_MS = 10 * 60_000;
/** Start-up captures per refresh, at most. */
const MAX_STARTUP_CAPTURES = 2;
/** Re-read a trust prompt this long after a choice was sent. */
const STARTUP_RECHECK_MS = 1500;
/** currentActivity while the agent's trust prompt is up. */
export const TRUST_PROMPT_ACTIVITY = 'Asking whether to trust this folder';
const startupActivity = (c: TerminalChoicePrompt) =>
  /Bypass/.test(c.question) ? 'Asking to allow Bypass Permissions mode' : TRUST_PROMPT_ACTIVITY;

/** Local-date dir of Codex rollouts (`YYYY/MM/DD`). */
function localDateDir(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return path.join(String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
}
/**
 * Key prefix of a Claude session under a non-default account profile:
 * `profile:<id>:<encoded cwd>` (the default profile keeps the bare encoded
 * cwd), so the same folder under two logins never shares a key.
 */
const PROFILE_KEY = 'profile:';

export interface SessionWatcherOptions {
  /** Codex home (config `codex_home`); default $CODEX_HOME, beside code_home, ~/.codex. */
  codexHome?: string;
  /** Account profiles (default: the two implicit ones from codeHome / codexHome). */
  profiles?: ProfileRegistry;
}

/** Open fd of Claude Code's per-session tasks dir: <scratch>/<encoded cwd>/<uuid>/tasks. */
const TASKS_DIR_FD = /\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/tasks$/;

export class SessionWatcher extends EventEmitter {
  /** The default agent (Claude Code): its transcripts are watched under code_home. */
  private readonly agent = defaultAgent();
  /** Account profiles: every Claude / Codex home the watcher reads. */
  readonly profiles: ProfileRegistry;
  /** Codex CLI rollouts per Codex profile id: found per pane by process cwd + start time. */
  private codexIndexes = new Map<string, CodexRolloutIndex>();
  /** tmux session name -> account profile id (from the agent's environ). */
  private sessionProfiles: Map<string, string> = new Map();
  /** tmux session name -> profile the app launched it with (until the process is seen). */
  private profileHints: Map<string, string> = new Map();
  /** CLAUDE_CONFIG_DIR / CODEX_HOME of agent and pane processes (/proc environ, cached). */
  private procEnv = new ProcEnvCache(['CLAUDE_CONFIG_DIR', 'CODEX_HOME']);
  /** chokidar patterns watched for non-default Claude profiles. */
  private profileRootPatterns = new Set<string>();
  /** tmux session name -> agent, for sessions that do not run Claude (Codex). */
  private sessionAgents: Map<string, AgentId> = new Map();
  /** tmux session name -> the Codex rollout it writes. */
  private codexBySession: Map<string, { file: string; convId: string; cwd: string }> = new Map();
  /** Codex rollout path -> tmux session name (reverse of codexBySession). */
  private codexFiles: Map<string, string> = new Map();
  private codeHome: string;
  private watcher: chokidar.FSWatcher | null = null;
  private loggedReadonlySharedState = false;
  // Internal conversation tracking — keyed by JSONL UUID for parse efficiency
  private conversations: Map<string, TrackedConversation> = new Map();
  /** Transcript path -> first entry time (ms); immutable once known. */
  private transcriptStartCache = new BoundedMap<string, number>(500);
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
  /** Background agents / shells + bypass-mode source (background-work.ts); null = raw transcript state. */
  private bgWork: BackgroundWorkMonitor | null = null;
  private initialLoadComplete: boolean = false;
  private startTime: number = Date.now();
  private tmuxProjectPaths: Set<string> = new Set(); // encoded paths of tagged sessions only
  private tmuxFilterEnabled: boolean = true;
  private newlyCreatedSessions: Map<string, number> = new Map(); // session name -> creation timestamp
  private tmuxSessionIdentity: Map<string, SessionIdentity> = new Map(); // session name -> current identity
  private mappingIdentity: Map<string, SessionIdentity> = new Map(); // session name -> identity its mapping was made for
  private decodedPathCache: Map<string, string> = new Map(); // encoded project dir -> decoded path
  private claudeStartMs: Map<string, number> = new Map(); // session name -> current claude process start (ms)
  private compactedSessions: Map<string, number> = new Map(); // session -> when it compacted (a continuation JSONL may follow)
  private detectInFlight: Set<string> = new Set(); // sessions currently being probed by detectConversationForSession
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private waitingDebounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private static readonly DEBOUNCE_MS = 150; // Debounce file changes per session
  /** A conversation written continuously is still processed at least this often. */
  private static readonly DEBOUNCE_MAX_WAIT_MS = 1000;
  private debounceSince: Map<string, number> = new Map();
  private static readonly MISSED_SCAN_INTERVAL_MS = 10_000;
  private static readonly MISSED_SCAN_MAX_FILES = 500;
  private missedScanTimer: NodeJS.Timeout | null = null;
  private missedScanRunning = false;
  private static readonly WAITING_DEBOUNCE_MS = 3000; // Delay before confirming "waiting" for non-interactive tools

  // Persisted sessions — loaded from disk on startup, merged with live data
  private persistedSessions: Map<string, PersistedSessionSnapshot> = new Map();
  private lastSessionsSnapshotKey: string | null = null;
  private lastTrackingLog = '';
  private lastMappingsData: string | null = null;

  // Feedback prompt detection
  private inputInjector: InputInjector | null = null;
  private feedbackPollTimer: NodeJS.Timeout | null = null;
  private feedbackPollCount: number = 0;
  private feedbackPrompt: FeedbackPrompt | null = null;
  private feedbackSessionId: string | null = null; // tmux session name that has the feedback prompt
  private static readonly FEEDBACK_POLL_INTERVAL_MS = 3000;
  private static readonly FEEDBACK_POLL_MAX_ATTEMPTS = 10;

  constructor(codeHome: string, inputInjector?: InputInjector, opts: SessionWatcherOptions = {}) {
    super();
    this.codeHome = codeHome;
    this.profiles =
      opts.profiles ??
      new ProfileRegistry({ codeHome, codexHome: opts.codexHome, configPath: null });
    this.profiles.on('changed', () => this.syncProfileRoots());
    this.inputInjector = inputInjector || null;
    this.loadPersistedMappings();
    this.loadPersistedSessions();
    // Refresh tmux paths periodically
    this.refreshTmuxPaths();
    const tmuxRefreshInterval = setInterval(
      () => this.refreshTmuxPaths(),
      TMUX_PATH_REFRESH_INTERVAL_MS
    );
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
            // Older files could hold the current mapping anywhere in the list
            // (a mapping flipped to a side transcript and back): dedupe and
            // keep the current conversation last. Display order is derived
            // from the files themselves (getConversationChain).
            const current = this.tmuxConversationIds.get(session);
            const clean = (ids as unknown[]).filter(
              (id, i, arr): id is string =>
                typeof id === 'string' && arr.indexOf(id) === i && id !== current
            );
            if (current) clean.push(current);
            this.tmuxConversationHistory.set(session, clean);
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

      // Account profile per mapped session (absent = default; informational:
      // the live profile is always re-read from the agent's environ).
      const profiles: Record<string, string> = {};
      for (const session of this.tmuxConversationIds.keys()) {
        const p = this.sessionProfiles.get(session);
        if (p && !this.profiles.get(p)?.isDefault) profiles[session] = p;
      }
      const data = JSON.stringify({
        mappings,
        history,
        identity,
        ...(Object.keys(profiles).length ? { profiles } : {}),
      });
      if (data === this.lastMappingsData) return; // unchanged: no rewrite
      atomicWriteFileSync(this.mappingsPath, data);
      this.lastMappingsData = data;
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
        this.adoptPersistedMapping(snap);
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

  /** A snapshot from before ownership was recorded: take it from the mappings file. */
  private adoptPersistedMapping(snap: PersistedSessionSnapshot): void {
    if (snap.ownedConversationId || !snap.conversationPath) return;
    const convId = this.tmuxConversationIds.get(snap.id);
    if (!convId) return;
    const file = path.basename(snap.conversationPath).includes(convId)
      ? snap.conversationPath
      : this.transcriptPathForKey(this.claudeKeyOfFile(snap.conversationPath), convId);
    if (!file) return;
    snap.ownedConversationId = convId;
    snap.ownedTranscriptPath = file;
    const created = this.mappingIdentity.get(snap.id)?.created;
    if (created) snap.sessionCreated = created;
  }

  /** The file of a live session's mapped conversation, loaded or not. */
  private mappedTranscriptPath(sessionName: string, convId: string): string | null {
    const loaded = this.conversations.get(convId)?.path;
    if (loaded) return loaded;
    const codex = this.codexBySession.get(sessionName);
    if (codex?.convId === convId) return codex.file;
    const key = this.tmuxPathBySession.get(sessionName);
    return key ? this.transcriptPathForKey(key, convId) : null;
  }

  /** Snapshots list live sessions only, so this is always the current mapping. */
  private snapshotOwnership(
    id: string
  ): Pick<PersistedSessionSnapshot, 'ownedConversationId' | 'ownedTranscriptPath' | 'sessionCreated'> {
    const convId = this.tmuxConversationIds.get(id);
    const file = convId ? this.mappedTranscriptPath(id, convId) : null;
    if (!convId || !file) return {};
    const created = this.tmuxSessionIdentity.get(id)?.created;
    return {
      ownedConversationId: convId,
      ownedTranscriptPath: file,
      ...(created ? { sessionCreated: created } : {}),
    };
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
        savedAt: 0,
        ...(s.profileId ? { profileId: s.profileId } : {}),
        ...this.snapshotOwnership(s.id),
      }));
      // Written only when something besides savedAt changed (this runs on
      // every 5 s refresh; an idle box used to rewrite the file each time).
      const key = JSON.stringify(snapshots);
      if (key === this.lastSessionsSnapshotKey) return;
      const now = Date.now();
      for (const snap of snapshots) snap.savedAt = now;
      atomicWriteFileSync(this.sessionsSnapshotPath, JSON.stringify(snapshots));
      this.lastSessionsSnapshotKey = key;
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
      const at = history.indexOf(convId);
      if (at !== -1 && at !== history.length - 1) history.splice(at, 1);
      if (history[history.length - 1] !== convId) history.push(convId);
    }

    this.tmuxConversationHistory.set(sessionName, history);
    this.tmuxConversationIds.set(sessionName, convId);
    const identity = this.tmuxSessionIdentity.get(sessionName);
    if (identity && (!isChainExtension || !this.mappingIdentity.has(sessionName)))
      this.mappingIdentity.set(sessionName, { ...identity });
  }

  /** Created after `startedAt` (birthtime, else mtime); unknown -> true. */
  private fileBornAfter(filePath: string, startedAt: number): boolean {
    try {
      return bornAfter(fs.statSync(filePath), startedAt);
    } catch {
      return true;
    }
  }

  /**
   * Can this transcript be this session's at all? A file last written before
   * the tmux session existed cannot be, and one born before a "new session"
   * guard started belongs to an earlier conversation. (2026-10-31: creating a
   * second session in a folder force-loaded old files, and elimination and a
   * stale compaction flag claimed them.)
   */
  private couldOwnTranscript(
    sessionName: string,
    stats: { birthtimeMs?: number; mtimeMs: number }
  ): boolean {
    const guard = this.newlyCreatedSessions.get(sessionName);
    if (guard !== undefined && !bornAfter(stats, guard)) return false;
    const created = Number(this.tmuxSessionIdentity.get(sessionName)?.created) * 1000;
    return !(created > 0 && stats.mtimeMs < created - 1000);
  }

  /**
   * Read a session's mapped transcript when it is not in memory yet: a mapping
   * restored at start-up points at a file the age filter skipped, so reads
   * came back empty although the transcript is on disk. Quiet: cache only.
   */
  private loadMappedConversation(sessionName: string): boolean {
    const id = this.tmuxConversationIds.get(sessionName);
    if (!id) return false;
    if (this.conversations.has(id)) return true;
    const key = this.tmuxPathBySession.get(sessionName);
    const file = key ? this.transcriptPathForKey(key, id) : null;
    if (!file || !fs.existsSync(file)) return false;
    this.processFileChange(file, id, { quiet: true });
    return this.conversations.has(id);
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
        const sessionNew =
          !!(prev.created && cur.created && prev.created !== cur.created) ||
          !!(prev.panePid && cur.panePid && prev.panePid !== cur.panePid);
        console.log(
          `Watcher: ${name} is a ${sessionNew ? 'new tmux session with a reused name' : 'new claude process'}; dropping stale mapping -> ${this.tmuxConversationIds.get(name)?.substring(0, 8)}`
        );
        this.dropConversationMapping(name);
        const createdMs = Number(cur.created) * 1000;
        const startedMs = sessionNew ? createdMs : this.claudeStartMs.get(name) || 0;
        this.newlyCreatedSessions.set(
          name,
          startedMs > 0 ? Math.min(startedMs, Date.now()) : Date.now() - 5000
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
      if (
        filled.created !== prev.created ||
        filled.panePid !== prev.panePid ||
        filled.claudePid !== prev.claudePid
      ) {
        this.mappingIdentity.set(name, filled);
        changed = true;
      }
    }
    if (changed) this.persistMappings();
  }

  private refreshInFlight: Promise<void> | null = null;

  /**
   * Re-read tagged tmux sessions (paths, identity) and reconcile mappings.
   * Concurrent calls share one run (in-flight guard): the 5 s interval never
   * stacks behind a slow tmux.
   */
  refreshTmuxPaths(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const p = this.refreshTmuxPathsInner().finally(() => {
      this.refreshInFlight = null;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        const t = setTimeout(() => void this.refreshTmuxPaths().catch(() => {}), 0);
        t.unref?.();
      }
    });
    this.refreshInFlight = p;
    return p;
  }

  /** A refresh requested while one runs: run one more afterwards (that one may be past discovery). */
  private refreshAgain = false;

  /** Refresh now, or once more right after the one in flight. */
  private requestRefresh(): void {
    if (this.refreshInFlight) {
      this.refreshAgain = true;
      return;
    }
    void this.refreshTmuxPaths().catch(() => {});
  }

  private async refreshTmuxPathsInner(): Promise<void> {
    try {
      // One `tmux list-panes -a` instead of list-sessions + 2 calls per
      // session. Always fresh here (every 5 s); get_server_summary and other
      // listings reuse this result for up to 2 s.
      // Profiles added / removed in the config since the last refresh (one stat).
      await this.profiles.refresh().catch(() => false);
      const snap = await tmuxSnapshot.get(0);
      if (!snap.ok) return; // tmux did not answer in time: keep the last state
      if (snap.sessions.length === 0) throw new Error('no tmux sessions');

      // Rebuild maps — only include tagged sessions (COMPANION_APP=1).
      // Built on the side and swapped in below in one synchronous step: the
      // loop awaits per session, and anything that read the live maps
      // meanwhile (getServerSummary, getSessions, ...) used to see them empty
      // or half-filled, i.e. live sessions reported as closed ("inactive") for
      // a moment every refresh. Never clear-then-await here.
      const nextProjectPaths = new Set<string>();
      const nextSessionByPath = new Map<string, string>();
      const nextPathBySession = new Map<string, string>();
      const nextWorkingDirs = new Map<string, string>();
      const nextIdentity = new Map<string, SessionIdentity>();
      const nextAgents = new Map<string, AgentId>();
      const nextProfiles = new Map<string, string>();
      const livePids: number[] = [];
      const codexPanes: Array<{ name: string; pid: number; profile: AgentProfile }> = [];

      for (const row of snap.sessions) {
        const name = row.name;
        try {
          // Check if this session is tagged with COMPANION_APP=1 (cached)
          if (!(await tmuxSnapshot.isTagged(row))) {
            continue; // Skip untagged sessions
          }

          // Active pane's working directory + session identity (from the snapshot)
          const workingDir = row.workingDir;
          if (!workingDir) continue;

          // Claude first; a pane without claude may run Codex (both /proc only).
          // The account profile comes from the process's CLAUDE_CONFIG_DIR /
          // CODEX_HOME (else the pane shell's, which the app set at launch).
          let claudePid = await this.agent.transcript.findAgentPid(row.panePid);
          let started: number | null = null;
          let profile: AgentProfile;
          const paneEnv = () => this.procEnv.read(row.panePid);
          livePids.push(row.panePid);
          if (claudePid) {
            this.agentHints.delete(name);
            started = await processStartMs(claudePid);
            livePids.push(claudePid);
            const env = await this.procEnv.read(claudePid, started);
            profile = this.profiles.forHome('claude', env.CLAUDE_CONFIG_DIR);
          } else {
            const codexPid = await findCodexPid(row.panePid);
            if (codexPid) {
              claudePid = codexPid;
              started = await processStartMs(codexPid);
              livePids.push(codexPid);
              const env = await this.procEnv.read(codexPid, started);
              profile = this.profiles.forHome('codex', env.CODEX_HOME);
              nextAgents.set(name, 'codex');
              codexPanes.push({ name, pid: codexPid, profile });
            } else {
              // No agent process (yet): a session the app launched Codex in
              // stays a Codex session (its key never names a Claude project
              // dir, so a Claude transcript of the same folder is never shown).
              const launchedCodex = this.agentHints.get(name) === 'codex';
              const hinted = this.profiles.get(this.profileHints.get(name));
              const env = await paneEnv();
              const want = launchedCodex ? 'codex' : 'claude';
              profile =
                hinted && hinted.agent === want
                  ? hinted
                  : launchedCodex
                    ? this.profiles.forHome('codex', env.CODEX_HOME)
                    : this.profiles.forHome('claude', env.CLAUDE_CONFIG_DIR);
            }
          }
          if (claudePid) this.profileHints.delete(name);
          const codexKeyed =
            nextAgents.has(name) || (!claudePid && this.agentHints.get(name) === 'codex');
          const encodedPath = codexKeyed
            ? CODEX_KEY + name
            : this.keyFor(profile, this.agent.transcript.encodeProjectDir(workingDir));
          nextProfiles.set(name, profile.id);
          nextProjectPaths.add(encodedPath);
          nextSessionByPath.set(encodedPath, name);
          nextPathBySession.set(name, encodedPath);
          nextWorkingDirs.set(name, workingDir);
          nextIdentity.set(name, {
            created: row.created,
            panePid: row.panePid,
            encodedPath,
            claudePid,
          });
          if (claudePid && started) this.claudeStartMs.set(name, started);
        } catch {
          // Session may have been killed between list and env check
        }
      }

      // Codex rollouts, newest process first so it claims its own thread
      // before an older Codex in the same folder (fs reads only, cached meta).
      const nextCodex = await this.resolveCodexRollouts(codexPanes);

      // Swap (no await in between; the containers keep their identity).
      this.tmuxProjectPaths.clear();
      for (const p of nextProjectPaths) this.tmuxProjectPaths.add(p);
      const swap = <V>(live: Map<string, V>, next: Map<string, V>) => {
        live.clear();
        for (const [k, v] of next) live.set(k, v);
      };
      swap(this.tmuxSessionByPath, nextSessionByPath);
      swap(this.tmuxPathBySession, nextPathBySession);
      swap(this.tmuxSessionWorkingDirs, nextWorkingDirs);
      swap(this.tmuxSessionIdentity, nextIdentity);
      swap(this.sessionAgents, nextAgents);
      swap(this.sessionProfiles, nextProfiles);
      this.procEnv.retain(livePids);
      for (const hints of [this.agentHints, this.profileHints] as Array<Map<string, unknown>>) {
        for (const name of [...hints.keys()]) {
          if (!snap.sessions.some((r) => r.name === name)) hints.delete(name);
        }
      }
      const codexGone = [...this.codexFiles.keys()].filter(
        (f) => ![...nextCodex.values()].some((c) => c.file === f)
      );
      swap(this.codexBySession, nextCodex);
      this.codexFiles.clear();
      for (const [name, c] of nextCodex) this.codexFiles.set(c.file, name);
      for (const f of codexGone) this.watcher?.unwatch(f);

      // Every 5 s: log only when the tracked set changes.
      const trackingLog = `Watcher: Tracking ${this.tmuxProjectPaths.size} paths from ${this.tmuxPathBySession.size} tagged tmux session(s)`;
      if (this.tmuxProjectPaths.size > 0 && trackingLog !== this.lastTrackingLog) {
        console.log(trackingLog);
      }
      this.lastTrackingLog = trackingLog;

      await this.applyCodexMappings();

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

      for (const name of [...this.startupPrompts.keys()]) {
        if (!this.tmuxPathBySession.has(name)) this.startupPrompts.delete(name);
      }
      for (const [name, pid] of [...this.startupSettled]) {
        if (this.tmuxSessionIdentity.get(name)?.claudePid !== pid) this.startupSettled.delete(name);
      }
      // Start-up screens of fresh agents (trust prompt): a few bounded
      // captures, not awaited (in-flight guarded per session).
      void this.checkStartupPrompts();
      this.syncRolloutDirWatch();
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
      this.sessionAgents.clear();
      this.sessionProfiles.clear();
      this.codexBySession.clear();
      this.codexFiles.clear();
    }
  }

  /** Rollout per Codex pane (see agents/codex/discovery.ts); a pane with none yet is left out. */
  private async resolveCodexRollouts(
    panes: Array<{ name: string; pid: number; profile: AgentProfile }>
  ): Promise<Map<string, { file: string; convId: string; cwd: string }>> {
    const out = new Map<string, { file: string; convId: string; cwd: string }>();
    if (panes.length === 0) return out;
    const infos: Array<{
      name: string;
      profile: AgentProfile;
      info: NonNullable<Awaited<ReturnType<typeof codexProcessInfo>>>;
    }> = [];
    for (const p of panes) {
      const info = await codexProcessInfo(p.pid);
      if (info) infos.push({ name: p.name, profile: p.profile, info });
    }
    infos.sort((a, b) => (b.info.startedAt ?? 0) - (a.info.startedAt ?? 0));
    const claimed = new Set<string>();
    for (const { name, profile, info } of infos) {
      try {
        // Each Codex profile has its own home (sessions/ + app-server).
        const hit = await this.codexIndexFor(profile).findRollout(info, claimed);
        if (!hit) continue;
        claimed.add(hit.file);
        out.set(name, { file: hit.file, convId: hit.id, cwd: hit.meta.cwd });
      } catch {
        /* unreadable codex home: no mapping this round */
      }
    }
    return out;
  }

  /**
   * Direct session -> conversation mappings for Codex panes (exact from
   * discovery, no path heuristics), watch their rollouts and load new ones.
   */
  private async applyCodexMappings(): Promise<void> {
    for (const [name, c] of this.codexBySession) {
      if (this.tmuxConversationIds.get(name) !== c.convId) {
        console.log(`Watcher: Codex session ${name} -> ${c.convId.substring(0, 8)} (${c.file})`);
        this.setConversationMapping(name, c.convId);
      }
      this.newlyCreatedSessions.delete(name);
      if (this.watcher && !this.watchedCodexFiles.has(c.file)) {
        this.watcher.add(c.file);
        this.watchedCodexFiles.add(c.file);
      }
      if (!this.conversations.has(c.convId)) {
        await this.processFileChangeAsync(c.file, c.convId);
      }
    }
    for (const f of [...this.watchedCodexFiles]) {
      if (!this.codexFiles.has(f)) this.watchedCodexFiles.delete(f);
    }
  }

  private watchedCodexFiles = new Set<string>();

  /**
   * The agent running in a tmux session: what the last refresh found under the
   * pane (Codex process), else what the session was launched with (a fresh
   * spawn before its agent process shows up), else Claude.
   */
  agentFor(sessionId?: string | null): AgentAdapter {
    if (!sessionId) return getAgentAdapter(undefined);
    return getAgentAdapter(this.sessionAgents.get(sessionId) ?? this.agentHints.get(sessionId));
  }

  /** Which agent the app launched in a session (until the process itself is seen). */
  noteSessionAgent(sessionId: string, agent: AgentId): void {
    if (agent === DEFAULT_AGENT_ID) this.agentHints.delete(sessionId);
    else this.agentHints.set(sessionId, agent);
  }

  /** Codex's home as the watcher reads it (spawned Codex sessions get it as CODEX_HOME). */
  getCodexHome(): string {
    return this.profiles.defaultFor('codex').home;
  }

  /** Rollout index of a Codex profile (one per home, created on first use). */
  private codexIndexFor(profile: AgentProfile): CodexRolloutIndex {
    let idx = this.codexIndexes.get(profile.id);
    if (!idx || idx.codexHome !== profile.home) {
      idx = new CodexRolloutIndex(profile.home);
      this.codexIndexes.set(profile.id, idx);
    }
    return idx;
  }

  /** The account profile a tmux session runs under (default of its agent when unknown). */
  profileFor(sessionId: string): AgentProfile {
    const agent = this.agentFor(sessionId).id === 'codex' ? 'codex' : 'claude';
    const id = this.sessionProfiles.get(sessionId) ?? this.profileHints.get(sessionId);
    const p = this.profiles.get(id);
    return p && p.agent === agent ? p : this.profiles.defaultFor(agent);
  }

  /** Which profile the app launched a session with (until its process is seen). */
  noteSessionProfile(sessionId: string, profileId: string): void {
    const p = this.profiles.get(profileId);
    if (!p || p.isDefault) this.profileHints.delete(sessionId);
    else this.profileHints.set(sessionId, profileId);
  }

  // ---- path keys (Claude: per profile root) ----

  private keyFor(profile: AgentProfile, encoded: string): string {
    return profile.isDefault ? encoded : `${PROFILE_KEY}${profile.id}:${encoded}`;
  }

  /** Home + encoded cwd dir of a Claude path key (null: a Codex key or a removed profile). */
  private splitKey(key: string): { home: string; encoded: string } | null {
    if (!key || key.startsWith(CODEX_KEY)) return null;
    if (key.startsWith(PROFILE_KEY)) {
      const rest = key.slice(PROFILE_KEY.length);
      const i = rest.indexOf(':');
      const p = i > 0 ? this.profiles.get(rest.slice(0, i)) : undefined;
      if (!p || p.agent !== 'claude') return null;
      return { home: p.home, encoded: rest.slice(i + 1) };
    }
    return { home: this.codeHome, encoded: key };
  }

  /** Project directory of a Claude path key. */
  private projectDirForKey(key: string): string | null {
    const s = this.splitKey(key);
    return s ? path.join(this.agent.transcript.projectsDir(s.home), s.encoded) : null;
  }

  private transcriptPathForKey(key: string, convId: string): string | null {
    const s = this.splitKey(key);
    return s ? this.agent.transcript.transcriptPath(s.home, s.encoded, convId) : null;
  }

  /** Claude projects dirs, the default profile's first. */
  private claudeRoots(): Array<{ profile: AgentProfile; projectsDir: string }> {
    return this.profiles.ofAgent('claude').map((profile) => ({
      profile,
      projectsDir: this.agent.transcript.projectsDir(
        profile.isDefault ? this.codeHome : profile.home
      ),
    }));
  }

  /** Path key of a Claude transcript ('' when it is under no profile's projects dir). */
  private claudeKeyOfFile(filePath: string): string {
    for (const r of this.claudeRoots()) {
      const rel = path.relative(r.projectsDir, filePath);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const first = rel.split(path.sep)[0];
      return first ? this.keyFor(r.profile, first) : '';
    }
    return '';
  }

  /** Watch every non-default Claude profile's transcripts (one chokidar pattern each). */
  private syncProfileRoots(): void {
    if (!this.watcher) return;
    const want = new Set<string>();
    for (const r of this.claudeRoots()) {
      if (r.profile.isDefault) continue;
      // Make the projects dir exist so chokidar can watch it (the agent creates it anyway).
      try {
        if (fs.existsSync(r.profile.home)) fs.mkdirSync(r.projectsDir, { recursive: true });
      } catch {
        /* read-only home: the missed-transcript scan still finds files */
      }
      want.add(path.join(r.projectsDir, '**', '*.jsonl'));
    }
    for (const pat of want) {
      if (!this.profileRootPatterns.has(pat)) {
        console.log(`Watcher: watching profile transcripts in ${path.dirname(path.dirname(pat))}`);
        this.watcher.add(pat);
        this.profileRootPatterns.add(pat);
      }
    }
    for (const pat of [...this.profileRootPatterns]) {
      if (!want.has(pat)) {
        this.watcher.unwatch(pat);
        this.profileRootPatterns.delete(pat);
      }
    }
  }

  /**
   * argv of the agent process in a session's pane (from the last refresh's
   * identity; one /proc read, no subprocess), or null when none is known.
   */
  async agentArgv(sessionId: string): Promise<string[] | null> {
    const pid = this.tmuxSessionIdentity.get(sessionId)?.claudePid;
    if (!pid) return null;
    try {
      const raw = await fs.promises.readFile(`/proc/${pid}/cmdline`, 'utf-8');
      return raw.split('\0').filter(Boolean);
    } catch {
      return null;
    }
  }

  private agentHints: Map<string, AgentId> = new Map();
  private codexNudges = new Map<string, NodeJS.Timeout>();

  /**
   * Text was just sent to a session. A Codex TUI creates its rollout at the
   * first prompt; re-run discovery shortly after (once per session at a time,
   * through the in-flight-guarded refresh) instead of waiting up to 5 s for
   * the next periodic refresh, so the first turn's status shows at once.
   */
  nudgeCodexDiscovery(sessionId: string): void {
    if (this.agentFor(sessionId).id !== 'codex' || this.codexBySession.has(sessionId)) return;
    if (this.codexNudges.has(sessionId)) return;
    // Codex creates the rollout as the turn starts (well under a second after
    // the Enter): look at 1.5 s, then twice more until it is mapped. The
    // sessions-dir watch (syncRolloutDirWatch) usually gets there first.
    let i = 0;
    const tick = () => {
      if (this.codexBySession.has(sessionId) || i >= CODEX_NUDGE_DELAYS_MS.length) {
        this.codexNudges.delete(sessionId);
        return;
      }
      const t = setTimeout(() => {
        i++;
        this.requestRefresh();
        tick();
      }, CODEX_NUDGE_DELAYS_MS[i]);
      t.unref?.();
      this.codexNudges.set(sessionId, t);
    };
    tick();
  }

  // ---- new Codex rollouts by fs event ----

  /** sessions/YYYY/MM/DD dir -> its watch + the rollout names already there. */
  private rolloutDirWatches = new Map<string, { w: fs.FSWatcher; known: Set<string> }>();
  private rolloutEventTimer: NodeJS.Timeout | null = null;

  /**
   * While a live Codex session has no rollout yet, watch today's sessions dir
   * of its Codex home (one fs.watch per home, re-armed at the date change,
   * dropped once every Codex session is mapped): a NEW rollout file triggers
   * one (debounced, in-flight guarded) refresh, so the first turn is mapped
   * within a moment of Codex creating it. Writes to existing rollouts are
   * ignored; a missing dir (first Codex thread of the day) falls back to the
   * send nudges and the 5 s refresh.
   */
  private syncRolloutDirWatch(now = Date.now()): void {
    const want = new Set<string>();
    for (const name of this.tmuxPathBySession.keys()) {
      if (this.agentFor(name).id !== 'codex' || this.codexBySession.has(name)) continue;
      want.add(path.join(this.profileFor(name).home, 'sessions', localDateDir(now)));
    }
    for (const [dir, rec] of [...this.rolloutDirWatches]) {
      if (want.has(dir)) continue;
      rec.w.close();
      this.rolloutDirWatches.delete(dir);
    }
    for (const dir of want) {
      if (this.rolloutDirWatches.has(dir) || this.rolloutDirWatches.size >= MAX_ROLLOUT_DIR_WATCHES)
        continue;
      try {
        const known = new Set(fs.readdirSync(dir).filter((f) => isCodexRollout(f)));
        const w = fs.watch(dir, { persistent: false }, (_event, file) => {
          const name = typeof file === 'string' ? file : file ? String(file) : '';
          if (!name || !isCodexRollout(name) || known.has(name)) return;
          if (known.size > 5000) known.clear();
          known.add(name);
          this.onNewRolloutFile();
        });
        w.on('error', () => {
          w.close();
          this.rolloutDirWatches.delete(dir);
        });
        this.rolloutDirWatches.set(dir, { w, known });
      } catch {
        /* no dir yet today: nudges + the periodic refresh find it */
      }
    }
  }

  private onNewRolloutFile(): void {
    if (this.rolloutEventTimer) return;
    this.rolloutEventTimer = setTimeout(() => {
      this.rolloutEventTimer = null;
      this.requestRefresh();
    }, 150);
    this.rolloutEventTimer.unref?.();
  }

  // ---- agent start-up prompts (trust) ----

  /** Sessions whose agent is showing its "Trust this folder?" prompt. */
  private startupPrompts = new Map<string, { since: number; choice: TerminalChoicePrompt }>();
  /** Session -> agent pid whose start-up screen was seen ready (no more checks). */
  private startupSettled = new Map<string, number>();
  private startupChecksInFlight = new Set<string>();
  private startupRecheckTimers = new Map<string, NodeJS.Timeout>();

  /**
   * A capture of a session's pane (taken anyway, or by checkStartupPrompts):
   * note whether the agent's trust prompt is up, and tell clients on each
   * edge (status waiting + a conversation update so the chat refetches the
   * live choice). Never answers it.
   */
  noteStartupPane(sessionId: string, pane: string): void {
    if (!sessionId || !this.tmuxPathBySession.has(sessionId)) return;
    const agent = this.agentFor(sessionId);
    let choice: TerminalChoicePrompt | null = null;
    try {
      const c = agent.terminal.detectActiveChoicePrompt(pane);
      if (c?.kind === 'trust') choice = c;
      else if (agent.terminal.classifyStartupPane(pane) === 'ready') {
        const pid = this.tmuxSessionIdentity.get(sessionId)?.claudePid;
        if (pid) this.startupSettled.set(sessionId, pid);
      }
    } catch {
      return;
    }
    const was = this.startupPrompts.get(sessionId);
    if (choice && !was) {
      this.startupPrompts.set(sessionId, { since: Date.now(), choice });
      console.log(
        `Watcher: ${agent.displayName} in "${sessionId}" asks whether to trust its folder`
      );
      this.emitStartupPrompt(sessionId, true);
    } else if (choice && was && choice.question !== was.choice.question) {
      // The next start-up prompt (trust, then the bypass warning): a new card.
      this.startupPrompts.set(sessionId, { since: Date.now(), choice });
      this.emitStartupPrompt(sessionId, true);
    } else if (!choice && was) {
      this.startupPrompts.delete(sessionId);
      console.log(`Watcher: trust prompt in "${sessionId}" answered`);
      this.emitStartupPrompt(sessionId, false);
    }
  }

  /** The trust prompt a session shows (from the last capture), or null. */
  startupPromptFor(sessionId: string): TerminalChoicePrompt | null {
    return this.startupPrompts.get(sessionId)?.choice ?? null;
  }

  /** A choice was just sent: re-read a session that showed its trust prompt. */
  recheckStartupPrompt(sessionId: string): void {
    if (!this.startupPrompts.has(sessionId) || this.startupRecheckTimers.has(sessionId)) return;
    const t = setTimeout(() => {
      this.startupRecheckTimers.delete(sessionId);
      void this.captureStartup(sessionId);
    }, STARTUP_RECHECK_MS);
    t.unref?.();
    this.startupRecheckTimers.set(sessionId, t);
  }

  private emitStartupPrompt(sessionId: string, up: boolean): void {
    const projectPath = this.tmuxSessionWorkingDirs.get(sessionId) || '';
    this.emit('status-change', {
      sessionId,
      isWaitingForInput: up,
      currentActivity: up ? startupActivity(this.startupPrompts.get(sessionId)!.choice) : undefined,
      lastMessage: undefined,
    });
    this.emit('conversation-update', { sessionId });
    if (sessionId !== this.activeTmuxSession) {
      this.emit('other-session-activity', {
        sessionId,
        projectPath,
        sessionName: sessionId,
        isWaitingForInput: up,
        lastMessage: undefined,
        newMessageCount: 0,
      });
    }
  }

  private async captureStartup(sessionId: string): Promise<void> {
    if (!this.inputInjector || this.startupChecksInFlight.has(sessionId)) return;
    if (!this.tmuxPathBySession.has(sessionId)) return;
    this.startupChecksInFlight.add(sessionId);
    try {
      const pane = await this.inputInjector.captureTmuxPane(sessionId, 40);
      if (pane) this.noteStartupPane(sessionId, pane);
    } catch {
      /* capture failed: try again next refresh */
    } finally {
      this.startupChecksInFlight.delete(sessionId);
    }
  }

  /**
   * Per refresh: capture the panes of agents still on their start-up screen
   * (process seen, no transcript of its own yet, started within the last
   * STARTUP_WATCH_MS, not seen ready yet), plus any session showing its trust
   * prompt. At most MAX_STARTUP_CAPTURES per refresh; each session's capture
   * is in-flight guarded and bounded by the injector's tmux timeout.
   */
  private async checkStartupPrompts(now = Date.now()): Promise<void> {
    if (!this.inputInjector) return;
    const due: string[] = [];
    for (const [name, ident] of this.tmuxSessionIdentity) {
      if (due.length >= MAX_STARTUP_CAPTURES) break;
      if (this.startupChecksInFlight.has(name)) continue;
      if (!this.startupPrompts.has(name)) {
        const pid = ident.claudePid;
        if (!pid || this.startupSettled.get(name) === pid) continue;
        const started = this.claudeStartMs.get(name);
        if (!started || now - started > STARTUP_WATCH_MS) continue;
        if (this.tmuxConversationIds.has(name) || this.codexBySession.has(name)) continue;
      }
      due.push(name);
    }
    for (const name of due) await this.captureStartup(name);
  }

  /** The agent whose transcript a file is. */
  private agentForFile(filePath: string): AgentAdapter {
    return isCodexRollout(filePath) ? codexAdapter : this.agent;
  }

  private isFromTmuxSession(filePath: string): boolean {
    if (isCodexRollout(filePath)) return this.codexFiles.has(filePath);
    if (!this.tmuxFilterEnabled || this.tmuxProjectPaths.size === 0) {
      return true; // No filtering if disabled or no tmux sessions
    }

    // Path key of the file: ~/.claude/projects/-Users-foo-bar/uuid.jsonl ->
    // -Users-foo-bar (another profile: profile:<id>:-Users-foo-bar)
    return this.tmuxProjectPaths.has(this.claudeKeyOfFile(filePath));
  }

  async start(): Promise<void> {
    // Load tmux paths BEFORE starting chokidar so the initial file scan
    // is filtered correctly (avoids loading all historical conversation files).
    // A refresh still running from the constructor may predate the current
    // sessions: let it finish, then run a fresh one.
    if (this.refreshInFlight) await this.refreshInFlight.catch(() => undefined);
    await this.refreshTmuxPaths();

    const projectsDir = this.agent.transcript.projectsDir(this.codeHome);

    // Watch for .jsonl files in the projects directory
    const pattern = path.join(projectsDir, '**', '*.jsonl');

    console.log(`Watching for conversations in: ${projectsDir}`);

    // Native fs events (inotify) by default. Polling (stat of every transcript
    // every 100 ms, plus awaitWriteFinish's 50 ms re-stats) was the daemon's
    // largest steady CPU cost; it was chosen only for latency (93b3694), and
    // native events are faster. awaitWriteFinish is gone too: the incremental
    // reader (transcript-cache.ts) never consumes a half-written line, and the
    // per-conversation debounce coalesces bursts. Missed events are covered by
    // reconcileTrackedConversations (stat of tracked files every 5 s) and
    // scanForMissedTranscripts (new files in tagged project dirs every 10 s).
    // COMPANION_WATCH_POLLING=1 restores polling (e.g. a network / VM-shared
    // filesystem that delivers no inotify events).
    const polling = process.env.COMPANION_WATCH_POLLING === '1';
    this.watcher = chokidar.watch(pattern, {
      persistent: true,
      ignoreInitial: false,
      depth: 2,
      ...(polling
        ? {
            usePolling: true,
            interval: FILE_WATCHER_POLL_INTERVAL_MS,
            awaitWriteFinish: {
              stabilityThreshold: CHOKIDAR_STABILITY_THRESHOLD_MS,
              pollInterval: CHOKIDAR_POLL_INTERVAL_MS,
            },
          }
        : { usePolling: false }),
    });
    if (!polling) {
      this.missedScanTimer = setInterval(
        () => void this.scanForMissedTranscripts(),
        SessionWatcher.MISSED_SCAN_INTERVAL_MS
      );
      this.missedScanTimer.unref?.();
    }

    this.syncProfileRoots();

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
    if (this.missedScanTimer) {
      clearInterval(this.missedScanTimer);
      this.missedScanTimer = null;
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
    for (const rec of this.rolloutDirWatches.values()) rec.w.close();
    this.rolloutDirWatches.clear();
    for (const t of [...this.codexNudges.values(), ...this.startupRecheckTimers.values()])
      clearTimeout(t);
    this.codexNudges.clear();
    this.startupRecheckTimers.clear();
    if (this.rolloutEventTimer) clearTimeout(this.rolloutEventTimer);
    this.rolloutEventTimer = null;
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
          const choice = this.agent.terminal.detectActiveChoicePrompt(paneText);
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
    // successive file parses when the CLI is actively writing. A file written
    // without a 150 ms pause (streaming) still gets processed every second.
    const now = Date.now();
    const since = this.debounceSince.get(convId) ?? now;
    const existingTimer = this.debounceTimers.get(convId);
    if (existingTimer) {
      if (now - since >= SessionWatcher.DEBOUNCE_MAX_WAIT_MS) return; // fires soon anyway
      clearTimeout(existingTimer);
    }
    this.debounceSince.set(convId, since);
    const delay = Math.max(
      0,
      Math.min(SessionWatcher.DEBOUNCE_MS, SessionWatcher.DEBOUNCE_MAX_WAIT_MS - (now - since))
    );
    this.debounceTimers.set(
      convId,
      setTimeout(() => {
        this.debounceTimers.delete(convId);
        this.debounceSince.delete(convId);
        void this.processFileChangeAsync(filePath, convId).catch((err) =>
          console.error(`Watcher: processFileChangeAsync failed for ${convId}:`, err)
        );
      }, delay)
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

          // Re-parse to confirm still waiting (incremental: only new bytes are read).
          const snap = await transcriptCache.get(filePath);
          if (!snap) return;
          const messages = snap.messages();
          if (!this.agent.transcript.detectWaitingForInput(messages)) return;

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
    let snap: TranscriptSnapshot | null;
    try {
      stats = fs.statSync(filePath);
      snap = transcriptCache.getSync(filePath);
    } catch (err) {
      console.log(`Watcher: processFileChange read failed for ${convId}: ${err}`);
      return;
    }
    if (!snap) {
      console.log(`Watcher: processFileChange read failed for ${convId}`);
      return;
    }
    this.applyFileChange(filePath, convId, snap, stats, opts);
  }

  /**
   * Non-blocking entry point: performs the JSONL stat + read via fs.promises so
   * the single-threaded event loop stays free to service pings/pongs while the
   * (possibly multi-MB) conversation file is read off disk. The parse itself is
   * still synchronous CPU work but is unchanged for correctness.
   */
  private async processFileChangeAsync(filePath: string, convId: string): Promise<void> {
    let stats: fs.Stats;
    let snap: TranscriptSnapshot | null;
    try {
      // Only the bytes appended since the last read are read and parsed.
      [stats, snap] = await Promise.all([
        fs.promises.stat(filePath),
        transcriptCache.get(filePath),
      ]);
    } catch (err) {
      console.log(`Watcher: processFileChangeAsync read failed for ${convId}: ${err}`);
      return;
    }
    if (!snap) {
      console.log(`Watcher: processFileChangeAsync read failed for ${convId}`);
      return;
    }
    this.applyFileChange(filePath, convId, snap, stats);
  }

  private applyFileChange(
    filePath: string,
    convId: string,
    snap: TranscriptSnapshot,
    stats: fs.Stats,
    opts: FileChangeOptions = {}
  ): void {
    const quiet = opts.quiet === true;
    const projectPath = this.extractProjectPath(filePath);

    // Parse the conversation from content (already read by the caller)
    const t0 = Date.now();
    const messages = snap.messages();
    const t1 = Date.now();
    const highlights = extractHighlights(messages);
    const t2 = Date.now();
    if (t2 - t0 > SLOW_FILE_PROCESSING_THRESHOLD_MS) {
      console.log(
        `Watcher: processFileChange parse took ${t1 - t0}ms + highlights ${t2 - t1}ms = ${t2 - t0}ms (${messages.length} msgs) for ${convId}`
      );
    }
    const agent = this.agentForFile(filePath);
    const parserSaysWaiting = agent.transcript.detectWaitingForInput(messages);

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
        (tc) => tc.status === 'pending' && isInteractiveTool(tc.name, agent.tools)
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
          (tc) =>
            tc.status === 'pending' &&
            requiresApproval(tc.name, agent.tools) &&
            !isSubagentTool(tc.name, agent.tools)
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
      const startedAt =
        sessionsForPath.length === 1
          ? this.newlyCreatedSessions.get(sessionsForPath[0])
          : undefined;
      if (sessionsForPath.length === 1 && startedAt !== undefined && !bornAfter(stats, startedAt)) {
        // The session (or its claude) just started: an older transcript in the
        // same directory (e.g. the previous claude writing its exit lines) is
        // not this session's.
      } else if (
        sessionsForPath.length === 1 &&
        this.tmuxConversationIds.has(sessionsForPath[0]) &&
        isTrivialHighlights(highlights)
      ) {
        // A transcript holding only a directly-run command (`/login` writes its
        // own file while the conversation goes on in the old one): not a new
        // conversation for an already-mapped session. Claim it only once it
        // holds a real exchange (e.g. after `/clear` and a prompt).
      } else if (sessionsForPath.length === 1) {
        tmuxName = sessionsForPath[0];
        this.setConversationMapping(tmuxName, convId);
      } else if (sessionsForPath.length > 1) {
        // Multiple sessions share this path — try elimination
        const convAlreadyMapped = Array.from(this.tmuxConversationIds.values()).includes(convId);
        if (!convAlreadyMapped) {
          const unmapped = sessionsForPath.filter((name) => !this.tmuxConversationIds.has(name));
          if (unmapped.length === 1) {
            if (this.couldOwnTranscript(unmapped[0], stats)) {
              tmuxName = unmapped[0];
              this.setConversationMapping(tmuxName, convId);
            }
          } else if (unmapped.length === 0) {
            // All sessions mapped: one that compacted may continue in a new JSONL,
            // which is then born after the compaction. (Claude Code now usually
            // compacts in place, so the flag can linger; an older file is no
            // continuation.)
            const compactedInPath = sessionsForPath.filter((name) => {
              const at = this.compactedSessions.get(name);
              return at !== undefined && bornAfter(stats, at);
            });
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
    const { event: compactionEvent, lastLine: newCompactionLine } = snap.compactionSince(
      lastCompactionLine,
      tmuxName || convId,
      sessionName,
      projectPath
    );

    if (compactionEvent && !quiet) {
      console.log(`Watcher: Detected compaction in session ${tmuxName || convId}`);
      this.emit('compaction', compactionEvent);
      // Mark this session as expecting a new JSONL (compaction creates a continuation file)
      // Only for live compaction events (prevTracked exists), not initial file loads
      // (Codex compacts inside the same rollout: no continuation file.)
      if (tmuxName && prevTracked && !isCodexRollout(filePath)) {
        this.compactedSessions.set(tmuxName, Date.now());
      }
    }

    // Extract and cache task summary from already-read content
    let cachedTaskSummary: TaskSummary | undefined;
    try {
      const tasks = snap.tasks();
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

    // A turn that ENDED (idle / waiting) on an unresolved tool error (see
    // turn-error.ts). Harmless errors Claude recovered from never count.
    const turnError = conversationWaiting ? detectTurnEndError(messages) : null;

    // Detect running state: has messages and last message is from assistant with no waiting
    const currentIsRunning = messages.length > 0 && !conversationWaiting;
    const prevWasRunning = prevTracked?.isRunning ?? false;
    const prevTurnErrorId = prevTracked?.lastTurnErrorId ?? null;

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
      lastTurnErrorId: turnError?.toolId ?? null,
    };
    this.conversations.set(convId, tracked);

    if (quiet) {
      // Cache-only load: record the pending-tool set as already seen so a later
      // real change does not replay a stale approval, and emit nothing (no
      // status-change -> escalation/push, no pending-approval -> auto-approve).
      const quietPending = agent.transcript.getPendingApprovalTools(messages);
      tracked.lastEmittedPendingTools = quietPending
        .map((t) => t.id)
        .sort()
        .join(',');
      return;
    }

    // Only emit external events if we identified the owning tmux session
    if (!tmuxName) return;

    // Skip if a different conversation is mapped to this session
    const mappedForSession = this.tmuxConversationIds.get(tmuxName);
    if (mappedForSession && mappedForSession !== convId) return;

    // Use tmux session name as the external session ID for all events
    const sessionId = tmuxName;

    // Emit error-detected once per turn that ended on an unresolved error. Not on
    // the first sight of a file (a daemon restart must not replay old turns).
    if (turnError && prevTracked && turnError.toolId !== prevTurnErrorId) {
      this.emit('error-detected', {
        sessionId,
        projectPath,
        sessionName,
        content: turnError.preview,
        tool: turnError.tool,
        line: turnError.line,
      });
    }

    // Emit session-completed when running transitions to not-running (idle)
    if (prevWasRunning && !currentIsRunning && prevTracked) {
      const lastMsg = messages[messages.length - 1];
      this.emit('session-completed', {
        sessionId,
        projectPath,
        sessionName,
        content:
          lastMsg?.content?.substring(0, SESSION_COMPLETION_MESSAGE_LENGTH) || 'Session completed',
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
    const currentActivity = agent.transcript.detectCurrentActivity(messages);

    // Feedback prompt polling: start when transitioning to waiting with no pending tool approvals
    const hasPendingToolCalls =
      lastMessage?.type === 'assistant' &&
      lastMessage.toolCalls?.some((tc) => tc.status === 'pending');
    if (
      waitingStatusChanged &&
      conversationWaiting &&
      !hasPendingToolCalls &&
      agent === this.agent
    ) {
      // Claude's end-of-session "How is Claude doing" prompt only.
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
    const pendingTools = agent.transcript.getPendingApprovalTools(messages);
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
    if (isCodexRollout(filePath)) {
      const name = this.codexFiles.get(filePath);
      const c = name ? this.codexBySession.get(name) : undefined;
      return c?.cwd || (name && this.tmuxSessionWorkingDirs.get(name)) || '';
    }
    // Extract project path from conversation file path
    // e.g., ~/.claude/projects/-Users-foo-bar/abc123.jsonl -> /Users/foo/bar
    const split = this.splitKey(this.claudeKeyOfFile(filePath));

    if (split) {
      const encoded = split.encoded;
      // Exact: a live session's working directory that encodes to this name
      for (const dir of this.tmuxSessionWorkingDirs.values()) {
        if (this.agent.transcript.encodeProjectDir(dir) === encoded) return dir;
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
    const codexId = rolloutIdOf(filePath);
    if (codexId) return codexId;
    // Use the JSONL filename (UUID) as internal conversation ID.
    // Skip files outside every profile's projects directory (like history.jsonl in root)
    if (!this.claudeKeyOfFile(filePath)) return '';
    // Use filename without extension as conversation ID (e.g., "abc123def456")
    const filename = path.basename(filePath, '.jsonl');
    return filename;
  }

  /**
   * Extract the encoded project directory name from a file path.
   * e.g., ~/.claude/projects/-home-hexi-foo/abc.jsonl -> "-home-hexi-foo"
   */
  private getEncodedDirName(filePath: string): string {
    if (isCodexRollout(filePath)) {
      const name = this.codexFiles.get(filePath);
      return name ? CODEX_KEY + name : '';
    }
    return this.claudeKeyOfFile(filePath);
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
   * The transcript Remove Session may archive, or why none. Stricter than
   * getConversationInfo, whose folder and snapshot fallbacks are fine for
   * showing a chat but can name another session's file (2026-10-31: a new
   * session with no prompt had an older session's transcript archived). Only a
   * direct mapping counts, and everything doubtful leaves the file in place.
   * Call before killing the session: the open tasks dir needs its process.
   */
  async resolveRemovableTranscript(
    sessionId: string
  ): Promise<{ path: string } | { path: null; reason: TranscriptKeepReason }> {
    const live = this.tmuxPathBySession.has(sessionId);
    const snap = live ? undefined : this.persistedSessions.get(sessionId);
    const convId = live ? this.tmuxConversationIds.get(sessionId) : snap?.ownedConversationId;
    if (!convId) return { path: null, reason: 'no_mapping' };
    if (this.conversationClaimedByOther(sessionId, convId)) {
      return { path: null, reason: 'claimed_by_other' };
    }

    const file = live ? this.mappedTranscriptPath(sessionId, convId) : snap?.ownedTranscriptPath;
    if (!file) return { path: null, reason: 'file_missing' };
    let stats: fs.Stats;
    try {
      stats = fs.statSync(file);
    } catch {
      return { path: null, reason: 'file_missing' };
    }
    const createdMs = Number(snap?.sessionCreated) * 1000;
    const couldOwn = live
      ? this.couldOwnTranscript(sessionId, stats)
      : !(createdMs > 0 && stats.mtimeMs < createdMs - 1000);
    if (!couldOwn) return { path: null, reason: 'predates_session' };

    // The running process names its conversation: a mapping it contradicts is
    // wrong even when the file was written after the session started. The chain
    // counts: after a compaction the dir can still name the earlier id.
    if (live && !this.sessionAgents.has(sessionId)) {
      const running = await this.detectConversationForSession(sessionId);
      if (
        running &&
        running !== convId &&
        !this.tmuxConversationHistory.get(sessionId)?.includes(running)
      ) {
        return { path: null, reason: 'process_owns_other' };
      }
    }
    return { path: file };
  }

  private conversationClaimedByOther(sessionId: string, convId: string): boolean {
    for (const [name, id] of this.tmuxConversationIds) {
      if (name !== sessionId && id === convId) return true;
    }
    for (const [name, ids] of this.tmuxConversationHistory) {
      if (name !== sessionId && ids.includes(convId)) return true;
    }
    for (const [name, snap] of this.persistedSessions) {
      if (name !== sessionId && !this.tmuxPathBySession.has(name)) {
        if (snap.ownedConversationId === convId) return true;
      }
    }
    return false;
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

    // Until the next refresh these would let a late read or file event load the
    // folder's newest transcript for the removed name. A session that survived
    // its kill comes back with that refresh.
    this.tmuxPathBySession.delete(sessionId);
    this.tmuxSessionWorkingDirs.delete(sessionId);
    this.tmuxSessionIdentity.delete(sessionId);
    for (const [ePath, name] of this.tmuxSessionByPath) {
      if (name === sessionId) this.tmuxSessionByPath.delete(ePath);
    }

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
    return this.getBestConversationForSession(sessionName, encodedPath);
  }

  /**
   * Path fallback for a session without a direct mapping. In a folder shared by
   * several sessions, never a transcript another session owns or one this
   * session cannot own: nothing to show beats showing someone else's chat.
   */
  private getBestConversationForSession(
    sessionName: string,
    encodedPath: string
  ): { id: string; conv: TrackedConversation } | null {
    let shared = false;
    for (const [name, ePath] of this.tmuxPathBySession) {
      if (name !== sessionName && ePath === encodedPath) shared = true;
    }
    if (!shared) return this.getBestConversationForPath(encodedPath);
    const taken = new Set(this.tmuxConversationIds.values());
    let best: { id: string; conv: TrackedConversation } | null = null;
    for (const [id, conv] of this.conversations) {
      if (this.getEncodedDirName(conv.path) !== encodedPath || taken.has(id)) continue;
      if (!this.couldOwnTranscript(sessionName, { mtimeMs: conv.lastModified })) continue;
      if (!best || conv.lastModified > best.conv.lastModified) best = { id, conv };
    }
    return best;
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
    // The session's own profile root (its CLAUDE_CONFIG_DIR's projects dir).
    const split = this.splitKey(this.tmuxPathBySession.get(sessionName) || '');
    const projectsDir = this.agent.transcript.projectsDir(split ? split.home : this.codeHome);
    try {
      // Pane root pid from the last refresh (the shared tmux snapshot), so no
      // tmux call here; the root must still be alive.
      const rootPid = String(this.tmuxSessionIdentity.get(sessionName)?.panePid || '');
      if (!rootPid || rootPid === '0') return null;

      // If the pane's root PID is gone, skip — nothing to trace.
      try {
        process.kill(Number(rootPid), 0);
      } catch {
        return null;
      }

      // All descendant PIDs from /proc (bounded walk; was `pstree` via a shell).
      const pids: string[] = [rootPid];
      for (const pid of await descendantPids(Number(rootPid))) pids.push(String(pid));

      // Check /proc/<pid>/fd/ for open JSONL files in the projects directory.
      // Current Claude Code keeps no transcript open, but holds its
      // <scratch>/<encoded cwd>/<session uuid>/tasks directory open.
      let fromTasksDir = null as string | null;
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
              const tasks: RegExpExecArray | null = TASKS_DIR_FD.exec(target);
              if (!fromTasksDir && tasks && (!split || tasks[1] === split.encoded)) {
                fromTasksDir = tasks[2];
              }
            } catch {
              /* can't read this fd */
            }
          }
        } catch {
          /* can't read /proc/<pid>/fd */
        }
      }

      return fromTasksDir;
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
          const convFile = this.transcriptPathForKey(ePath, convId);
          if (convFile && fs.existsSync(convFile)) continue; // File exists, keep mapping
        }
        this.tmuxConversationIds.delete(name);
      }
    }

    // Heal a shared-folder mapping to a transcript last written before the session
    // existed (made by the old elimination / stale compaction rules, and persisted).
    const pathCounts = new Map<string, number>();
    for (const ePath of this.tmuxPathBySession.values()) {
      pathCounts.set(ePath, (pathCounts.get(ePath) || 0) + 1);
    }
    for (const [name, convId] of [...this.tmuxConversationIds]) {
      const ePath = this.tmuxPathBySession.get(name);
      if (!ePath || (pathCounts.get(ePath) || 0) < 2 || this.sessionAgents.has(name)) continue;
      const file = this.conversations.get(convId)?.path || this.transcriptPathForKey(ePath, convId);
      if (!file) continue;
      try {
        if (!this.couldOwnTranscript(name, fs.statSync(file))) {
          console.log(
            `Watcher: ${name} was mapped to ${convId.substring(0, 8)}, last written before the session existed; dropping`
          );
          this.dropConversationMapping(name);
          if (this.activeTmuxSession === name) this.activeConversationId = null;
          this.persistMappings();
        }
      } catch {
        /* file gone: handled above */
      }
    }

    // Clear newlyCreated flag for sessions whose own JSONL has appeared
    // (conversation file created AFTER the session was created)
    for (const [sessionName, createdAt] of this.newlyCreatedSessions) {
      const ePath = this.tmuxPathBySession.get(sessionName);
      if (!ePath) continue;
      // Find a conversation for this path that was modified after session creation
      for (const [id, conv] of this.conversations) {
        if (
          this.getEncodedDirName(conv.path) === ePath &&
          conv.lastModified > createdAt &&
          this.fileBornAfter(conv.path, createdAt)
        ) {
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
      const projectDir = this.projectDirForKey(ePath);
      if (!projectDir) continue;
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
      if (this.sessionAgents.has(sessionName)) continue; // Codex: mapped by applyCodexMappings
      if (this.newlyCreatedSessions.has(sessionName)) continue; // Don't map until JSONL exists
      const convId = await this.detectConversationForSession(sessionName);
      if (convId) {
        if (!this.conversations.has(convId)) {
          // Conversation not yet tracked — load it on demand
          const convFile = this.transcriptPathForKey(ePath, convId);
          if (convFile && fs.existsSync(convFile)) {
            console.log(
              `Watcher: PID detection found unloaded conversation ${convId.substring(0, 8)} for ${sessionName} — loading`
            );
            this.processFileChange(convFile, convId);
          }
        }
        const takenByOther = [...this.tmuxConversationIds].some(
          ([other, id]) => other !== sessionName && id === convId
        );
        if (this.conversations.has(convId) && !takenByOther) {
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
          const { stdout: paneText } = await runTmux(
            ['capture-pane', '-t', sessionName, '-p', '-S', '-500'],
            'watcher',
            { timeoutMs: 3000 }
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
        const conv = this.conversations.get(unmappedConvs[0]);
        if (conv && !this.couldOwnTranscript(unmapped[0], { mtimeMs: conv.lastModified })) continue;
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
    // The mapped transcript first: the fallbacks below could pick a sibling's.
    if (this.loadMappedConversation(sessionId)) return true;

    // Already tracked?
    if (this.resolveConversationForSession(sessionId)) {
      return true;
    }

    // Codex: the rollout is known exactly. Before Codex writes it (its first
    // prompt) there is nothing to show: never fall back to the folder's Claude
    // transcripts (a Codex session showed an old Claude conversation, 2026-10-28).
    const codex = this.codexBySession.get(sessionId);
    if (codex) {
      this.processFileChange(codex.file, codex.convId, opts);
      return this.resolveConversationForSession(sessionId) !== null;
    }
    if (this.agentFor(sessionId).id !== DEFAULT_AGENT_ID) return false;
    // A session created moments ago has no transcript of its own yet; the
    // newest file in its folder belongs to an earlier session.
    if (this.newlyCreatedSessions.has(sessionId)) return false;

    // Need the encoded project path to find files on disk
    let encodedPath = this.tmuxPathBySession.get(sessionId);

    if (encodedPath?.startsWith(CODEX_KEY)) return false;

    // For persisted inactive sessions, derive encoded path from conversationPath
    if (!encodedPath) {
      const snap = this.persistedSessions.get(sessionId);
      if (snap?.conversationPath) {
        encodedPath = this.claudeKeyOfFile(snap.conversationPath) || undefined;
      }
    }
    if (!encodedPath) return false;

    const projectDir = this.projectDirForKey(encodedPath);
    if (!projectDir || !fs.existsSync(projectDir)) return false;

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
   * Safety net for a missed 'add' event with native watching: look for
   * recently written transcripts in the TAGGED sessions' project dirs that we
   * do not track yet and feed them to handleFileChange (which applies the
   * usual filters). Async, bounded, at most one run at a time.
   */
  private async scanForMissedTranscripts(): Promise<void> {
    if (this.missedScanRunning || !this.watcher) return;
    this.missedScanRunning = true;
    try {
      for (const encoded of [...this.tmuxProjectPaths]) {
        if (encoded.startsWith(CODEX_KEY)) continue; // Codex rollouts are watched one by one
        const dir = this.projectDirForKey(encoded);
        if (!dir) continue;
        let names: string[];
        try {
          names = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
        } catch {
          continue;
        }
        if (names.length > SessionWatcher.MISSED_SCAN_MAX_FILES) continue;
        for (const name of names) {
          const convId = name.slice(0, -'.jsonl'.length);
          const tracked = this.conversations.get(convId);
          if (tracked) continue; // tracked files: reconcileTrackedConversations
          const file = path.join(dir, name);
          try {
            const st = await fs.promises.stat(file);
            if (Date.now() - st.mtimeMs <= INITIAL_FILE_MAX_AGE_MS) this.handleFileChange(file);
          } catch {
            /* gone */
          }
        }
      }
    } finally {
      this.missedScanRunning = false;
    }
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

  /** Messages of a transcript via the shared incremental cache ([] when unreadable). */
  private readMessagesSync(filePath: string): ConversationMessage[] {
    return transcriptCache.getSync(filePath)?.messages() ?? [];
  }

  getMessages(sessionId?: string): ConversationMessage[] {
    if (sessionId) this.loadMappedConversation(sessionId);
    const targetId = this.resolveToConversationId(sessionId);
    if (!targetId) return [];

    const tracked = this.conversations.get(targetId);
    if (!tracked) return [];

    // Check if file has been modified since our cache (catches race with debounce)
    if (tracked.cachedMessages) {
      try {
        const currentMtime = fs.statSync(tracked.path).mtimeMs;
        if (currentMtime > tracked.lastModified) {
          // File changed since cache — catch up (reads only the new bytes)
          const messages = this.readMessagesSync(tracked.path);
          tracked.cachedMessages = messages;
          tracked.lastModified = currentMtime;
          return messages;
        }
      } catch {
        // stat failed, use cache
      }
      return tracked.cachedMessages;
    }
    return this.readMessagesSync(tracked.path);
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
    if (sessionId) this.loadMappedConversation(sessionId);
    const targetId = this.resolveToConversationId(sessionId);
    if (!targetId) return [];

    const tracked = this.conversations.get(targetId);
    if (!tracked) return this.getMessages(sessionId);

    try {
      const messages = this.readMessagesSync(tracked.path);
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
          (tc) => tc.status === 'pending' && isInteractiveTool(tc.name, this.agent.tools)
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

  setBackgroundWork(monitor: BackgroundWorkMonitor | null): void {
    this.bgWork = monitor;
  }

  /**
   * Effective waiting state of a session for clients and notifications: the
   * transcript's flag, except a main thread idle while its background agents /
   * shells run (or a tool running in bypass mode) is working (background-work.ts).
   */
  sessionOverlay(sessionId: string, waiting: boolean, currentActivity?: string): SessionOverlay {
    if (!this.bgWork) return { waiting };
    if (!waiting) return this.bgWork.overlay(sessionId, false, null, currentActivity);
    const targetId = this.resolveToConversationId(sessionId);
    const tracked = targetId ? this.conversations.get(targetId) : undefined;
    return this.bgWork.overlay(sessionId, waiting, tracked?.cachedMessages, currentActivity);
  }

  /**
   * A pane-only approval box (Codex's edit approval writes nothing to the
   * rollout until answered) appeared or went away on a capture that was taken
   * anyway (BackgroundWorkMonitor.noteCapture). While the transcript says the
   * session is working, tell clients it waits (and refetch the live choice),
   * then back to working once the box is gone. A transcript that already says
   * waiting has emitted its own status.
   */
  notePaneApproval(sessionId: string, up: boolean): void {
    const targetId = this.resolveToConversationId(sessionId);
    const tracked = targetId ? this.conversations.get(targetId) : undefined;
    if (!tracked || tracked.isWaitingForInput) return;
    const messages = tracked.cachedMessages || [];
    const agent = this.agentForFile(tracked.path);
    console.log(
      `Watcher: pane approval box ${up ? 'up' : 'gone'} for "${sessionId}" (transcript says working)`
    );
    const lastMessage = messages[messages.length - 1];
    this.emit('status-change', {
      sessionId,
      isWaitingForInput: up,
      currentActivity: up
        ? PANE_APPROVAL_ACTIVITY
        : agent.transcript.detectCurrentActivity(messages),
      lastMessage,
    });
    this.emit('conversation-update', { sessionId });
    if (sessionId !== this.activeTmuxSession) {
      this.emit('other-session-activity', {
        sessionId,
        projectPath: tracked.projectPath,
        sessionName: sessionId,
        isWaitingForInput: up,
        lastMessage,
        newMessageCount: 0,
      });
    }
  }

  /** get_status as clients see it: getStatus with the background-work overlay applied. */
  getClientStatus(sessionId?: string): SessionStatus {
    const status = this.getStatus(sessionId);
    const id = sessionId || this.activeTmuxSession || undefined;
    if (!id) return status;
    if (this.startupPrompts.has(id)) return status;
    if (!status.isWaitingForInput) {
      // An approval box only the pane shows (Codex edits) is a wait.
      const up = this.sessionOverlay(id, false, status.currentActivity);
      return up.waiting
        ? { ...status, isWaitingForInput: true, currentActivity: up.currentActivity }
        : status;
    }
    const o = this.sessionOverlay(id, true, status.currentActivity);
    if (o.waiting) return status;
    return {
      ...status,
      isWaitingForInput: false,
      currentActivity: o.currentActivity ?? status.currentActivity,
      ...(o.backgroundWork ? { backgroundWork: o.backgroundWork } : {}),
    };
  }

  getStatus(sessionId?: string): SessionStatus {
    // The agent's trust prompt is up (start-up, no turn yet): it waits on the user.
    const trust = sessionId ? this.startupPrompts.get(sessionId) : undefined;
    if (trust) {
      return {
        isRunning: true,
        isWaitingForInput: true,
        lastActivity: trust.since,
        projectPath: this.tmuxSessionWorkingDirs.get(sessionId!) || undefined,
        currentActivity: startupActivity(trust.choice),
      };
    }
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
    const messages = tracked.cachedMessages || this.readMessagesSync(tracked.path);
    const lastMessage = messages[messages.length - 1];

    // Determine if this session has a feedback prompt
    // sessionId here is a tmux session name; feedbackSessionId is also a tmux session name
    const feedbackPrompt =
      sessionId && this.feedbackSessionId === sessionId ? this.feedbackPrompt : undefined;

    return {
      isRunning: true,
      isWaitingForInput: tracked.isWaitingForInput,
      lastActivity: lastMessage?.timestamp || 0,
      conversationId: tracked.path,
      projectPath: tracked.projectPath,
      currentActivity: this.agentForFile(tracked.path).transcript.detectCurrentActivity(messages),
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
        ...this.profileFields(tmuxName),
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
          ...this.snapProfileFields(snap),
        });
        seenIds.add(id);
      }
    }

    // Sort by last activity (most recent first)
    sessions.sort((a, b) => b.lastActivity - a.lastActivity);

    return sessions;
  }

  /** `profileId` + `profileLabel` of a live session under a non-default profile ({} otherwise). */
  private profileFields(sessionId: string): { profileId?: string; profileLabel?: string } {
    if (!this.tmuxPathBySession.has(sessionId)) return {};
    const p = this.profileFor(sessionId);
    return p.isDefault ? {} : { profileId: p.id, profileLabel: p.label };
  }

  private snapProfileFields(snap: PersistedSessionSnapshot): {
    profileId?: string;
    profileLabel?: string;
  } {
    const p = this.profiles.get(snap.profileId);
    return p && !p.isDefault ? { profileId: p.id, profileLabel: p.label } : {};
  }

  getSessions(): TmuxSession[] {
    return this.getSessionsInternal(false);
  }

  /**
   * Wait up to `timeoutMs` for a JSONL conversation to be resolved for the given cwd.
   * Returns the JSONL UUID (conversation id) or null if none appeared in time.
   * Used by remote_dispatch_spawn to surface the session id of a freshly spawned Claude.
   */
  waitForSessionInCwd(
    cwd: string,
    timeoutMs: number,
    agent: AgentId = DEFAULT_AGENT_ID
  ): Promise<string | null> {
    const normalizedCwd = cwd.replace(/\/+$/, '');

    const findExisting = (): string | null => {
      let best: { id: string; lastModified: number } | null = null;
      for (const [id, conv] of this.conversations) {
        // Only the agent's own transcripts (a Codex rollout is never a Claude session).
        if (isCodexRollout(conv.path) !== (agent === 'codex')) continue;
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

    // 2. Fall back to newest conversation of the session's agent whose
    //    projectPath matches cwd (never another agent's transcript).
    const normalizedCwd = cwd.replace(/\/+$/, '');
    const codex = this.agentFor(tmuxSessionName).id === 'codex';
    let best: { id: string; lastModified: number } | null = null;
    for (const [id, conv] of this.conversations) {
      if (isCodexRollout(conv.path) !== codex) continue;
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
    const messages = best.conv.cachedMessages || this.readMessagesSync(best.conv.path);
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
      currentActivity: this.agentForFile(best.conv.path).transcript.detectCurrentActivity(messages),
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

  /** First entry time of a transcript (cached once known). */
  private transcriptStart(filePath: string): number | null {
    const cached = this.transcriptStartCache.get(filePath);
    if (cached !== undefined) return cached;
    const ms = transcriptStartMs(filePath);
    if (ms !== null) this.transcriptStartCache.set(filePath, ms);
    return ms;
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

    // Resolve each history ID to a file path
    let encodedPath = this.tmuxPathBySession.get(sessionId);
    if (!encodedPath) {
      // Derive from persisted session snapshot
      const snap = this.persistedSessions.get(sessionId);
      if (snap?.conversationPath) {
        encodedPath = this.claudeKeyOfFile(snap.conversationPath) || undefined;
      }
    }
    const projectDir = encodedPath ? this.projectDirForKey(encodedPath) : null;

    const entries: ChainEntry[] = [];
    const current = this.tmuxConversationIds.get(sessionId);
    const ids = current && !history.includes(current) ? [...history, current] : history;
    for (const id of ids) {
      let filePath: string | undefined = this.conversations.get(id)?.path;
      if (!filePath && projectDir) {
        const candidate = path.join(projectDir, `${id}.jsonl`);
        if (fs.existsSync(candidate)) filePath = candidate;
      }
      if (!filePath) continue;
      entries.push({ id, path: filePath, startMs: this.transcriptStart(filePath) });
    }

    // Oldest first by each file's first entry, the live conversation last.
    const chain = orderConversationChain(entries, current, 20);
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

    const messages = resolved.conv.cachedMessages || this.readMessagesSync(resolved.conv.path);
    const pendingTools = this.agentForFile(resolved.conv.path).transcript.getPendingApprovalTools(
      messages
    );
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
      backgroundWork?: BackgroundWork;
      /** The coding agent in the session when it is not Claude Code (optional). */
      agent?: AgentId;
      /** Account profile when it is not the agent's default (optional). */
      profileId?: string;
      profileLabel?: string;
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
      backgroundWork?: BackgroundWork;
      /** The coding agent in the session when it is not Claude Code (optional). */
      agent?: AgentId;
      /** Account profile when it is not the agent's default (optional). */
      profileId?: string;
      profileLabel?: string;
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
      let backgroundWork: BackgroundWork | undefined;

      const trust = this.startupPrompts.get(ts.name);
      if (trust) {
        status = 'waiting';
        waitingCount++;
        currentActivity = startupActivity(trust.choice);
        lastActivity = trust.since;
      } else if (best) {
        const conv = best.conv;
        projectPath = conv.projectPath;
        lastActivity = conv.lastModified;
        taskSummary = conv.cachedTaskSummary;

        // Use cached messages for activity detection instead of re-reading large files
        const messages = conv.cachedMessages;
        const convAgent = this.agentForFile(conv.path);
        currentActivity = messages
          ? convAgent.transcript.detectCurrentActivity(messages)
          : convAgent === this.agent
            ? detectCurrentActivityFast(conv.path)
            : undefined;

        // Main thread idle while its background agents / shells run (or a tool
        // running in bypass mode): working, never waiting (background-work.ts).
        const overlay = this.bgWork
          ? this.bgWork.overlay(ts.name, conv.isWaitingForInput, messages, currentActivity)
          : { waiting: conv.isWaitingForInput };
        if (overlay.currentActivity) currentActivity = overlay.currentActivity;
        if (overlay.backgroundWork) backgroundWork = overlay.backgroundWork;

        if (overlay.waiting) {
          status = 'waiting';
          waitingCount++;
        } else if (currentActivity) {
          status = 'working';
          workingCount++;
        }

        // Extract recent message timestamps for sparkline (last 30 min)
        if (messages) {
          const cutoff = Date.now() - 30 * 60 * 1000;
          recentTimestamps = messages.filter((m) => m.timestamp >= cutoff).map((m) => m.timestamp);
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
        ...(backgroundWork ? { backgroundWork } : {}),
        ...(this.agentFor(ts.name).id !== DEFAULT_AGENT_ID
          ? { agent: this.agentFor(ts.name).id }
          : {}),
        ...this.profileFields(ts.name),
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
        ...this.snapProfileFields(snap),
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
