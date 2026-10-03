import { WebSocket } from 'ws';
import { SessionWatcher } from './watcher';
import { InputInjector } from './input-injector';
import { PushNotificationService } from './push';
import { TmuxManager } from './tmux-manager';
import { EscalationService } from './escalation';
import { WorkGroupManager } from './work-group-manager';
import { SkillCatalog } from './skill-catalog';
import { SessionNameStore } from './session-names';
import { SubAgentWatcher } from './subagent-watcher';
import { AuditLog } from './audit-log';
import { RateLimiter } from './rate-limiter';
import type { HeraldService } from './herald/service';
import type { HeraldVoiceService } from './herald/voice/service';
import type { HeraldTriggerService } from './herald/trigger';
import type { ReviewService } from './review/service';
import { DaemonConfig, OriginCredential, TmuxSessionConfig, WebSocketResponse } from './types';

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
  origin: string | null;
  /**
   * 'trigger': authenticated with the Herald trigger token; may only send
   * herald_trigger (and ping). Absent / 'full': the normal daemon token.
   */
  scope?: 'full' | 'trigger';
  /** scope 'trigger': which trigger token (name + digest), re-checked on every trigger. */
  triggerCredential?: { name: string; sha256: string };
  /** X-Forwarded-For of the upgrade request (set behind a reverse proxy). */
  forwardedFor?: string;
  // Set when the client authenticated against a per-origin credential
  // (remoteCapabilities.origins[]). Used to narrow capabilities per origin.
  originCredential?: OriginCredential;
  /** TCP peer address of the upgrade request. */
  remoteAddress?: string;
  /** Which credential authenticated this socket. */
  authKind?: 'device' | 'legacy' | 'origin' | 'trigger';
  /** authKind 'device': the paired device (devices.json id). */
  pairedDeviceId?: string;
  /** authKind 'device': per-device narrowing of remote exec / dispatch / write. */
  deviceCapabilities?: { exec?: boolean; dispatch?: boolean; write?: boolean };
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
  sessionNameStore: SessionNameStore;
  subAgentWatcher: SubAgentWatcher | null;
  auditLog: AuditLog;
  rateLimiter: RateLimiter;
  config: DaemonConfig;
  herald: HeraldService | null;
  heraldVoice: HeraldVoiceService | null;
  heraldTrigger: HeraldTriggerService | null;
  review: ReviewService | null;

  // Helper methods from WebSocketServer
  send: (ws: WebSocket, response: WebSocketResponse) => void;
  broadcast: (type: string, payload: unknown, sessionId?: string) => void;
  /** Push to one full-scope client; false when it is gone. */
  sendToClient: (clientId: string, type: string, payload: unknown) => boolean;
  requireRemoteCapability: (
    client: AuthenticatedClient,
    action: 'exec' | 'dispatch' | 'write'
  ) => string | null;

  // Shared state
  clients: Map<string, AuthenticatedClient>;
  autoApproveSessions: Set<string>;
  pendingSentMessages: Map<
    string,
    Array<{ clientMessageId: string; content: string; sentAt: number }>
  >;
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
