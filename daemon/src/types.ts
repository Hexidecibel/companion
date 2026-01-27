export interface DaemonConfig {
  port: number;
  token: string;
  tls: boolean;
  certPath?: string;
  keyPath?: string;
  tmuxSession: string;
  claudeHome: string;
  mdnsEnabled: boolean;
  fcmCredentialsPath?: string;
  pushDelayMs: number;
  autoApproveTools: string[];
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface ConversationMessage {
  id: string;
  type: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  options?: QuestionOption[];
  isWaitingForChoice?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  status: 'pending' | 'completed' | 'error';
}

export interface ConversationHighlight {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  timestamp: number;
  options?: QuestionOption[];
  isWaitingForChoice?: boolean;
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
  startClaude: boolean;
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
}

export interface ServerSummary {
  sessions: SessionSummary[];
  totalSessions: number;
  waitingCount: number;
  workingCount: number;
}
