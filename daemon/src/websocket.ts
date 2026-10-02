import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage, Server, ServerResponse } from 'http';
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
import { atomicWriteFileSync, registerShutdownCallback } from './utils';
import { SubAgentWatcher } from './subagent-watcher';
import { WorkGroupManager } from './work-group-manager';
import { SkillCatalog } from './skill-catalog';
import { EscalationService, EscalationEvent } from './escalation';
import { NotificationEventType } from './types';
import { OAuthUsageFetcher, UsageMonitor } from './oauth-usage';
import { SessionNameStore } from './session-names';
import { AuditLog } from './audit-log';
import { RateLimiter } from './rate-limiter';

import {
  AuthenticatedClient,
  ClientError,
  HandlerContext,
  MessageHandler,
} from './handler-context';
import { registerAllHandlers } from './handlers';
import { updateLastActivity } from './metrics';
import { HeraldService } from './herald/service';
import { HeraldStore } from './herald/store';
import { defaultCapturePane, LocalSessionSource } from './herald/session-source';
import { createClaudeSession } from './session-spawn';
import { resolveHeraldConfig } from './herald/config';
import { createProvider } from './herald/llm';
import { deriveSelfInfo } from './herald/self-info';
import { HeraldVoiceService } from './herald/voice/service';
import { VoiceServiceClient } from './herald/voice/client';
import { HeraldTriggerService } from './herald/trigger';
import { ReviewService } from './review/service';

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
  private oauthUsageFetcher: OAuthUsageFetcher;
  private usageMonitor: UsageMonitor;
  private sessionNameStore: SessionNameStore;
  private auditLog: AuditLog;
  private rateLimiter: RateLimiter;
  private handlers: Map<string, MessageHandler>;
  private herald: HeraldService | null = null;
  private heraldVoice: HeraldVoiceService | null = null;
  private heraldTrigger: HeraldTriggerService;
  private review: ReviewService | null = null;
  private deadConnectionInterval: ReturnType<typeof setInterval>;
  private static readonly PONG_TIMEOUT_MS = 90_000;
  private static readonly DEAD_CHECK_INTERVAL_MS = 60_000;
  // Server-initiated liveness ping. Native ws ping frames are auto-answered by
  // the browser with a pong frame, so client liveness no longer depends solely
  // on the client managing to ping into a momentarily busy event loop.
  private static readonly SERVER_PING_INTERVAL_MS = 30_000;

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
    this.sessionNameStore = new SessionNameStore(path.join(os.homedir(), '.companion'));
    this.auditLog = new AuditLog();
    this.rateLimiter = new RateLimiter();
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

    this.herald = this.createHerald();
    this.heraldVoice = this.createHeraldVoice();
    this.heraldTrigger = new HeraldTriggerService({
      available: () => !!this.herald && !!this.heraldVoice,
      activeClient: () => this.heraldVoice?.announcerClient ?? null,
      claimDevice: (device, pin) => this.heraldVoice?.claimByName(device, pin) ?? null,
      deliver: (clientId, event) => this.sendToClient(clientId, 'herald_event', event),
      show: (session, clientId) =>
        this.herald
          ? this.herald.showCached(session, clientId, { via: 'trigger', ack: true })
          : { status: 'no_device' },
      audit: (entry) => this.auditLog.append(entry),
      trust: resolveHeraldConfig(this.config.herald).trigger,
    });

    this.review = this.createReview();
    if (this.review && this.herald) {
      const review = this.review;
      review.setHerald(this.herald);
      this.herald.setReview({ digest: (id, scope) => review.digest(id, scope) });
    }

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
      this.broadcast('compaction', data, data.sessionId);
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

    if (this.herald) {
      const herald = this.herald;
      this.watcher.on('status-change', () => herald.notifyActivity());
      this.watcher.on('conversation-update', () => herald.notifyActivity());
      herald.start().catch((err) => console.error('Herald: failed to start:', err));
    }

    // Periodically close dead connections that haven't sent a ping recently
    this.deadConnectionInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, client] of this.clients) {
        if (now - client.lastPongTime > WebSocketHandler.PONG_TIMEOUT_MS) {
          console.log(
            `WebSocket: Closing dead connection (${id}) — no ping for ${Math.round((now - client.lastPongTime) / 1000)}s`
          );
          try {
            client.ws.close(1000, 'Ping timeout');
          } catch {
            client.ws.terminate();
          }
          this.clients.delete(id);
        }
      }
    }, WebSocketHandler.DEAD_CHECK_INTERVAL_MS);

    // Register timer cleanup for graceful shutdown
    registerShutdownCallback(() => this.shutdown());

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
      sessionNameStore: this.sessionNameStore,
      subAgentWatcher: this.subAgentWatcher,
      auditLog: this.auditLog,
      rateLimiter: this.rateLimiter,
      config: this.config,
      herald: this.herald,
      heraldVoice: this.heraldVoice,
      heraldTrigger: this.heraldTrigger,
      review: this.review,

      send: (ws, response) => this.send(ws, response),
      broadcast: (type, payload, sessionId) => this.broadcast(type, payload, sessionId),
      sendToClient: (clientId, type, payload) => this.sendToClient(clientId, type, payload),
      requireRemoteCapability: (client, action) => this.requireRemoteCapability(client, action),

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

  // --- Herald ---

  private createHerald(): HeraldService | null {
    try {
      const cfg = resolveHeraldConfig(this.config.herald);
      const source = this.makeLocalSource();
      return new HeraldService({
        config: cfg,
        provider: createProvider(cfg),
        sources: [source],
        store: new HeraldStore(cfg.stateDir),
        broadcast: (event) => this.broadcast('herald_event', event),
        audit: (entry) => this.auditLog.append(entry),
        selfInfo: deriveSelfInfo(this.config.listeners[0]),
        codeHome: this.config.codeHome,
        devices: () => this.heraldVoice?.devicesSnapshot() ?? null,
        // propose_spawn_session: the app's own session-creation path. It does not
        // become the active session (Herald never switches the user's view).
        spawner: {
          spawn: async ({ dir }) => {
            const r = await createClaudeSession(
              {
                tmux: this.tmux,
                storeTmuxSessionConfig: (n, d, c) => this.storeTmuxSessionConfig(n, d, c),
                sessionNameStore: this.sessionNameStore,
                watcher: this.watcher,
                broadcast: (type, payload) => this.broadcast(type, payload),
              },
              { workingDir: dir }
            );
            return r.success
              ? { ok: true, sessionId: r.sessionName, sessionName: r.friendlyName }
              : { ok: false, error: r.error };
          },
          capturePane: (id) => defaultCapturePane(id),
          exists: (id) => this.injector.checkSessionExists(id),
        },
        voiceEvidence: (clientId, streamId) =>
          this.heraldVoice?.voiceEvidence(clientId, streamId) ?? null,
        consumeTranscript: (clientId, streamId) =>
          this.heraldVoice?.consumeTranscript(clientId, streamId),
        activeClientId: () => this.heraldVoice?.announcerClient ?? null,
        deliverToClient: (clientId, event) => this.sendToClient(clientId, 'herald_event', event),
        speakingSuppresses: (clientId) => this.heraldVoice?.speakingSuppresses(clientId) ?? false,
      });
    } catch (err) {
      console.error('Herald: failed to initialize:', err);
      return null;
    }
  }

  /** A session source over this daemon's tmux sessions (Herald + Code Review). */
  private makeLocalSource(): LocalSessionSource {
    return new LocalSessionSource({
      watcher: this.watcher,
      injector: this.injector,
      sessionNames: this.sessionNameStore,
      onSent: (tmuxName, text, tag) => {
        // Same bookkeeping as send_input: optimistic chat echo + escalation ack.
        if (text) {
          const pending = this.pendingSentMessages.get(tmuxName) || [];
          pending.push({ clientMessageId: tag, content: text, sentAt: Date.now() });
          this.pendingSentMessages.set(tmuxName, pending);
        }
        this.escalation.acknowledgeSession(tmuxName);
      },
    });
  }

  // --- Code Review ---

  private createReview(): ReviewService | null {
    try {
      const source = this.makeLocalSource();
      const review = new ReviewService({
        watcher: this.watcher,
        gitEnabled: () => this.config.git !== false,
        // Review events are GLOBAL with sessionId in the payload: a session-scoped
        // broadcast only reaches a client's single subscribed pane.
        broadcast: (type, payload) => this.broadcast(type, payload),
        sendToClient: (clientId, type, payload) => this.sendToClient(clientId, type, payload),
        sessionName: (id) => this.sessionNameStore.get(id) || id,
        audit: (entry) => this.auditLog.append(entry),
        sendDirect: (id, text) => source.sendText(id, text, `review-${Date.now()}`),
        hasLiveChoice: async (id) => (await source.getLiveChoice(id)) !== null,
        allowedPaths: () => this.config.allowedPaths || [],
      });
      review.attach(this.watcher);
      return review;
    } catch (err) {
      console.error('Review: failed to initialize:', err);
      return null;
    }
  }

  private createHeraldVoice(): HeraldVoiceService | null {
    if (!this.herald) return null;
    const url = resolveHeraldConfig(this.config.herald).voiceUrl;
    if (!url) {
      console.log('Herald voice: disabled (herald.voice_enabled=false or invalid voice_url)');
      return null;
    }
    const voice = new HeraldVoiceService({
      client: new VoiceServiceClient(url),
      sendEvent: (clientId, event) => this.sendToClient(clientId, 'herald_voice_event', event),
      debugTranscripts: !!process.env.HERALD_DEBUG_TOOLS && process.env.HERALD_DEBUG_TOOLS !== '0',
      sttHints: () => this.herald?.sttHints() ?? null,
      onDevices: (snap) => this.broadcast('herald_event', { kind: 'devices', ...snap }),
      onSpeaking: (speaking) => this.broadcast('herald_event', { kind: 'speaking', speaking }),
      deliverEvent: (clientId, event) => this.sendToClient(clientId, 'herald_event', event),
    });
    voice.start();
    console.log(`Herald voice: using voice service at ${url}`);
    return voice;
  }

  /** Push to one full-scope client; false when it is gone or not allowed to receive. */
  private sendToClient(clientId: string, type: string, payload: unknown): boolean {
    const client = this.clients.get(clientId);
    if (!client || !client.authenticated || client.scope === 'trigger') return false;
    if (client.ws.readyState !== WebSocket.OPEN) return false;
    this.send(client.ws, { type, success: true, payload });
    return true;
  }

  /** POST /herald/trigger on the daemon's HTTP server(s). */
  handleHeraldTriggerHttp(req: IncomingMessage, res: ServerResponse): void {
    const port = req.socket.localPort;
    const tls = Boolean(this.config.listeners.find((l) => l.port === port)?.tls);
    this.heraldTrigger.handleHttp(req, res, tls);
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
      atomicWriteFileSync(TMUX_CONFIGS_FILE, JSON.stringify(configs, null, 2));
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
      lastPongTime: Date.now(),
      origin: null,
    };
    const xff = req.headers?.['x-forwarded-for'];
    if (xff) client.forwardedFor = Array.isArray(xff) ? xff.join(', ') : xff;

    this.clients.set(clientId, client);
    console.log(`WebSocket: Client connected (${clientId})`);

    // Server-initiated liveness ping. The browser auto-answers native ping frames
    // with a pong, keeping lastPongTime fresh without relying on the client's own
    // app-level ping. Cleared on close/error below.
    const serverPingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch {
          // ignore — the close/error handlers will clean up
        }
      }
    }, WebSocketHandler.SERVER_PING_INTERVAL_MS);

    // Native pong (reply to ws.ping()) refreshes liveness, same as app-level ping.
    ws.on('pong', () => {
      client.lastPongTime = Date.now();
    });

    ws.on('message', (data) => {
      try {
        const message: WebSocketMessage = JSON.parse(data.toString());
        this.handleMessage(client, message);
      } catch (err) {
        this.sendError(ws, 'Invalid JSON message');
      }
    });

    ws.on('close', (code, reason) => {
      clearInterval(serverPingInterval);
      this.clients.delete(clientId);
      this.heraldVoice?.clientGone(clientId);
      this.review?.dropClient(clientId);
      console.log(
        `WebSocket: Client disconnected (${clientId}) code=${code} reason=${reason?.toString() || 'none'}`
      );
    });

    ws.on('error', (err) => {
      clearInterval(serverPingInterval);
      console.error(`WebSocket: Client error (${clientId}):`, err);
      this.clients.delete(clientId);
      this.heraldVoice?.clientGone(clientId);
      this.review?.dropClient(clientId);
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
    // Audio chunks arrive ~10/s while someone talks, speaking heartbeats ~1/s
    // while Herald plays: never log them.
    if (type !== 'ping' && type !== 'herald_voice_audio' && type !== 'herald_speaking') {
      console.log(`WebSocket: >> recv ${type} (${requestId || 'no-id'}) from ${client.id}`);
      updateLastActivity();
    }

    // Authenticate first
    if (type === 'authenticate') {
      const expectedToken = client.listenerPort
        ? this.tokenMap.get(client.listenerPort)
        : undefined;

      const authPayload = (payload as { deviceId?: string; origin?: string }) || {};
      const topLevelOrigin = (message as { origin?: unknown }).origin;
      const providedOrigin =
        typeof topLevelOrigin === 'string' && topLevelOrigin
          ? topLevelOrigin
          : typeof authPayload.origin === 'string' && authPayload.origin
            ? authPayload.origin
            : null;

      const listener = this.config.listeners.find((l) => l.port === client.listenerPort);
      const origins = listener?.remoteCapabilities?.origins;

      // --- Per-origin credential path (only when origins[] is configured) ---
      if (Array.isArray(origins) && origins.length > 0) {
        const matched = origins.find(
          (o) => !o.disabled && o.origin === providedOrigin && o.token === token
        );
        if (matched) {
          client.authenticated = true;
          client.scope = 'full';
          client.deviceId = authPayload.deviceId;
          client.origin = providedOrigin;
          client.originCredential = matched;

          this.send(client.ws, {
            type: 'authenticated',
            success: true,
            isLocal: client.isLocal,
            gitEnabled: this.config.git,
            requestId,
          });
          console.log(
            `WebSocket: Client authenticated (${client.id}) on port ${client.listenerPort} via per-origin credential origin=${providedOrigin ?? 'none'}`
          );
          return;
        }
        // No matching per-origin credential — fall through to the listener-token
        // path below (so a valid listener token still works alongside origins[]).
      }

      // Scoped trigger credential: may ONLY fire Herald triggers (see handleMessage).
      const triggerCred =
        token !== undefined && !(expectedToken && token === expectedToken)
          ? this.heraldTrigger.identify(token)
          : null;
      if (triggerCred) {
        client.authenticated = true;
        client.scope = 'trigger';
        client.triggerCredential = triggerCred;
        client.origin = providedOrigin;
        this.send(client.ws, {
          type: 'authenticated',
          success: true,
          isLocal: client.isLocal,
          scope: 'trigger',
          requestId,
        });
        console.log(
          `WebSocket: Client authenticated (${client.id}) with trigger token "${triggerCred.name}"`
        );
        return;
      }

      if (expectedToken && token === expectedToken) {
        const allowedOrigins = listener?.remoteCapabilities?.allowedOrigins;
        if (Array.isArray(allowedOrigins) && allowedOrigins.length > 0) {
          if (!providedOrigin || !allowedOrigins.includes(providedOrigin)) {
            this.send(client.ws, {
              type: 'authenticated',
              success: false,
              error: 'origin_not_allowed',
              requestId,
            });
            console.log(
              `WebSocket: Client rejected (${client.id}) on port ${client.listenerPort} — origin "${providedOrigin}" not in allowedOrigins`
            );
            return;
          }
        }

        client.authenticated = true;
        client.scope = 'full';
        client.deviceId = authPayload.deviceId;
        client.origin = providedOrigin;

        this.send(client.ws, {
          type: 'authenticated',
          success: true,
          isLocal: client.isLocal,
          gitEnabled: this.config.git,
          requestId,
        });
        console.log(
          `WebSocket: Client authenticated (${client.id}) on port ${client.listenerPort} isLocal=${client.isLocal} origin=${providedOrigin ?? 'none'}`
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

    // The trigger token can fire triggers (and keep its socket alive), nothing else.
    if (client.scope === 'trigger' && type !== 'herald_trigger' && type !== 'ping') {
      this.send(client.ws, {
        type,
        success: false,
        error: 'Forbidden: this credential can only fire Herald triggers',
        payload: { code: 'forbidden' },
        requestId,
      });
      return;
    }

    // Trivial inline handlers
    if (type === 'ping') {
      client.lastPongTime = Date.now();
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
      let result;
      try {
        result = handler(client, payload, requestId);
      } catch (err) {
        console.error(`Handler error for ${type}:`, err);
        this.send(client.ws, {
          type: 'error',
          success: false,
          error: `Internal error handling ${type}`,
          requestId,
        });
        return;
      }
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

  private requireRemoteCapability(
    client: AuthenticatedClient,
    action: 'exec' | 'dispatch' | 'write'
  ): string | null {
    const listener = this.config.listeners.find((l) => l.port === client.listenerPort);
    const caps = listener?.remoteCapabilities;

    if (!caps?.enabled) return 'capability_disabled';

    let actionEnabled = false;
    if (action === 'exec') actionEnabled = Boolean(caps.exec?.enabled);
    else if (action === 'dispatch') actionEnabled = Boolean(caps.dispatch?.enabled);
    else if (action === 'write') actionEnabled = Boolean(caps.write?.enabled);

    if (!actionEnabled) return 'capability_disabled';

    // Per-origin capability narrowing: when the client authenticated against an
    // origins[] credential that explicitly disables this action, deny even if the
    // listener allows it. An absent per-origin cap leaves the listener decision intact.
    const originCaps = client.originCredential?.capabilities;
    if (originCaps && originCaps[action] === false) {
      return 'capability_disabled';
    }

    const requireSecure = caps.requireLoopbackOrTls !== false;
    if (requireSecure) {
      const isTls = Boolean(listener?.tls);
      if (!client.isLocal && !isTls) return 'transport_insecure';
    }

    return null;
  }

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
    const SESSION_SCOPED_TYPES = new Set(['conversation_update', 'status_change', 'compaction']);

    // Session-scoped events without a sessionId are dropped — never broadcast to everyone
    if (SESSION_SCOPED_TYPES.has(type) && !sessionId) {
      console.log(`WebSocket: Dropping session-scoped broadcast "${type}" with no sessionId`);
      return;
    }

    const message = JSON.stringify({
      type,
      success: true,
      payload,
      sessionId: sessionId || undefined,
    });

    for (const client of this.clients.values()) {
      if (!client.authenticated || !client.subscribed || client.ws.readyState !== WebSocket.OPEN) {
        continue;
      }

      if (sessionId) {
        // Session-scoped: only deliver to clients subscribed to this exact session
        if (client.subscribedSessionId === sessionId) {
          client.ws.send(message);
        }
      } else {
        // Global events (other_session_activity, usage_warning, work_group_update, etc.): deliver to all
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

  shutdown(): void {
    clearInterval(this.deadConnectionInterval);
    this.escalation.destroy();
    this.usageMonitor.stop();
    this.herald?.shutdown();
    this.heraldVoice?.shutdown();
    this.review?.shutdown();
  }
}
