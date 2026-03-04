import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage, Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

import { SessionWatcher } from './watcher';
import { InputInjector } from './input-injector';
import { PushNotificationService } from './push';
import { TmuxManager } from './tmux-manager';
import {
  WebSocketMessage,
  WebSocketResponse,
  DaemonConfig,
  TmuxSessionConfig,
  ListenerConfig,
} from './types';
import { loadConfig, saveConfig } from './config';
import { SubAgentWatcher } from './subagent-watcher';
import { WorkGroupManager } from './work-group-manager';
import { SkillCatalog } from './skill-catalog';
import { EscalationService, EscalationEvent } from './escalation';
import { NotificationEventType } from './types';
import { UsageTracker } from './usage-tracker';
import { OAuthUsageFetcher, UsageMonitor } from './oauth-usage';
import { SessionNameStore } from './session-names';

import { AuthenticatedClient, ClientError, HandlerContext, MessageHandler } from './handler-context';
import { registerAllHandlers } from './handlers';

// File for persisting tmux session configs
const TMUX_CONFIGS_FILE = path.join(os.homedir(), '.companion', 'tmux-sessions.json');

export class WebSocketHandler {
  private wssMap: Map<number, WebSocketServer> = new Map();
  private tokenMap: Map<number, string> = new Map();
  private clients: Map<string, AuthenticatedClient> = new Map();
  private watcher: SessionWatcher;
  private subAgentWatcher: SubAgentWatcher | null;
  private injector: InputInjector;
  private push: PushNotificationService;
  private tmux: TmuxManager;
  private tmuxSessionConfigs: Map<string, TmuxSessionConfig> = new Map();
  private config: DaemonConfig;
  private clientErrors: ClientError[] = [];
  private readonly MAX_CLIENT_ERRORS = 50;
  private scrollLogs: Array<{ event: string; ts: number; [key: string]: unknown }> = [];
  private readonly MAX_SCROLL_LOGS = 200;
  public autoApproveSessions: Set<string> = new Set();
  private pendingSentMessages: Map<
    string,
    Array<{
      clientMessageId: string;
      content: string;
      sentAt: number;
    }>
  > = new Map();
  private static readonly PENDING_SENT_TTL = 10 * 60 * 1000;
  private escalation: EscalationService;
  private workGroupManager: WorkGroupManager | null;
  private skillCatalog: SkillCatalog;
  private usageTracker: UsageTracker;
  private oauthUsageFetcher: OAuthUsageFetcher;
  private usageMonitor: UsageMonitor;
  private sessionNameStore: SessionNameStore;
  private handlers: Map<string, MessageHandler>;

