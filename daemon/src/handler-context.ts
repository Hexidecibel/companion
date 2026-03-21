import { WebSocket } from 'ws';
import { SessionWatcher } from './watcher';
import { InputInjector } from './input-injector';
import { PushNotificationService } from './push';
import { TmuxManager } from './tmux-manager';
import { EscalationService } from './escalation';
import { WorkGroupManager } from './work-group-manager';
import { SkillCatalog } from './skill-catalog';
import { UsageTracker } from './usage-tracker';
import { OAuthUsageFetcher } from './oauth-usage';
import { SessionNameStore } from './session-names';
import { SubAgentWatcher } from './subagent-watcher';
import { DaemonConfig, TmuxSessionConfig, WebSocketResponse } from './types';

export interface AuthenticatedClient {
  id: string;
  ws: WebSocket;
  authenticated: boolean;
  deviceId?: string;
  subscribed: boolean;
  subscribedSessionId?: string;
  listenerPort?: number;
  isLocal: boolean;
  lastPongTime: number;
}

export interface ClientError {
  message: string;
  stack?: string;
  componentStack?: string;
  timestamp: number;
  deviceId?: string;
}

export type MessageHandler = (
  client: AuthenticatedClient,
  payload: any,
  requestId?: string
) => Promise<void> | void;

export interface HandlerContext {
  // Service dependencies
  watcher: SessionWatcher;
  injector: InputInjector;
  push: PushNotificationService;
  tmux: TmuxManager;
  escalation: EscalationService;
  workGroupManager: WorkGroupManager | null;
  skillCatalog: SkillCatalog;
  usageTracker: UsageTracker;
  oauthUsageFetcher: OAuthUsageFetcher;
  sessionNameStore: SessionNameStore;
  subAgentWatcher: SubAgentWatcher | null;
  config: DaemonConfig;

  // Helper methods from WebSocketServer
  send: (ws: WebSocket, response: WebSocketResponse) => void;
  broadcast: (type: string, payload: unknown, sessionId?: string) => void;

  // Shared state
  clients: Map<string, AuthenticatedClient>;
  autoApproveSessions: Set<string>;
  pendingSentMessages: Map<string, Array<{ clientMessageId: string; content: string; sentAt: number }>>;
  tmuxSessionConfigs: Map<string, TmuxSessionConfig>;
  clientErrors: ClientError[];
  scrollLogs: Array<{ event: string; ts: number; [key: string]: unknown }>;

  // Shared helper methods
  storeTmuxSessionConfig: (name: string, workingDir: string, startCli?: boolean) => void;
  saveTmuxSessionConfigs: () => void;
  getProjectRoot: (sessionId?: string) => string | null;

  // Constants from class
  PENDING_SENT_TTL: number;
  MAX_CLIENT_ERRORS: number;
  MAX_SCROLL_LOGS: number;
}
