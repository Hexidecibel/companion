export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  token: string;
  useTls: boolean;
  enabled?: boolean;
  sshUser?: string;
}

export interface ConnectionState {
  status: 'disconnected' | 'connecting' | 'connected' | 'error' | 'reconnecting';
  error?: string;
  lastConnected?: number;
  reconnectAttempts: number;
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
  sessionId?: string;
}

// Conversation types

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

// Session types

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

// Task types

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

export interface TaskSummary {
  tasks: TaskItem[];
  totalCount: number;
  completedCount: number;
  inProgressCount: number;
  pendingCount: number;
}

// Sub-agent types

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

// Tmux types

export interface TmuxSessionInfo {
  name: string;
  created: number;
  attached: boolean;
  windows: number;
  workingDir?: string;
  tagged?: boolean;
}

// Pending image for upload
export interface PendingImage {
  id: string;
  file: File;
  previewUrl: string;
}

// Work Group types (parallel /work orchestration)

// Scaffold/New Project types
export interface StackTemplate {
  id: string;
  name: string;
  description: string;
  type: 'frontend' | 'backend' | 'fullstack' | 'library' | 'cli';
  icon: string;
  tags: string[];
  score?: number;
  matchedKeywords?: string[];
}

export interface ProjectConfig {
  name: string;
  description: string;
  location: string;
  stackId: string;
  options: {
    initGit: boolean;
    createGitHubRepo: boolean;
    privateRepo: boolean;
    includeDocker: boolean;
    includeCI: boolean;
    includeLinter: boolean;
  };
}

export interface ScaffoldProgress {
  step: string;
  detail?: string;
  progress: number;
  complete: boolean;
  error?: string;
}

export interface ScaffoldResult {
  success: boolean;
  projectPath: string;
  filesCreated: string[];
  error?: string;
}

export interface WorkerQuestion {
  text: string;
  options?: { label: string }[];
  timestamp: number;
}

export interface WorkerSession {
  id: string;
  sessionId: string;
  tmuxSessionName: string;
  taskSlug: string;
  taskDescription: string;
  branch: string;
  worktreePath: string;
  status: 'spawning' | 'working' | 'waiting' | 'completed' | 'error';
  commits: string[];
  startedAt: number;
  completedAt?: number;
  lastActivity?: string;
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

// Active session tracking

export interface ActiveSession {
  serverId: string;
  sessionId: string;
}