  constructor(
    servers: { server: Server; listener: ListenerConfig }[],
    config: DaemonConfig,
    watcher: SessionWatcher,
    injector: InputInjector,
    push: PushNotificationService,
    tmux?: TmuxManager,
    subAgentWatcher?: SubAgentWatcher,
    workGroupManager?: WorkGroupManager
  ) {
    this.config = config;
    this.watcher = watcher;
    this.subAgentWatcher = subAgentWatcher || null;
    this.workGroupManager = workGroupManager || null;
    this.injector = injector;
    this.push = push;
    this.tmux = tmux || new TmuxManager('companion');

    this.escalation = new EscalationService(this.push.getStore(), this.push);
    this.skillCatalog = new SkillCatalog();
    this.usageTracker = new UsageTracker(config.anthropicAdminApiKey);
    this.sessionNameStore = new SessionNameStore(path.join(os.homedir(), '.companion'));
    this.oauthUsageFetcher = new OAuthUsageFetcher(config.codeHome);
    this.usageMonitor = new UsageMonitor(
      this.oauthUsageFetcher,
      this.push.getStore(),
      (event: EscalationEvent) => {
        const result = this.escalation.handleEvent(event);
        if (result.shouldBroadcast) {
          console.log(`Escalation: usage_warning broadcast — ${event.content}`);
        }
        this.broadcast('usage_warning', { message: event.content });
      }
    );
    this.usageMonitor.start();

    // Register all handler modules
    this.handlers = registerAllHandlers(this.createHandlerContext());

    // Create a WebSocketServer for each listener
    for (const { server, listener } of servers) {
      const wss = new WebSocketServer({ server });
      this.wssMap.set(listener.port, wss);
      this.tokenMap.set(listener.port, listener.token);
      wss.on('connection', (ws, req) => this.handleConnection(ws, req, listener.port));
      console.log(`WebSocket: Listener initialized on port ${listener.port}`);
    }

    // Forward watcher events to subscribed clients
    this.watcher.on('conversation-update', (data) => {
      this.broadcast('conversation_update', data, data.sessionId);
    });

    this.watcher.on('status-change', (data) => {
      this.broadcast('status_change', data, data.sessionId);

      if (data.isWaitingForInput && data.lastMessage) {
        const event: EscalationEvent = {
          eventType: 'waiting_for_input',
          sessionId: data.sessionId || 'unknown',
          sessionName: this.injector.getActiveSession() || 'unknown',
          content: data.lastMessage.content,
        };
        const result = this.escalation.handleEvent(event);
        if (result.shouldBroadcast) {
          console.log(`Escalation: waiting_for_input broadcast for session "${event.sessionName}"`);
        }
      } else if (!data.isWaitingForInput && data.sessionId) {
        this.escalation.acknowledgeSession(data.sessionId);
      }
    });

    this.watcher.on('other-session-activity', (data) => {
      this.broadcast('other_session_activity', data);
    });

    this.watcher.on('compaction', (data) => {
      this.broadcast('compaction', data);
    });

    const handleEscalationEvent = (
      eventType: NotificationEventType,
      data: { sessionId: string; sessionName: string; content: string }
    ) => {
      const event: EscalationEvent = {
        eventType,
        sessionId: data.sessionId,
        sessionName: data.sessionName,
        content: data.content,
      };
      const result = this.escalation.handleEvent(event);
      if (result.shouldBroadcast) {
        console.log(`Escalation: ${eventType} broadcast for session "${data.sessionName}"`);
      }
      this.broadcast(eventType, data);
    };

    this.watcher.on('error-detected', (data) => handleEscalationEvent('error_detected', data));
    this.watcher.on('session-completed', (data) =>
      handleEscalationEvent('session_completed', data)
    );

    if (this.workGroupManager) {
      this.workGroupManager.on('work-group-update', (group) => {
        this.broadcast('work_group_update', group);
      });
    }

    this.loadTmuxSessionConfigs();

    console.log('WebSocket: Server initialized');
  }

  private createHandlerContext(): HandlerContext {
    return {
      watcher: this.watcher,
      injector: this.injector,
      push: this.push,
      tmux: this.tmux,
      escalation: this.escalation,
      workGroupManager: this.workGroupManager,
      skillCatalog: this.skillCatalog,
      usageTracker: this.usageTracker,
      oauthUsageFetcher: this.oauthUsageFetcher,
      sessionNameStore: this.sessionNameStore,
      subAgentWatcher: this.subAgentWatcher,
      config: this.config,

      send: (ws, response) => this.send(ws, response),
      broadcast: (type, payload, sessionId) => this.broadcast(type, payload, sessionId),

      clients: this.clients,
      autoApproveSessions: this.autoApproveSessions,
      pendingSentMessages: this.pendingSentMessages,
      tmuxSessionConfigs: this.tmuxSessionConfigs,
      clientErrors: this.clientErrors,
      scrollLogs: this.scrollLogs,

      storeTmuxSessionConfig: (name, workingDir, startCli) =>
        this.storeTmuxSessionConfig(name, workingDir, startCli),
      saveTmuxSessionConfigs: () => this.saveTmuxSessionConfigs(),
      getProjectRoot: (sessionId) => this.getProjectRoot(sessionId),

      PENDING_SENT_TTL: WebSocketHandler.PENDING_SENT_TTL,
      MAX_CLIENT_ERRORS: this.MAX_CLIENT_ERRORS,
      MAX_SCROLL_LOGS: this.MAX_SCROLL_LOGS,
    };
  }

  // --- Tmux session config persistence ---

