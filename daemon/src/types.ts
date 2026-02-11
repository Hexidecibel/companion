export interface ListenerConfig {
  port: number;
  token: string;
  tls?: boolean;
  certPath?: string;
  keyPath?: string;
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
}

export interface QuestionOption {
  label: string;
  description: string;
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
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  startedAt?: number;
  completedAt?: number;
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
}

export interface TmuxSession {
  id: string;
  name: string;
  projectPath?: string;
  conversationPath?: string;
  lastActivity: number;
  isWaitingForInput: boolean;
  messageCount: number;
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

// Anthropic API Usage types
export interface AnthropicUsageBucket {
  started_at: string;
  ended_at: string;
  model?: string;
  workspace_id?: string | null;
  api_key_id?: string | null;
  service_tier?: string;
  context_window?: string;
  uncached_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  web_search_requests?: number;
}

export interface AnthropicUsageResponse {
  data: AnthropicUsageBucket[];
  has_more: boolean;
  next_page?: string;
}

export interface ApiUsageStats {
  periodStart: string;
  periodEnd: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  byModel: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
    }
  >;
  // Estimated cost in USD (rough calculation)
  estimatedCostUsd: number;
}

// Cost Dashboard types
export interface DailyUsageBucket {
  date: string; // YYYY-MM-DD
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  estimatedCostUsd: number;
  byModel: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    costUsd: number;
  }>;
}

export interface CostDashboardData {
  daily: DailyUsageBucket[];
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  periodStart: string;
  periodEnd: string;
  hasAdminKey: boolean;
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
