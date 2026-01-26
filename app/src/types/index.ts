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
}

export interface SessionStatus {
  isRunning: boolean;
  isWaitingForInput: boolean;
  lastActivity: number;
  conversationId?: string;
  projectPath?: string;
  currentActivity?: string;
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
