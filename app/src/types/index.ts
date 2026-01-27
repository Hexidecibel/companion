export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  token: string;
  useTls: boolean;
  isDefault?: boolean;
}

export interface ConnectionState {
  status: 'disconnected' | 'connecting' | 'connected' | 'error' | 'reconnecting';
  error?: string;
  lastConnected?: number;
  reconnectAttempts: number;
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

export interface DiscoveredServer {
  name: string;
  host: string;
  port: number;
  tls: boolean;
}

export type ViewMode = 'highlights' | 'full';

// Tmux session management types
export interface TmuxSessionInfo {
  name: string;
  created: number;
  attached: boolean;
  windows: number;
  workingDir?: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface OtherSessionActivity {
  sessionId: string;
  sessionName: string;
  projectPath: string;
  isWaitingForInput: boolean;
  newMessageCount: number;
  lastMessage?: ConversationMessage;
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

export interface ServerStatus {
  serverId: string;
  serverName: string;
  connected: boolean;
  connecting: boolean;
  error?: string;
  summary?: ServerSummary;
  lastUpdated: number;
}

// Tmux session missing state (for recreation)
export interface TmuxSessionMissing {
  sessionName: string;
  canRecreate: boolean;
  savedConfig?: {
    name: string;
    workingDir: string;
  };
}
