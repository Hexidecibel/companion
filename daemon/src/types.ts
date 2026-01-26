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
