import type { HeraldConfigBlock } from './herald/config';
export interface OriginCredential {
  origin: string;
  token: string;
  label?: string;
  capabilities?: { exec?: boolean; dispatch?: boolean; write?: boolean };
  disabled?: boolean;
}

export interface RemoteCapabilitiesConfig {
  enabled: boolean;
  exec?: { enabled: boolean; commandAllowlist?: string[] | null };
  dispatch?: { enabled: boolean };
  write?: { enabled: boolean; roots: string[] };
  requireLoopbackOrTls?: boolean;
  allowedOrigins?: string[];
  origins?: OriginCredential[];
}

export interface ListenerConfig {
  port: number;
  token: string;
  tls?: boolean;
  certPath?: string;
  keyPath?: string;
  remoteCapabilities?: RemoteCapabilitiesConfig;
}

export interface DaemonConfig {
  // Legacy single-listener fields (for backward compatibility)
  port?: number;
  token?: string;
  tls?: boolean;
  certPath?: string;
  keyPath?: string;
  // New multi-listener support
  listeners: ListenerConfig[];
  // Other config
  tmuxSession: string;
  codeHome: string;
  mdnsEnabled: boolean;
  fcmCredentialsPath?: string;
  pushDelayMs: number;
  autoApproveTools: string[];
  git: boolean;
  // Anthropic Admin API key for fetching organization usage (sk-ant-admin-...)
  anthropicAdminApiKey?: string;
  // Additional allowed paths for file access (merged with defaults: homeDir, /tmp, /var/tmp)
  allowedPaths?: string[];
  // Override for the concierge directory (containing .mcp.json.template). If unset,
  // the daemon walks up from its install dir to find <repo>/concierge.
  concierge_dir?: string;
  // Herald conversational front layer (raw snake_case block; see herald/config.ts).
  herald?: HeraldConfigBlock;
  // Display name (mDNS, pairing). Default: "Companion on <hostname>".
  name?: string;
  // Device pairing (pairing/manager.ts). Default on; code pairing only from
  // loopback / LAN / tailnet unless pairingAllowPublic.
  pairing?: boolean;
  pairingAllowPublic?: boolean;
  // First-run wizard (setup/). false = setup mode; absent = an existing install (complete).
  setupComplete?: boolean;
  // Folders new sessions may start in (absolute; set by the setup wizard).
  projectRoots?: string[];
}

export interface FeedbackOption {
  key: string; // "0", "1", "2", "3"
  label: string; // "Dismiss", "Bad", "Fine", "Good"
}

export interface FeedbackPrompt {
  question: string;
  options: FeedbackOption[];
}

export interface QuestionOption {
  label: string;
  description: string;
  /** For multi-select (checkbox) prompts: whether this option is currently checked
   *  in the live terminal capture. Undefined for single-select prompts. */
  selected?: boolean;
}

/**
 * A multiple-choice selector detected in raw terminal output (e.g. Claude Code's
 * "❯ 1. Yes / 2. No" box). Surfaced to the client so it can render tappable options
 * in terminal mode. Only sent when the prompt is currently active near the tail of
 * the captured pane.
 */