  private loadTmuxSessionConfigs(): void {
    try {
      if (fs.existsSync(TMUX_CONFIGS_FILE)) {
        const content = fs.readFileSync(TMUX_CONFIGS_FILE, 'utf-8');
        const configs = JSON.parse(content) as TmuxSessionConfig[];
        for (const config of configs) {
          this.tmuxSessionConfigs.set(config.name, config);
        }
        console.log(`WebSocket: Loaded ${configs.length} saved tmux session configs`);
      }
    } catch (err) {
      console.error('Failed to load tmux session configs:', err);
    }
  }

  private saveTmuxSessionConfigs(): void {
    try {
      const dir = path.dirname(TMUX_CONFIGS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const configs = Array.from(this.tmuxSessionConfigs.values());
      fs.writeFileSync(TMUX_CONFIGS_FILE, JSON.stringify(configs, null, 2));
    } catch (err) {
      console.error('Failed to save tmux session configs:', err);
    }
  }

  private storeTmuxSessionConfig(name: string, workingDir: string, startCli: boolean = true): void {
    this.tmuxSessionConfigs.set(name, {
      name,
      workingDir,
      startCli,
      lastUsed: Date.now(),
    });
    this.saveTmuxSessionConfigs();
    console.log(`WebSocket: Stored tmux session config for "${name}" (${workingDir})`);
  }

  // --- Connection management ---

  private handleConnection(ws: WebSocket, req: IncomingMessage, listenerPort: number): void {
    const clientId = uuidv4();
    const remoteAddress = req.socket.remoteAddress || '';
    const isLocal =
      remoteAddress === '127.0.0.1' ||
      remoteAddress === '::1' ||
      remoteAddress === '::ffff:127.0.0.1';
    const client: AuthenticatedClient = {
      id: clientId,
      ws,
      authenticated: false,
      subscribed: false,
      listenerPort,
      isLocal,
    };

    this.clients.set(clientId, client);
    console.log(`WebSocket: Client connected (${clientId})`);

    ws.on('message', (data) => {
      try {
        const message: WebSocketMessage = JSON.parse(data.toString());
        this.handleMessage(client, message);
      } catch (err) {
        this.sendError(ws, 'Invalid JSON message');
      }
    });

    ws.on('close', (code, reason) => {
      this.clients.delete(clientId);
      console.log(
        `WebSocket: Client disconnected (${clientId}) code=${code} reason=${reason?.toString() || 'none'}`
      );
    });

    ws.on('error', (err) => {
      console.error(`WebSocket: Client error (${clientId}):`, err);
      this.clients.delete(clientId);
    });

    this.send(ws, {
      type: 'connected',
      success: true,
      payload: { clientId },
    });
  }

  // --- Message dispatch ---

  private handleMessage(client: AuthenticatedClient, message: WebSocketMessage): void {
    const { type, token, payload, requestId } = message;
    if (type !== 'ping') {
      console.log(`WebSocket: >> recv ${type} (${requestId || 'no-id'}) from ${client.id}`);
    }

    // Authenticate first
    if (type === 'authenticate') {
      const expectedToken = client.listenerPort
        ? this.tokenMap.get(client.listenerPort)
        : undefined;

      if (expectedToken && token === expectedToken) {
        client.authenticated = true;
        client.deviceId = (payload as { deviceId?: string })?.deviceId;

        this.send(client.ws, {
          type: 'authenticated',
          success: true,
          isLocal: client.isLocal,
          gitEnabled: this.config.git,
          requestId,
        });
        console.log(
          `WebSocket: Client authenticated (${client.id}) on port ${client.listenerPort} isLocal=${client.isLocal}`
        );
      } else {
        this.send(client.ws, {
          type: 'authenticated',
          success: false,
          error: 'Invalid token',
          requestId,
        });
      }
      return;
    }

    // All other messages require authentication
    if (!client.authenticated) {
      this.send(client.ws, {
        type: 'error',
        success: false,
        error: 'Not authenticated',
        requestId,
      });
      return;
    }

    // Trivial inline handlers
    if (type === 'ping') {
      if (client.deviceId) {
        this.push.updateDeviceLastSeen(client.deviceId);
      }
      this.send(client.ws, {
        type: 'pong',
        success: true,
        requestId,
      });
      return;
    }

    if (type === 'rotate_token') {
      this.handleRotateToken(client, requestId);
      return;
    }

    // Dispatch to registered handlers
    const handler = this.handlers.get(type);
    if (handler) {
      const result = handler(client, payload, requestId);
      // If handler returns a promise, catch any unhandled errors
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((err) => {
          console.error(`Handler error for ${type}:`, err);
          this.send(client.ws, {
            type: 'error',
            success: false,
            error: `Internal error handling ${type}`,
            requestId,
          });
        });
      }
    } else {
      this.send(client.ws, {
        type: 'error',
        success: false,
        error: `Unknown message type: ${type}`,
        requestId,
      });
    }
  }

