export interface DaemonConfig {
  port: number;
  token: string;
  tls: boolean;
  certPath?: string;
  keyPath?: string;
  tmuxSession: string;
  codeHome: string;
  mdnsEnabled: boolean;
  fcmCredentialsPath?: string;
  pushDelayMs: number;
  autoApproveTools: string[];
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
  type: 'user' | 'assistant';
  content: string;
  timestamp: number;
  options?: QuestionOption[];
  questions?: Question[];
  isWaitingForChoice?: boolean;
  multiSelect?: boolean;
  toolCalls?: ToolCall[];
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
}

// Dashboard types
export interface SessionSummary {
  id: string;
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
  byModel: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  }>;
  // Estimated cost in USD (rough calculation)
  estimatedCostUsd: number;
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

// Notification event types (no longer includes text_match)
export type NotificationEventType = 'waiting_for_input' | 'error_detected' | 'session_completed';

// Escalation config — replaces NotificationRule system
export interface EscalationConfig {
  events: {
    waiting_for_input: boolean;
    error_detected: boolean;
    session_completed: boolean;
  };
  pushDelaySeconds: number;      // default: 300 (5 min). 0 = immediate push
  rateLimitSeconds: number;      // default: 60. Min time between notifs per session
  quietHours: {
    enabled: boolean;
    start: string; // "HH:MM"
    end: string;   // "HH:MM"
  };
}

export const DEFAULT_ESCALATION_CONFIG: EscalationConfig = {
  events: {
    waiting_for_input: true,
    error_detected: true,
    session_completed: false,
  },
  pushDelaySeconds: 300,
  rateLimitSeconds: 60,
  quietHours: {
    enabled: false,
    start: '22:00',
    end: '08:00',
  },
};

// Pending event — tracks an unacknowledged notification awaiting push escalation
export interface PendingEvent {
  id: string;
  sessionId: string;
  sessionName: string;
  eventType: NotificationEventType;
  preview: string;
  createdAt: number;
  pushScheduledAt: number;  // createdAt + pushDelaySeconds*1000
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