export interface TerminalChoicePrompt {
  question: string;
  /** Short title/header rendered above the question, when one is detectable. */
  header?: string;
  options: { label: string; description?: string; selected?: boolean }[];
  /** True when the selector is a multi-select (checkbox) list, e.g. an AskUserQuestion
   *  multiSelect question. Drives how the response is injected (toggles + submit). */
  multiSelect?: boolean;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface ConversationMessage {
  id: string;
  type: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  options?: QuestionOption[];
  questions?: Question[];
  isWaitingForChoice?: boolean;
  multiSelect?: boolean;
  isCompaction?: boolean;
  skillName?: string; // User message is an expanded skill invocation (e.g., "todo", "apk")
  /** Assistant entries: the API stop_reason the CLI recorded (end_turn, tool_use, ...). */
  stopReason?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  startedAt?: number;
  completedAt?: number;
  /** The tool_result was flagged is_error (non-zero exit, tool error). Status is then 'error'. */
  isError?: boolean;
}

export interface ConversationHighlight {
  id: string;
  type: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  options?: QuestionOption[];
  questions?: Question[];
  isWaitingForChoice?: boolean;
  multiSelect?: boolean;
  toolCalls?: ToolCall[];
  isCompaction?: boolean;
  skillName?: string;
  /** System marker for a slash command the user ran directly in the CLI
   *  (e.g. "/login"), not sent to the model. Content is the marker text. */
  localCommand?: { name: string; args?: string; output?: string; isError?: boolean };
  /** True when this highlight was synthesized from a live terminal capture (e.g. an
   *  active AskUserQuestion selector) rather than parsed from JSONL. */
  liveSourced?: boolean;
}

export interface ActivityDetail {
  summary: string;
  toolName?: string;
  input?: string;
  output?: string;
  timestamp: number;
}

export interface SessionStatus {
  isRunning: boolean;
  isWaitingForInput: boolean;
  lastActivity: number;
  conversationId?: string;
  projectPath?: string;
  currentActivity?: string;
  recentActivity?: ActivityDetail[];
  feedbackPrompt?: FeedbackPrompt;
}

export interface TmuxSession {
  id: string;
  name: string;
  projectPath?: string;
  conversationPath?: string;
  lastActivity: number;
  isWaitingForInput: boolean;
  messageCount: number;
  /** True when the session was restored from a persisted snapshot but is no longer in tmux. */
  inactive?: boolean;
}

export interface WebSocketMessage {
  type: string;
  token?: string;
  payload?: unknown;
  requestId?: string;
}

export interface WebSocketResponse {
  type: string;
  success: boolean;
  payload?: unknown;
  error?: string;
  requestId?: string;
  sessionId?: string; // Session context for validation
  isLocal?: boolean; // Whether connection is from localhost (sent in auth response)
  gitEnabled?: boolean; // Whether git integration is enabled (sent in auth response)
  scope?: 'full' | 'trigger'; // Auth response: 'trigger' = the Herald trigger token (triggers only)
  authKind?: 'device' | 'legacy'; // Auth response: paired-device token or the legacy listener token
  deviceId?: string; // Auth response (device tokens): the paired device id
  daemonId?: string; // Auth response: the daemon's stable public id
  daemonName?: string; // Auth response: the daemon's display name
}

export interface RegisteredDevice {
  token: string;
  deviceId: string;
  registeredAt: number;
  lastSeen: number;
}

export interface ConversationFile {
  path: string;
  projectPath: string;
  lastModified: number;
}

// Stored tmux session config for recreation
export interface TmuxSessionConfig {
  name: string;
  workingDir: string;
  startCli: boolean;
  lastUsed: number;
  // Git worktree metadata (set when session was created via worktree)
  isWorktree?: boolean;
  mainRepoDir?: string;
  branch?: string;
}

// Dashboard types
export interface SessionSummary {
  id: string; // tmux session name (not JSONL UUID)
  name: string;
  projectPath: string;
  status: 'idle' | 'working' | 'waiting' | 'error';
  lastActivity: number;
  currentActivity?: string;
  tmuxSessionName?: string;
}

export interface ServerSummary {
  sessions: SessionSummary[];
  totalSessions: number;
  waitingCount: number;
  workingCount: number;
}

// Usage tracking types
export interface SessionUsage {
  sessionId: string;
  sessionName: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  messageCount: number;
  // Current context window size (from most recent message)
  currentContextTokens: number;
}

export interface UsageStats {
  sessions: SessionUsage[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  periodStart: number;
  periodEnd: number;
}

// Sub-agent tracking types
export interface SubAgent {
  agentId: string;
  slug: string;
  sessionId: string;
  status: 'running' | 'completed' | 'error';
  startedAt: number;
  completedAt?: number;
  description?: string;
  subagentType?: string;
  messageCount: number;
  lastActivity: number;
  currentActivity?: string;
}

export interface AgentTree {
  sessionId: string;
  agents: SubAgent[];
  totalAgents: number;
  runningCount: number;
  completedCount: number;
}

// OAuth Usage Dashboard types
export interface OAuthUsageWindow {
  utilization: number;
  resets_at: string;
}

export interface OAuthExtraUsage {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number | null;
  utilization: number | null;
}

export interface UsageDashboardData {
  available: boolean;
  subscriptionType?: string;
  rateLimitTier?: string;
  fiveHour?: OAuthUsageWindow | null;
  sevenDay?: OAuthUsageWindow | null;
  sevenDayOpus?: OAuthUsageWindow | null;
  sevenDaySonnet?: OAuthUsageWindow | null;
  sevenDayCowork?: OAuthUsageWindow | null;
  extraUsage?: OAuthExtraUsage | null;
}

// Notification event types (no longer includes text_match)
export type NotificationEventType =
  | 'waiting_for_input'
  | 'error_detected'
  | 'session_completed'
  | 'worker_waiting'
  | 'worker_error'
  | 'work_group_ready'
  | 'usage_warning';

// Escalation config — replaces NotificationRule system
export interface EscalationConfig {
  events: {
    waiting_for_input: boolean;
    error_detected: boolean;
    session_completed: boolean;
    worker_waiting: boolean;
    worker_error: boolean;
    work_group_ready: boolean;
    usage_warning: boolean;
  };
  pushDelaySeconds: number; // default: 300 (5 min). 0 = immediate push
  rateLimitSeconds: number; // default: 60. Min time between notifs per session
  quietHours: {
    enabled: boolean;
    start: string; // "HH:MM"
    end: string; // "HH:MM"
  };
  usageThresholds: number[]; // default: [50, 75, 90]. Utilization % thresholds for warnings
}

export const DEFAULT_ESCALATION_CONFIG: EscalationConfig = {
  events: {
    waiting_for_input: true,
    error_detected: true,
    session_completed: false,
    worker_waiting: true,
    worker_error: true,
    work_group_ready: true,
    usage_warning: true,
  },
  pushDelaySeconds: 300,
  rateLimitSeconds: 60,
  quietHours: {
    enabled: false,
    start: '22:00',
    end: '08:00',
  },
  usageThresholds: [50, 75, 90],
};

// Pending event — tracks an unacknowledged notification awaiting push escalation
export interface PendingEvent {
  id: string;
  sessionId: string;
  sessionName: string;
  eventType: NotificationEventType;
  preview: string;
  createdAt: number;
  pushScheduledAt: number; // createdAt + pushDelaySeconds*1000
  pushSent: boolean;
  acknowledgedAt?: number;
}

export interface NotificationHistoryEntry {
  id: string;
  timestamp: number;
  eventType: NotificationEventType;
  sessionId?: string;
  sessionName?: string;
  preview: string;
  tier: 'browser' | 'push' | 'both';
  acknowledged: boolean;
}

export interface PersistedNotificationState {
  escalation: EscalationConfig;
  devices: RegisteredDevice[];
  mutedSessions: string[];
}

// Archive types for compacted conversations
export interface CompactionEvent {
  sessionId: string;
  sessionName: string;
  projectPath: string;
  summary: string;
  timestamp: number;
}

// Task tracking types (from TaskCreate/TaskUpdate tools)
export interface TaskItem {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
  owner?: string;
  blockedBy?: string[];
  blocks?: string[];
  createdAt: number;
  updatedAt: number;
}

// Code review types (file changes extracted from session)
/** @deprecated Legacy get_session_diff shape; use the review protocol (ReviewEdit / ReviewFileChange). */
export interface FileChange {
  path: string;
  action: 'write' | 'edit';
  timestamp: number;
}

// Work Group types (parallel /work orchestration)
export interface WorkerQuestion {
  text: string;
  options?: { label: string }[];
  timestamp: number;
}

export interface WorkerSession {
  id: string;
  sessionId: string; // Conversation session ID (encoded path)
  tmuxSessionName: string;
  taskSlug: string;
  taskDescription: string;
  branch: string; // Git branch: parallel/<slug>
  worktreePath: string; // Absolute path to worktree directory
  status: 'spawning' | 'working' | 'waiting' | 'completed' | 'error';
  commits: string[];
  startedAt: number;
  completedAt?: number;
  lastActivity?: string; // Current activity text
  lastQuestion?: WorkerQuestion;
  error?: string;
}

export interface WorkGroup {
  id: string;
  name: string;
  foremanSessionId: string;
  foremanTmuxSession: string;
  status: 'active' | 'merging' | 'completed' | 'failed' | 'cancelled';
  workers: WorkerSession[];
  createdAt: number;
  completedAt?: number;
  planFile?: string;
  mergeCommit?: string;
  error?: string;
}

export * from './review/protocol';