  // --- Token rotation (kept inline — modifies auth state) ---

  private handleRotateToken(client: AuthenticatedClient, requestId?: string): void {
    try {
      if (!client.listenerPort) {
        throw new Error('Client has no listener port');
      }

      const newToken = crypto.randomBytes(32).toString('hex');

      const config = loadConfig();
      const listenerIndex = config.listeners.findIndex((l) => l.port === client.listenerPort);
      if (listenerIndex === -1) {
        throw new Error(`Listener not found for port ${client.listenerPort}`);
      }
      config.listeners[listenerIndex].token = newToken;
      saveConfig(config);

      this.tokenMap.set(client.listenerPort, newToken);

      this.send(client.ws, {
        type: 'token_rotated',
        success: true,
        payload: { newToken },
        requestId,
      });

      console.log(`WebSocket: Token rotated successfully for port ${client.listenerPort}`);

      for (const [id, c] of this.clients) {
        if (id !== client.id && c.authenticated && c.listenerPort === client.listenerPort) {
          this.send(c.ws, {
            type: 'token_invalidated',
            success: true,
            payload: { reason: 'Token has been rotated' },
          });
          c.authenticated = false;
          c.subscribed = false;
        }
      }
    } catch (err) {
      console.error('Failed to rotate token:', err);
      this.send(client.ws, {
        type: 'token_rotated',
        success: false,
        error: 'Failed to rotate token',
        requestId,
      });
    }
  }

  // --- Shared helpers ---

  private getProjectRoot(sessionId?: string): string | null {
    if (sessionId) {
      const conv = this.watcher.getConversationInfo(sessionId);
      if (conv?.projectPath) {
        return conv.projectPath;
      }
    }
    const conv = this.watcher.getActiveConversation();
    if (conv?.projectPath) {
      return conv.projectPath;
    }
    return null;
  }

  // --- Send / broadcast ---

  private send(ws: WebSocket, response: WebSocketResponse): void {
    if (ws.readyState === WebSocket.OPEN) {
      const data = JSON.stringify(response);
      if (response.type !== 'pong' && response.requestId) {
        console.log(
          `WebSocket: << send ${response.type} (${response.requestId}) ${data.length} bytes`
        );
      }
      ws.send(data);
    } else {
      console.log(
        `WebSocket: !! send FAILED - ws not open (state: ${ws.readyState}) for ${response.type}`
      );
    }
  }

  private sendError(ws: WebSocket, error: string): void {
    this.send(ws, {
      type: 'error',
      success: false,
      error,
    });
  }

  private broadcast(type: string, payload: unknown, sessionId?: string): void {
    const activeSessionId = sessionId || this.watcher.getActiveSessionId();

    const message = JSON.stringify({
      type,
      success: true,
      payload,
      sessionId: activeSessionId,
    });

    for (const client of this.clients.values()) {
      if (
        client.authenticated &&
        client.subscribed &&
        client.ws.readyState === WebSocket.OPEN &&
        (!activeSessionId || client.subscribedSessionId === activeSessionId)
      ) {
        client.ws.send(message);
      }
    }
  }

  // --- Public API ---

  getConnectedClientCount(): number {
    return this.clients.size;
  }

  getAuthenticatedClientCount(): number {
    return Array.from(this.clients.values()).filter((c) => c.authenticated).length;
  }
}
