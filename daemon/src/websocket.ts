import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage, Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import { SessionWatcher } from './watcher';
import { InputInjector } from './input-injector';
import { PushNotificationService } from './push';
import { TmuxManager } from './tmux-manager';
import {
  extractHighlights,
  extractUsageFromFile,
  extractTasks,
  extractFileChanges,
  parseConversationChain,
  parseConversationFile,
} from './parser';
import {
  WebSocketMessage,
  WebSocketResponse,
  DaemonConfig,
  TmuxSessionConfig,
  ListenerConfig,
} from './types';
import { loadConfig, saveConfig } from './config';
import { fetchTodayUsage, fetchMonthUsage, fetchAnthropicUsage } from './anthropic-usage';
import { DEFAULT_TOOL_CONFIG } from './tool-config';
import { SubAgentWatcher } from './subagent-watcher';
import { WorkGroupManager } from './work-group-manager';
import { scanProjectSkills, scanGlobalSkills } from './skill-scanner';
import { SkillCatalog } from './skill-catalog';
import { templates as scaffoldTemplates } from './scaffold/templates';
import { scaffoldProject, previewScaffold } from './scaffold/generator';
import { ProjectConfig } from './scaffold/types';
import { scoreTemplates } from './scaffold/scorer';
import { EscalationService, EscalationEvent } from './escalation';
import { NotificationEventType, EscalationConfig } from './types';
import { UsageTracker } from './usage-tracker';
import { OAuthUsageFetcher, UsageMonitor } from './oauth-usage';

// File for persisting tmux session configs
const TMUX_CONFIGS_FILE = path.join(os.homedir(), '.companion', 'tmux-sessions.json');

interface AuthenticatedClient {
  id: string;
  ws: WebSocket;
  authenticated: boolean;
  deviceId?: string;
  subscribed: boolean;
  subscribedSessionId?: string; // Track which session client is subscribed to
  listenerPort?: number; // Track which listener this client connected through
  isLocal: boolean; // Whether connection is from localhost
}

interface ClientError {
  message: string;
  stack?: string;
  componentStack?: string;
  timestamp: number;
  deviceId?: string;
}

export class WebSocketHandler {
  private wssMap: Map<number, WebSocketServer> = new Map(); // port -> WebSocketServer
  private tokenMap: Map<number, string> = new Map(); // port -> token
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
  // Pending sent messages per session — tracks messages sent via send_input that
  // haven't yet appeared in the JSONL (because Claude hasn't processed them yet).
  // Keyed by tmux session name.
  private pendingSentMessages: Map<string, Array<{
    clientMessageId: string;
    content: string;
    sentAt: number;
  }>> = new Map();
  private static readonly PENDING_SENT_TTL = 10 * 60 * 1000; // 10 minute safety valve
  private escalation: EscalationService;
  private workGroupManager: WorkGroupManager | null;
  private skillCatalog: SkillCatalog;
  private usageTracker: UsageTracker;
  private oauthUsageFetcher: OAuthUsageFetcher;
  private usageMonitor: UsageMonitor;

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

      // Escalation for waiting_for_input
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
        // Session stopped waiting — acknowledge (cancel pending push)
        this.escalation.acknowledgeSession(data.sessionId);
      }
    });

    // Notify about activity in other (non-active) sessions
    this.watcher.on('other-session-activity', (data) => {
      this.broadcast('other_session_activity', data);
    });

    // Notify about conversation compaction (for archiving)
    this.watcher.on('compaction', (data) => {
      this.broadcast('compaction', data);
    });

    // Escalation-based notifications for error-detected and session-completed
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
      // Always broadcast the event to connected web clients
      this.broadcast(eventType, data);
    };

    this.watcher.on('error-detected', (data) => handleEscalationEvent('error_detected', data));
    this.watcher.on('session-completed', (data) =>
      handleEscalationEvent('session_completed', data)
    );

    // Forward work group updates to clients
    if (this.workGroupManager) {
      this.workGroupManager.on('work-group-update', (group) => {
        this.broadcast('work_group_update', group);
      });
    }

    // Load saved tmux session configs
    this.loadTmuxSessionConfigs();

    console.log('WebSocket: Server initialized');
  }

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

  private handleConnection(ws: WebSocket, req: IncomingMessage, listenerPort: number): void {
    const clientId = uuidv4();
    const remoteAddress = req.socket.remoteAddress || '';
    const isLocal = remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
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

    // Send connection acknowledgment
    this.send(ws, {
      type: 'connected',
      success: true,
      payload: { clientId },
    });
  }

  private handleMessage(client: AuthenticatedClient, message: WebSocketMessage): void {
    const { type, token, payload, requestId } = message;
    if (type !== 'ping') {
      console.log(`WebSocket: >> recv ${type} (${requestId || 'no-id'}) from ${client.id}`);
    }

    // Authenticate first
    if (type === 'authenticate') {
      // Get the expected token for this client's listener
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

    // Handle authenticated messages
    switch (type) {
      case 'subscribe':
        const subscribePayload = payload as { sessionId?: string } | undefined;
        client.subscribed = true;
        // Track which session the client is subscribed to
        if (subscribePayload?.sessionId) {
          client.subscribedSessionId = subscribePayload.sessionId;
        } else {
          // Default to current active session
          client.subscribedSessionId = this.watcher.getActiveSessionId() || undefined;
        }
        console.log(
          `WebSocket: Client subscribed (${client.id}) to session ${client.subscribedSessionId}`
        );
        this.send(client.ws, {
          type: 'subscribed',
          success: true,
          sessionId: client.subscribedSessionId,
          requestId,
        } as WebSocketResponse);
        break;

      case 'unsubscribe':
        client.subscribed = false;
        this.send(client.ws, {
          type: 'unsubscribed',
          success: true,
          requestId,
        });
        break;

      case 'get_highlights': {
        const hlParams = payload as { limit?: number; offset?: number; sessionId?: string } | undefined;
        const t0 = Date.now();
        // Use client's subscribed session, payload override, or fall back to global active
        const hlSessionId = hlParams?.sessionId || client.subscribedSessionId || this.watcher.getActiveSessionId();
        const limit = hlParams?.limit && hlParams.limit > 0 ? hlParams.limit : 0;
        const offset = hlParams?.offset || 0;

        // Use conversation chain for cross-session infinite scroll
        const chain = hlSessionId ? this.watcher.getConversationChain(hlSessionId) : [];

        let resultHighlights: ReturnType<typeof extractHighlights>;
        let total: number;
        let hasMore: boolean;

        if (chain.length > 1 && limit > 0) {
          // Multiple files — use chain-aware pagination
          const result = parseConversationChain(chain, limit, offset);
          resultHighlights = result.highlights;
          total = result.total;
          hasMore = result.hasMore;
        } else {
          // Single file or no limit — use existing fast path
          const messages = this.watcher.getMessages(hlSessionId || undefined);
          const allHighlights = extractHighlights(messages);
          total = allHighlights.length;

          if (limit > 0) {
            const startIdx = Math.max(0, total - offset - limit);
            const endIdx = total - offset;
            resultHighlights = allHighlights.slice(startIdx, endIdx);
            hasMore = startIdx > 0;
          } else {
            resultHighlights = allHighlights;
            hasMore = false;
          }
        }

        // Inject pending sent messages that haven't appeared in JSONL yet
        // pendingSentMessages is keyed by tmux session name, but hlSessionId is a conversation UUID.
        // Resolve the tmux session name for this conversation.
        const tmuxNameForPending = hlSessionId ? this.watcher.getTmuxSessionForConversation(hlSessionId) : null;
        if (tmuxNameForPending) {
          const pending = this.pendingSentMessages.get(tmuxNameForPending);
          if (pending && pending.length > 0) {
            const now = Date.now();
            // Filter: remove expired and confirmed messages
            const unconfirmed = pending.filter(p => {
              if (now - p.sentAt > WebSocketHandler.PENDING_SENT_TTL) return false;
              // Check if any user highlight matches this content (trimmed)
              return !resultHighlights.some(
                h => h.type === 'user' && h.content.trim() === p.content.trim()
              );
            });
            this.pendingSentMessages.set(tmuxNameForPending, unconfirmed);

            // Append unconfirmed pending messages as user highlights
            for (const p of unconfirmed) {
              resultHighlights.push({
                id: p.clientMessageId,
                type: 'user' as const,
                content: p.content,
                timestamp: p.sentAt,
                isWaitingForChoice: false,
              });
            }
            total += unconfirmed.length;
          }
        }

        const t1 = Date.now();
        if (t1 - t0 > 100) {
          console.log(`WebSocket: get_highlights - ${t1 - t0}ms (slow), chain: ${chain.length} files, returning ${resultHighlights.length}/${total}`);
        }
        this.send(client.ws, {
          type: 'highlights',
          success: true,
          payload: { highlights: resultHighlights, total, hasMore },
          sessionId: hlSessionId,
          requestId,
        } as WebSocketResponse);
        break;
      }

      case 'get_full': {
        const fullParams = payload as { sessionId?: string } | undefined;
        const t0 = Date.now();
        const fullSessionId = fullParams?.sessionId || client.subscribedSessionId || this.watcher.getActiveSessionId();
        const fullMessages = this.watcher.getMessages(fullSessionId || undefined);
        const t1 = Date.now();
        console.log(`WebSocket: get_full - getMessages: ${t1 - t0}ms, ${fullMessages.length} msgs, session: ${fullSessionId}`);
        this.send(client.ws, {
          type: 'full',
          success: true,
          payload: { messages: fullMessages },
          sessionId: fullSessionId,
          requestId,
        } as WebSocketResponse);
        break;
      }

      case 'get_status': {
        const statusParams = payload as { sessionId?: string } | undefined;
        const t0 = Date.now();
        const statusSessionId = statusParams?.sessionId || client.subscribedSessionId || this.watcher.getActiveSessionId();
        const status = this.watcher.getStatus(statusSessionId || undefined);
        const t1 = Date.now();
        console.log(
          `WebSocket: get_status - ${t1 - t0}ms - waiting: ${status.isWaitingForInput}, running: ${status.isRunning}, session: ${statusSessionId}`
        );

        this.send(client.ws, {
          type: 'status',
          success: true,
          payload: status,
          sessionId: statusSessionId,
          requestId,
        } as WebSocketResponse);
        break;
      }

      case 'get_server_summary':
        // Get tmux sessions to filter - show conversations with any active tmux session
        this.tmux
          .listSessions()
          .then(async (tmuxSessions) => {
            const summary = await this.watcher.getServerSummary(tmuxSessions);
            this.send(client.ws, {
              type: 'server_summary',
              success: true,
              payload: summary,
              requestId,
            });
          })
          .catch((err) => {
            console.error('Failed to get server summary:', err);
            this.send(client.ws, {
              type: 'server_summary',
              success: false,
              error: 'Failed to get server summary',
              requestId,
            });
          });
        break;

      case 'get_sessions':
        const sessions = this.watcher.getSessions();
        const activeSessionId = this.watcher.getActiveSessionId();
        this.send(client.ws, {
          type: 'sessions',
          success: true,
          payload: { sessions, activeSessionId },
          requestId,
        });
        break;

      case 'get_tasks':
        // Get tasks for a specific session
        const tasksPayload = payload as { sessionId?: string } | undefined;
        const tasksSessionId = tasksPayload?.sessionId || this.watcher.getActiveSessionId();
        if (tasksSessionId) {
          const sessionSessions = this.watcher.getSessions();
          const session = sessionSessions.find((s) => s.id === tasksSessionId);
          if (session?.conversationPath) {
            try {
              const fs = require('fs');
              const content = fs.readFileSync(session.conversationPath, 'utf-8');
              const tasks = extractTasks(content);
              this.send(client.ws, {
                type: 'tasks',
                success: true,
                payload: { tasks, sessionId: tasksSessionId },
                requestId,
              });
            } catch (err) {
              this.send(client.ws, {
                type: 'tasks',
                success: false,
                error: 'Failed to read session file',
                requestId,
              });
            }
          } else {
            this.send(client.ws, {
              type: 'tasks',
              success: true,
              payload: { tasks: [], sessionId: tasksSessionId },
              requestId,
            });
          }
        } else {
          this.send(client.ws, {
            type: 'tasks',
            success: false,
            error: 'No session specified',
            requestId,
          });
        }
        break;

      case 'get_session_diff':
        this.handleGetSessionDiff(client, payload as { sessionId?: string } | undefined, requestId);
        break;

      case 'switch_session':
        // Handle switch_session asynchronously but await completion
        this.handleSwitchSession(
          client,
          payload as { sessionId: string; epoch?: number },
          requestId
        );
        // Acknowledge session — user is viewing it, cancel push escalation
        {
          const switchPayload = payload as { sessionId: string } | undefined;
          if (switchPayload?.sessionId) {
            this.escalation.acknowledgeSession(switchPayload.sessionId);
          }
        }
        break;

      case 'send_input':
        this.handleSendInput(client, payload as { input: string }, requestId);
        // Acknowledge session — user is responding, cancel push escalation
        {
          const activeSessionId = this.watcher.getActiveSessionId();
          if (activeSessionId) {
            this.escalation.acknowledgeSession(activeSessionId);
          }
        }
        break;

      case 'cancel_input':
        this.handleCancelInput(client, payload as { clientMessageId: string; tmuxSessionName?: string; sessionId?: string }, requestId);
        break;

      case 'send_image':
        this.handleSendImage(client, payload as { base64: string; mimeType: string }, requestId);
        break;

      case 'upload_image':
        // Just upload and save, don't send yet
        this.handleUploadImage(client, payload as { base64: string; mimeType: string }, requestId);
        break;

      case 'send_with_images':
        // Send message with image paths combined
        this.handleSendWithImages(
          client,
          payload as { imagePaths: string[]; message: string },
          requestId
        );
        break;

      case 'register_push':
        const pushPayload = payload as { fcmToken: string; deviceId: string; tokenType?: string };
        if (pushPayload?.fcmToken && pushPayload?.deviceId) {
          const isExpoToken = pushPayload.fcmToken.startsWith('ExponentPushToken');
          console.log(
            `Push registration: device=${pushPayload.deviceId}, type=${isExpoToken ? 'expo' : 'fcm'}, token=${pushPayload.fcmToken.substring(0, 30)}...`
          );
          // Link deviceId to this client for instant notify
          client.deviceId = pushPayload.deviceId;
          this.push.registerDevice(pushPayload.deviceId, pushPayload.fcmToken);
          this.send(client.ws, {
            type: 'push_registered',
            success: true,
            requestId,
          });
        } else {
          this.send(client.ws, {
            type: 'push_registered',
            success: false,
            error: 'Missing fcmToken or deviceId',
            requestId,
          });
        }
        break;

      case 'unregister_push':
        const unregPayload = payload as { deviceId: string };
        if (unregPayload?.deviceId) {
          this.push.unregisterDevice(unregPayload.deviceId);
          this.send(client.ws, {
            type: 'push_unregistered',
            success: true,
            requestId,
          });
        }
        break;

      // set_instant_notify removed — escalation model replaces per-device instant notify

      case 'set_auto_approve': {
        const autoApprovePayload = payload as { enabled: boolean; sessionId?: string };
        const targetSessionId = autoApprovePayload?.sessionId || this.watcher.getActiveSessionId();
        const enabled = autoApprovePayload?.enabled ?? false;

        if (targetSessionId) {
          if (enabled) {
            this.autoApproveSessions.add(targetSessionId);
          } else {
            this.autoApproveSessions.delete(targetSessionId);
          }
          console.log(
            `Auto-approve ${enabled ? 'enabled' : 'disabled'} for session ${targetSessionId} (${this.autoApproveSessions.size} sessions active)`
          );
        }

        this.send(client.ws, {
          type: 'auto_approve_set',
          success: true,
          payload: { enabled, sessionId: targetSessionId },
          requestId,
        });

        // When toggled ON, immediately check for pending tools that should be auto-approved
        if (enabled && targetSessionId) {
          this.watcher.checkAndEmitPendingApproval(targetSessionId);
        }
        break;
      }

      // set_notification_prefs removed — escalation config replaces per-device prefs

      case 'ping':
        if (client.deviceId) {
          this.push.updateDeviceLastSeen(client.deviceId);
        }
        this.send(client.ws, {
          type: 'pong',
          success: true,
          requestId,
        });
        break;

      case 'rotate_token':
        this.handleRotateToken(client, requestId);
        break;

      // Tmux session management
      case 'list_tmux_sessions':
        console.log('WebSocket: Received list_tmux_sessions request');
        this.handleListTmuxSessions(client, requestId);
        break;

      case 'get_terminal_output': {
        const termPayload = payload as { sessionName: string; lines?: number; offset?: number } | undefined;
        if (termPayload?.sessionName) {
          this.tmux
            .capturePane(termPayload.sessionName, termPayload.lines || 100, termPayload.offset || 0)
            .then((output) => {
              this.send(client.ws, {
                type: 'terminal_output',
                success: true,
                payload: { output, sessionName: termPayload.sessionName },
                requestId,
              });
            })
            .catch(() => {
              this.send(client.ws, {
                type: 'terminal_output',
                success: false,
                error: 'Failed to capture terminal output',
                requestId,
              });
            });
        } else {
          this.send(client.ws, {
            type: 'terminal_output',
            success: false,
            error: 'Missing sessionName',
            requestId,
          });
        }
        break;
      }

      case 'send_terminal_text': {
        const termTextPayload = payload as { sessionName: string; text: string } | undefined;
        if (termTextPayload?.sessionName && typeof termTextPayload.text === 'string') {
          this.tmux
            .sendKeys(termTextPayload.sessionName, termTextPayload.text)
            .then((ok) => {
              if (ok) {
                return this.tmux.sendRawKeys(termTextPayload.sessionName, ['Enter']);
              }
              return false;
            })
            .then((ok) => {
              this.send(client.ws, {
                type: 'terminal_text_sent',
                success: ok,
                error: ok ? undefined : 'Failed to send text',
                requestId,
              });
            })
            .catch(() => {
              this.send(client.ws, {
                type: 'terminal_text_sent',
                success: false,
                error: 'Failed to send terminal text',
                requestId,
              });
            });
        } else {
          this.send(client.ws, {
            type: 'terminal_text_sent',
            success: false,
            error: 'Missing sessionName or text',
            requestId,
          });
        }
        break;
      }

      case 'send_terminal_keys': {
        const termKeysPayload = payload as { sessionName: string; keys: string[] } | undefined;
        if (termKeysPayload?.sessionName && termKeysPayload.keys?.length) {
          this.tmux
            .sendRawKeys(termKeysPayload.sessionName, termKeysPayload.keys)
            .then((ok) => {
              this.send(client.ws, {
                type: 'terminal_keys_sent',
                success: ok,
                error: ok ? undefined : 'Failed to send keys',
                requestId,
              });
            })
            .catch(() => {
              this.send(client.ws, {
                type: 'terminal_keys_sent',
                success: false,
                error: 'Failed to send terminal keys',
                requestId,
              });
            });
        } else {
          this.send(client.ws, {
            type: 'terminal_keys_sent',
            success: false,
            error: 'Missing sessionName or keys',
            requestId,
          });
        }
        break;
      }

      case 'get_tool_config':
        this.send(client.ws, {
          type: 'tool_config',
          success: true,
          payload: { tools: DEFAULT_TOOL_CONFIG },
          requestId,
        });
        break;

      case 'create_tmux_session':
        this.handleCreateTmuxSession(
          client,
          payload as { name?: string; workingDir: string; startCli?: boolean },
          requestId
        );
        break;

      case 'kill_tmux_session':
        this.handleKillTmuxSession(client, payload as { sessionName: string }, requestId);
        break;

      case 'switch_tmux_session':
        this.handleSwitchTmuxSession(client, payload as { sessionName: string }, requestId);
        break;

      case 'recreate_tmux_session':
        this.handleRecreateTmuxSession(client, payload as { sessionName?: string }, requestId);
        break;

      case 'create_worktree_session':
        this.handleCreateWorktreeSession(
          client,
          payload as { parentDir: string; branch?: string; startCli?: boolean },
          requestId
        );
        break;

      case 'list_worktrees':
        this.handleListWorktrees(client, payload as { dir: string }, requestId);
        break;

      case 'browse_directories':
        this.handleBrowseDirectories(client, payload as { path?: string }, requestId);
        break;

      case 'read_file':
        this.handleReadFile(client, payload as { path: string }, requestId);
        break;

      case 'search_files':
        this.handleSearchFiles(client, payload as { query: string; limit?: number }, requestId);
        break;

      case 'check_files_exist':
        this.handleCheckFilesExist(client, payload as { paths: string[] }, requestId);
        break;

      case 'open_in_editor':
        this.handleOpenInEditor(client, payload as { path: string }, requestId);
        break;

      case 'download_file':
        this.handleDownloadFile(client, payload as { path: string }, requestId);
        break;

      case 'get_usage':
        this.handleGetUsage(client, requestId);
        break;

      case 'get_api_usage':
        this.handleGetApiUsage(
          client,
          payload as {
            period?: 'today' | 'month' | 'custom';
            startDate?: string;
            endDate?: string;
          },
          requestId
        );
        break;

      case 'get_cost_dashboard':
        this.handleGetCostDashboard(
          client,
          payload as { period?: '7d' | '30d' } | undefined,
          requestId
        );
        break;

      case 'get_oauth_usage':
        this.handleGetOAuthUsage(client, requestId);
        break;

      case 'get_agent_tree':
        this.handleGetAgentTree(client, payload as { sessionId?: string } | undefined, requestId);
        break;

      case 'get_agent_detail':
        this.handleGetAgentDetail(client, payload as { agentId: string } | undefined, requestId);
        break;

      case 'client_error':
        this.handleClientError(client, payload as ClientError, requestId);
        break;

      case 'get_client_errors':
        this.handleGetClientErrors(client, requestId);
        break;

      case 'scroll_log':
        this.handleScrollLog(payload as { event: string; ts: number; [key: string]: unknown });
        // No response needed - fire and forget
        break;

      case 'get_scroll_logs':
        this.handleGetScrollLogs(client, requestId);
        break;

      case 'clear_scroll_logs':
        this.scrollLogs = [];
        this.send(client.ws, { type: 'scroll_logs_cleared', success: true, requestId });
        break;

      // Work Group endpoints
      case 'spawn_work_group':
        this.handleSpawnWorkGroup(
          client,
          payload as {
            name: string;
            foremanSessionId: string;
            foremanTmuxSession: string;
            parentDir: string;
            planFile?: string;
            workers: {
              taskSlug: string;
              taskDescription: string;
              planSection: string;
              files: string[];
            }[];
          },
          requestId
        );
        break;

      case 'get_work_groups':
        this.handleGetWorkGroups(client, requestId);
        break;

      case 'get_work_group':
        this.handleGetWorkGroup(client, payload as { groupId: string }, requestId);
        break;

      case 'merge_work_group':
        this.handleMergeWorkGroup(client, payload as { groupId: string }, requestId);
        break;

      case 'cancel_work_group':
        this.handleCancelWorkGroup(client, payload as { groupId: string }, requestId);
        break;

      case 'retry_worker':
        this.handleRetryWorker(client, payload as { groupId: string; workerId: string }, requestId);
        break;

      case 'send_worker_input':
        this.handleSendWorkerInput(
          client,
          payload as { groupId: string; workerId: string; text: string },
          requestId
        );
        break;

      case 'dismiss_work_group':
        this.handleDismissWorkGroup(client, payload as { groupId: string }, requestId);
        break;

      // Scaffold endpoints
      case 'get_scaffold_templates': {
        const scaffoldPayload = payload as { description?: string } | undefined;
        const description = scaffoldPayload?.description;

        if (description && description.trim()) {
          const scores = scoreTemplates(scaffoldTemplates, description);
          const scoreMap = new Map(scores.map((s) => [s.templateId, s]));

          // Sort templates by score descending
          const sorted = [...scaffoldTemplates].sort((a, b) => {
            const sa = scoreMap.get(a.id)?.score ?? 0;
            const sb = scoreMap.get(b.id)?.score ?? 0;
            return sb - sa;
          });

          this.send(client.ws, {
            type: 'scaffold_templates',
            success: true,
            payload: {
              templates: sorted.map((t) => {
                const s = scoreMap.get(t.id);
                return {
                  id: t.id,
                  name: t.name,
                  description: t.description,
                  type: t.type,
                  icon: t.icon,
                  tags: t.tags,
                  score: s?.score ?? 0,
                  matchedKeywords: s?.matchedKeywords ?? [],
                };
              }),
            },
            requestId,
          });
        } else {
          this.send(client.ws, {
            type: 'scaffold_templates',
            success: true,
            payload: {
              templates: scaffoldTemplates.map((t) => ({
                id: t.id,
                name: t.name,
                description: t.description,
                type: t.type,
                icon: t.icon,
                tags: t.tags,
              })),
            },
            requestId,
          });
        }
        break;
      }

      case 'scaffold_preview':
        (async () => {
          const previewConfig = payload as ProjectConfig;
          const previewResult = await previewScaffold(previewConfig);
          this.send(client.ws, {
            type: 'scaffold_preview',
            success: !('error' in previewResult),
            payload: previewResult,
            requestId,
          });
        })();
        break;

      // Escalation config endpoints (replaces notification rules CRUD)
      case 'get_escalation_config': {
        const store = this.push.getStore();
        this.send(client.ws, {
          type: 'escalation_config',
          success: true,
          payload: { config: store.getEscalation() },
          requestId,
        });
        break;
      }

      case 'update_escalation_config': {
        const configPayload = payload as Partial<EscalationConfig>;
        const store = this.push.getStore();
        const updated = store.setEscalation(configPayload);
        this.send(client.ws, {
          type: 'escalation_config_updated',
          success: true,
          payload: { config: updated },
          requestId,
        });
        break;
      }

      case 'get_pending_events': {
        const events = this.escalation.getPendingEvents();
        this.send(client.ws, {
          type: 'pending_events',
          success: true,
          payload: { events },
          requestId,
        });
        break;
      }

      // Device management
      case 'get_devices': {
        const store = this.push.getStore();
        this.send(client.ws, {
          type: 'devices',
          success: true,
          payload: { devices: store.getDevices() },
          requestId,
        });
        break;
      }

      case 'remove_device': {
        const removePayload = payload as { deviceId: string };
        if (!removePayload?.deviceId) {
          this.send(client.ws, {
            type: 'device_removed',
            success: false,
            error: 'Missing deviceId',
            requestId,
          });
          break;
        }
        const store = this.push.getStore();
        const removed = store.removeDevice(removePayload.deviceId);
        this.send(client.ws, {
          type: 'device_removed',
          success: removed,
          error: removed ? undefined : 'Device not found',
          requestId,
        });
        break;
      }

      // Session muting
      case 'set_session_muted': {
        const mutePayload = payload as { sessionId: string; muted: boolean };
        if (!mutePayload?.sessionId || mutePayload.muted === undefined) {
          this.send(client.ws, {
            type: 'session_muted_set',
            success: false,
            error: 'Missing sessionId or muted',
            requestId,
          });
          break;
        }
        const store = this.push.getStore();
        store.setSessionMuted(mutePayload.sessionId, mutePayload.muted);
        this.send(client.ws, {
          type: 'session_muted_set',
          success: true,
          payload: { sessionId: mutePayload.sessionId, muted: mutePayload.muted },
          requestId,
        });
        // Broadcast to all clients so mute state is visible everywhere
        this.broadcast('session_mute_changed', {
          sessionId: mutePayload.sessionId,
          muted: mutePayload.muted,
        });
        break;
      }

      case 'get_muted_sessions': {
        const store = this.push.getStore();
        this.send(client.ws, {
          type: 'muted_sessions',
          success: true,
          payload: { sessionIds: store.getMutedSessions() },
          requestId,
        });
        break;
      }

      // Notification history
      case 'get_notification_history': {
        const histPayload = payload as { limit?: number } | undefined;
        const store = this.push.getStore();
        const history = store.getHistory(histPayload?.limit);
        this.send(client.ws, {
          type: 'notification_history',
          success: true,
          payload: history,
          requestId,
        });
        break;
      }

      case 'get_digest': {
        const digestPayload = payload as { since?: number } | undefined;
        const since = digestPayload?.since ?? (Date.now() - 24 * 60 * 60 * 1000); // default: last 24h
        const store = this.push.getStore();
        const digest = store.getHistorySince(since);
        this.send(client.ws, {
          type: 'digest',
          success: true,
          payload: { entries: digest.entries, total: digest.total, since },
          requestId,
        });
        break;
      }

      case 'clear_notification_history': {
        const store = this.push.getStore();
        store.clearHistory();
        this.send(client.ws, {
          type: 'notification_history_cleared',
          success: true,
          requestId,
        });
        break;
      }

      case 'send_test_notification': {
        (async () => {
          try {
            const result = await this.push.sendTestNotification();
            this.send(client.ws, {
              type: 'test_notification_sent',
              success: true,
              payload: result,
              requestId,
            });
          } catch (err) {
            this.send(client.ws, {
              type: 'test_notification_sent',
              success: false,
              error: String(err),
              requestId,
            });
          }
        })();
        break;
      }

      case 'scaffold_create':
        (async () => {
          try {
            const createConfig = payload as ProjectConfig;
            console.log(
              'Scaffold: Creating project',
              createConfig.name,
              'at',
              createConfig.location
            );
            const createResult = await scaffoldProject(createConfig, (progress) => {
              console.log('Scaffold progress:', progress.step, progress.detail || '');
              // Send progress updates
              this.send(client.ws, {
                type: 'scaffold_progress',
                success: true,
                payload: progress,
              });
            });
            console.log('Scaffold result:', createResult.success ? 'success' : createResult.error);
            this.send(client.ws, {
              type: 'scaffold_result',
              success: createResult.success,
              payload: createResult,
              requestId,
            });
          } catch (err) {
            console.error('Scaffold error:', err);
            this.send(client.ws, {
              type: 'scaffold_result',
              success: false,
              error: err instanceof Error ? err.message : String(err),
              requestId,
            });
          }
        })();
        break;

      case 'list_skills':
        this.handleListSkills(client, requestId);
        break;

      case 'install_skill':
        this.handleInstallSkill(
          client,
          payload as { skillId: string; target: 'project' | 'global' },
          requestId
        );
        break;

      case 'uninstall_skill':
        this.handleUninstallSkill(
          client,
          payload as { skillId: string; source: 'project' | 'global' },
          requestId
        );
        break;

      case 'get_skill_content':
        this.handleGetSkillContent(client, payload as { skillId: string }, requestId);
        break;

      case 'search_conversations':
        this.handleSearchConversations(client, payload as { query: string; limit?: number }, requestId);
        break;

      case 'get_conversation_file':
        this.handleGetConversationFile(client, payload as { filePath: string; limit?: number; offset?: number }, requestId);
        break;

      default:
        this.send(client.ws, {
          type: 'error',
          success: false,
          error: `Unknown message type: ${type}`,
          requestId,
        });
    }
  }

  /**
   * Resolve a sessionId to a tmux session name.
   * If sessionId already matches a tmux session, return it directly.
   * Otherwise, look up the session's projectPath and find the matching tmux session.
   */
  private async resolveTmuxSession(sessionId: string): Promise<string | null> {
    // Check if sessionId is already a tmux session name
    const tmuxSessions = await this.tmux.listSessions();
    if (tmuxSessions.some(ts => ts.name === sessionId)) {
      return sessionId;
    }

    // Look up projectPath from watcher status
    const status = this.watcher.getStatus(sessionId);
    if (status?.projectPath) {
      const match = tmuxSessions.find(ts => ts.workingDir === status.projectPath);
      if (match) return match.name;
    }

    return null;
  }

  private async handleGetSessionDiff(
    client: AuthenticatedClient,
    payload: { sessionId?: string } | undefined,
    requestId?: string,
  ): Promise<void> {
    const sessionId = payload?.sessionId || this.watcher.getActiveSessionId();
    if (!sessionId) {
      this.send(client.ws, {
        type: 'session_diff',
        success: false,
        error: 'No session specified',
        requestId,
      });
      return;
    }

    const sessions = this.watcher.getSessions();
    const session = sessions.find((s) => s.id === sessionId);
    if (!session?.conversationPath) {
      this.send(client.ws, {
        type: 'session_diff',
        success: true,
        payload: { fileChanges: [], sessionId },
        requestId,
      });
      return;
    }

    try {
      const content = fs.readFileSync(session.conversationPath, 'utf-8');
      const fileChanges = extractFileChanges(content);

      // Try to get git diffs for each file using the session's working directory
      const workingDir = session.projectPath;
      if (workingDir) {
        const diffPromises = fileChanges.map(async (fc) => {
          try {
            const { stdout } = await execAsync(
              `git diff HEAD -- ${JSON.stringify(fc.path)} 2>/dev/null || git diff -- ${JSON.stringify(fc.path)} 2>/dev/null`,
              { cwd: workingDir, timeout: 5000 },
            );
            return { ...fc, diff: stdout || undefined };
          } catch {
            return fc;
          }
        });
        const changesWithDiffs = await Promise.all(diffPromises);
        this.send(client.ws, {
          type: 'session_diff',
          success: true,
          payload: { fileChanges: changesWithDiffs, sessionId },
          requestId,
        });
      } else {
        this.send(client.ws, {
          type: 'session_diff',
          success: true,
          payload: { fileChanges, sessionId },
          requestId,
        });
      }
    } catch (err) {
      this.send(client.ws, {
        type: 'session_diff',
        success: false,
        error: `Failed to get session diff: ${err}`,
        requestId,
      });
    }
  }

  private async handleSendInput(
    client: AuthenticatedClient,
    payload: { input: string; sessionId?: string; tmuxSessionName?: string; clientMessageId?: string } | undefined,
    requestId?: string
  ): Promise<void> {
    if (!payload?.input) {
      this.send(client.ws, {
        type: 'input_sent',
        success: false,
        error: 'Missing input',
        requestId,
      });
      return;
    }

    // Resolve sessionId to tmux session name
    let sessionToUse: string;
    if (payload.tmuxSessionName) {
      sessionToUse = payload.tmuxSessionName;
    } else if (payload.sessionId) {
      const resolved = await this.resolveTmuxSession(payload.sessionId);
      sessionToUse = resolved || payload.sessionId;
    } else {
      sessionToUse = this.injector.getActiveSession();
    }

    // Check if the target session exists before trying to send
    const sessionExists = await this.injector.checkSessionExists(sessionToUse);

    if (!sessionExists) {
      // Check if we have a stored config for this session
      const savedConfig = this.tmuxSessionConfigs.get(sessionToUse);

      this.send(client.ws, {
        type: 'input_sent',
        success: false,
        error: 'tmux_session_not_found',
        payload: {
          sessionName: sessionToUse,
          canRecreate: !!savedConfig,
          savedConfig: savedConfig
            ? {
                name: savedConfig.name,
                workingDir: savedConfig.workingDir,
              }
            : undefined,
        },
        requestId,
      });
      return;
    }

    const success = await this.injector.sendInput(payload.input, sessionToUse);

    // Track pending sent message for optimistic display in get_highlights
    if (success && payload.clientMessageId) {
      const pending = this.pendingSentMessages.get(sessionToUse) || [];
      pending.push({
        clientMessageId: payload.clientMessageId,
        content: payload.input,
        sentAt: Date.now(),
      });
      this.pendingSentMessages.set(sessionToUse, pending);
    }

    this.send(client.ws, {
      type: 'input_sent',
      success,
      error: success ? undefined : 'Failed to send input to session',
      requestId,
    });
  }

  private async handleCancelInput(
    client: AuthenticatedClient,
    payload: { clientMessageId: string; tmuxSessionName?: string; sessionId?: string } | undefined,
    requestId?: string
  ): Promise<void> {
    if (!payload?.clientMessageId) {
      this.send(client.ws, { type: 'cancel_input', success: false, error: 'No clientMessageId', requestId });
      return;
    }

    // Resolve tmux session
    let sessionToUse = payload.tmuxSessionName || undefined;
    if (!sessionToUse && payload.sessionId) {
      sessionToUse = this.watcher.getTmuxSessionForConversation(payload.sessionId) || undefined;
    }

    // Remove from pending messages
    let removed = false;
    for (const [tmuxName, pending] of this.pendingSentMessages) {
      const idx = pending.findIndex(p => p.clientMessageId === payload.clientMessageId);
      if (idx !== -1) {
        pending.splice(idx, 1);
        if (pending.length === 0) this.pendingSentMessages.delete(tmuxName);
        removed = true;
        sessionToUse = sessionToUse || tmuxName;
        console.log(`[CANCEL] Removed pending message ${payload.clientMessageId} from ${tmuxName}`);
        break;
      }
    }

    // Send Ctrl+C to abort if we know the session
    if (sessionToUse) {
      await this.injector.cancelInput(sessionToUse);
      console.log(`[CANCEL] Sent Ctrl+C to tmux="${sessionToUse}"`);
    }

    this.send(client.ws, {
      type: 'cancel_input',
      success: true,
      payload: { removed, clientMessageId: payload.clientMessageId },
      requestId,
    });
  }

  private async handleSendImage(
    client: AuthenticatedClient,
    payload: { base64: string; mimeType: string } | undefined,
    requestId?: string
  ): Promise<void> {
    if (!payload?.base64) {
      this.send(client.ws, {
        type: 'image_sent',
        success: false,
        error: 'Missing image data',
        requestId,
      });
      return;
    }

    try {
      // Determine file extension from mime type
      const ext = payload.mimeType === 'image/png' ? 'png' : 'jpg';
      const filename = `companion-${Date.now()}.${ext}`;
      const filepath = path.join(os.tmpdir(), filename);

      // Save image to temp file
      const buffer = Buffer.from(payload.base64, 'base64');
      fs.writeFileSync(filepath, buffer);

      console.log(`Image saved to: ${filepath}`);

      // Send the file path to the coding session
      const success = await this.injector.sendInput(`Please look at this image: ${filepath}`);

      this.send(client.ws, {
        type: 'image_sent',
        success,
        payload: { filepath },
        error: success ? undefined : 'Failed to send image path to session',
        requestId,
      });
    } catch (err) {
      console.error('Error saving image:', err);
      this.send(client.ws, {
        type: 'image_sent',
        success: false,
        error: 'Failed to save image',
        requestId,
      });
    }
  }

  private async handleUploadImage(
    client: AuthenticatedClient,
    payload: { base64: string; mimeType: string } | undefined,
    requestId?: string
  ): Promise<void> {
    if (!payload?.base64) {
      this.send(client.ws, {
        type: 'image_uploaded',
        success: false,
        error: 'Missing image data',
        requestId,
      });
      return;
    }

    try {
      const ext = payload.mimeType === 'image/png' ? 'png' : 'jpg';
      const filename = `companion-${Date.now()}.${ext}`;
      const filepath = path.join(os.tmpdir(), filename);

      const buffer = Buffer.from(payload.base64, 'base64');
      fs.writeFileSync(filepath, buffer);

      console.log(`Image uploaded to: ${filepath}`);

      this.send(client.ws, {
        type: 'image_uploaded',
        success: true,
        payload: { filepath },
        requestId,
      });
    } catch (err) {
      console.error('Error uploading image:', err);
      this.send(client.ws, {
        type: 'image_uploaded',
        success: false,
        error: 'Failed to save image',
        requestId,
      });
    }
  }

  private async handleSendWithImages(
    client: AuthenticatedClient,
    payload: { imagePaths: string[]; message: string; tmuxSessionName?: string } | undefined,
    requestId?: string
  ): Promise<void> {
    if (!payload) {
      this.send(client.ws, {
        type: 'message_sent',
        success: false,
        error: 'Missing payload',
        requestId,
      });
      return;
    }

    // Build combined message: image paths + user message
    const parts: string[] = [];

    if (payload.imagePaths && payload.imagePaths.length > 0) {
      for (const imgPath of payload.imagePaths) {
        parts.push(`[image: ${imgPath}]`);
      }
    }

    if (payload.message && payload.message.trim()) {
      parts.push(payload.message.trim());
    }

    const combinedMessage = parts.join(' ');

    if (!combinedMessage) {
      this.send(client.ws, {
        type: 'message_sent',
        success: false,
        error: 'No content to send',
        requestId,
      });
      return;
    }

    const targetSession = payload.tmuxSessionName || this.injector.getActiveSession();
    const success = await this.injector.sendInput(combinedMessage, targetSession);
    this.send(client.ws, {
      type: 'message_sent',
      success,
      error: success ? undefined : 'Failed to send message',
      requestId,
    });
  }

  /**
   * Handle session switch synchronously - waits for tmux switch to complete
   * before returning success. This prevents race conditions.
   */
  private async handleSwitchSession(
    client: AuthenticatedClient,
    payload: { sessionId: string; epoch?: number } | undefined,
    requestId?: string
  ): Promise<void> {
    if (!payload?.sessionId) {
      this.send(client.ws, {
        type: 'session_switched',
        success: false,
        error: 'Missing sessionId',
        requestId,
      });
      return;
    }

    const { sessionId, epoch } = payload;
    console.log(`WebSocket: Switching to session ${sessionId} (epoch: ${epoch})`);

    // Update client's subscription to this session
    client.subscribedSessionId = sessionId;

    // Resolve sessionId to tmux session name for the injector
    const tmuxName = await this.resolveTmuxSession(sessionId);
    if (tmuxName) {
      this.injector.setActiveSession(tmuxName);
    }

    // 4. Return success with session context
    this.send(client.ws, {
      type: 'session_switched',
      success: true,
      payload: {
        sessionId,
        tmuxSession: tmuxName || sessionId,
        epoch,
      },
      sessionId,
      requestId,
    } as WebSocketResponse);
  }

  private handleRotateToken(client: AuthenticatedClient, requestId?: string): void {
    try {
      if (!client.listenerPort) {
        throw new Error('Client has no listener port');
      }

      // Generate new token
      const newToken = crypto.randomBytes(32).toString('hex');

      // Update config file - find and update the listener for this port
      const config = loadConfig();
      const listenerIndex = config.listeners.findIndex((l) => l.port === client.listenerPort);
      if (listenerIndex === -1) {
        throw new Error(`Listener not found for port ${client.listenerPort}`);
      }
      config.listeners[listenerIndex].token = newToken;
      saveConfig(config);

      // Update in-memory token for this listener
      this.tokenMap.set(client.listenerPort, newToken);

      // Notify the requesting client of the new token
      this.send(client.ws, {
        type: 'token_rotated',
        success: true,
        payload: { newToken },
        requestId,
      });

      console.log(`WebSocket: Token rotated successfully for port ${client.listenerPort}`);

      // Disconnect other clients on the same listener (they need to re-authenticate)
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

  // Tmux session management handlers

  private async handleListTmuxSessions(
    client: AuthenticatedClient,
    requestId?: string
  ): Promise<void> {
    try {
      const sessions = await this.tmux.listSessions();
      const activeSession = this.injector.getActiveSession();

      this.send(client.ws, {
        type: 'tmux_sessions',
        success: true,
        payload: {
          sessions,
          activeSession,
          homeDir: this.tmux.getHomeDir(),
        },
        requestId,
      });
    } catch (err) {
      this.send(client.ws, {
        type: 'tmux_sessions',
        success: false,
        error: 'Failed to list sessions',
        requestId,
      });
    }
  }

  private async handleCreateTmuxSession(
    client: AuthenticatedClient,
    payload: { name?: string; workingDir: string; startCli?: boolean } | undefined,
    requestId?: string
  ): Promise<void> {
    if (!payload?.workingDir) {
      this.send(client.ws, {
        type: 'tmux_session_created',
        success: false,
        error: 'Missing workingDir',
        requestId,
      });
      return;
    }

    // Validate directory exists
    if (!fs.existsSync(payload.workingDir)) {
      this.send(client.ws, {
        type: 'tmux_session_created',
        success: false,
        error: `Directory does not exist: ${payload.workingDir}`,
        requestId,
      });
      return;
    }

    const sessionName = payload.name || this.tmux.generateSessionName(payload.workingDir);
    const startCli = payload.startCli !== false; // Default true

    console.log(`WebSocket: Creating tmux session "${sessionName}" in ${payload.workingDir}`);

    const result = await this.tmux.createSession(sessionName, payload.workingDir, startCli);

    if (result.success) {
      // Store the session config for potential recreation later
      this.storeTmuxSessionConfig(sessionName, payload.workingDir, startCli);

      // Switch input target to the new session
      this.injector.setActiveSession(sessionName);

      // Mark session as newly created so path-based resolution won't return
      // a stale conversation from the same directory
      this.watcher.markSessionAsNew(sessionName);

      // Clear the active session pointer so the UI shows empty until the new
      // CLI writes its JSONL (old sessions for this dir remain in the list)
      this.watcher.clearActiveSession();
      console.log(`WebSocket: Cleared active session after creating tmux session "${sessionName}"`);

      // Immediately refresh tmux paths so the watcher recognizes the new session's
      // conversation files as soon as they appear (otherwise waits up to 5s)
      await this.watcher.refreshTmuxPaths();

      this.send(client.ws, {
        type: 'tmux_session_created',
        success: true,
        payload: {
          sessionName,
          workingDir: payload.workingDir,
        },
        requestId,
      });

      // Broadcast to all clients that sessions changed
      this.broadcast('tmux_sessions_changed', { action: 'created', sessionName });
    } else {
      this.send(client.ws, {
        type: 'tmux_session_created',
        success: false,
        error: result.error,
        requestId,
      });
    }
  }

  private async handleKillTmuxSession(
    client: AuthenticatedClient,
    payload: { sessionName: string } | undefined,
    requestId?: string
  ): Promise<void> {
    if (!payload?.sessionName) {
      this.send(client.ws, {
        type: 'tmux_session_killed',
        success: false,
        error: 'Missing sessionName',
        requestId,
      });
      return;
    }

    console.log(`WebSocket: Killing tmux session "${payload.sessionName}"`);

    const result = await this.tmux.killSession(payload.sessionName);

    if (result.success) {
      // If this was a worktree session, clean up the worktree
      const config = this.tmuxSessionConfigs.get(payload.sessionName);
      if (config?.isWorktree && config.mainRepoDir) {
        console.log(`WebSocket: Cleaning up worktree at ${config.workingDir}`);
        await this.tmux.removeWorktree(config.mainRepoDir, config.workingDir);
      }

      // If we killed the active session, switch to another
      if (this.injector.getActiveSession() === payload.sessionName) {
        const remaining = await this.tmux.listSessions();
        if (remaining.length > 0) {
          this.injector.setActiveSession(remaining[0].name);
        }
      }

      this.send(client.ws, {
        type: 'tmux_session_killed',
        success: true,
        payload: { sessionName: payload.sessionName },
        requestId,
      });

      // Broadcast to all clients
      this.broadcast('tmux_sessions_changed', {
        action: 'killed',
        sessionName: payload.sessionName,
      });
    } else {
      this.send(client.ws, {
        type: 'tmux_session_killed',
        success: false,
        error: result.error,
        requestId,
      });
    }
  }

  private async handleCreateWorktreeSession(
    client: AuthenticatedClient,
    payload: { parentDir: string; branch?: string; startCli?: boolean } | undefined,
    requestId?: string
  ): Promise<void> {
    if (!payload?.parentDir) {
      this.send(client.ws, {
        type: 'worktree_session_created',
        success: false,
        error: 'Missing parentDir',
        requestId,
      });
      return;
    }

    // Validate parent directory is a git repo
    if (!(await this.tmux.isGitRepo(payload.parentDir))) {
      this.send(client.ws, {
        type: 'worktree_session_created',
        success: false,
        error: 'Not a git repository',
        requestId,
      });
      return;
    }

    console.log(
      `WebSocket: Creating worktree session from ${payload.parentDir}, branch: ${payload.branch || 'auto'}`
    );

    // Create the git worktree
    const wtResult = await this.tmux.createWorktree(payload.parentDir, payload.branch);
    if (!wtResult.success || !wtResult.worktreePath) {
      this.send(client.ws, {
        type: 'worktree_session_created',
        success: false,
        error: wtResult.error || 'Failed to create worktree',
        requestId,
      });
      return;
    }

    // Create a tmux session in the worktree directory
    const sessionName = this.tmux.generateSessionName(wtResult.worktreePath);
    const startCli = payload.startCli !== false;
    const tmuxResult = await this.tmux.createSession(sessionName, wtResult.worktreePath, startCli);

    if (tmuxResult.success) {
      // Store session config with worktree metadata
      this.storeTmuxSessionConfig(sessionName, wtResult.worktreePath, startCli);

      // Also store worktree info in the config
      const configs = this.tmuxSessionConfigs;
      const config = configs.get(sessionName);
      if (config) {
        config.isWorktree = true;
        config.mainRepoDir = payload.parentDir;
        config.branch = wtResult.branch;
        this.saveTmuxSessionConfigs();
      }

      // Switch input target to the new session
      this.injector.setActiveSession(sessionName);
      this.watcher.clearActiveSession();
      await this.watcher.refreshTmuxPaths();

      this.send(client.ws, {
        type: 'worktree_session_created',
        success: true,
        payload: {
          sessionName,
          workingDir: wtResult.worktreePath,
          branch: wtResult.branch,
          mainRepoDir: payload.parentDir,
        },
        requestId,
      });

      this.broadcast('tmux_sessions_changed', {
        action: 'created',
        sessionName,
        isWorktree: true,
        branch: wtResult.branch,
      });
    } else {
      // Clean up the worktree since tmux session failed
      await this.tmux.removeWorktree(payload.parentDir, wtResult.worktreePath);
      this.send(client.ws, {
        type: 'worktree_session_created',
        success: false,
        error: tmuxResult.error || 'Failed to create tmux session',
        requestId,
      });
    }
  }

  private async handleListWorktrees(
    client: AuthenticatedClient,
    payload: { dir: string } | undefined,
    requestId?: string
  ): Promise<void> {
    if (!payload?.dir) {
      this.send(client.ws, {
        type: 'worktrees_list',
        success: false,
        error: 'Missing dir',
        requestId,
      });
      return;
    }

    const worktrees = await this.tmux.listWorktrees(payload.dir);
    this.send(client.ws, {
      type: 'worktrees_list',
      success: true,
      payload: { worktrees },
      requestId,
    });
  }

  private async handleSwitchTmuxSession(
    client: AuthenticatedClient,
    payload: { sessionName: string } | undefined,
    requestId?: string
  ): Promise<void> {
    if (!payload?.sessionName) {
      this.send(client.ws, {
        type: 'tmux_session_switched',
        success: false,
        error: 'Missing sessionName',
        requestId,
      });
      return;
    }

    // Verify session exists
    const exists = await this.tmux.sessionExists(payload.sessionName);
    if (!exists) {
      this.send(client.ws, {
        type: 'tmux_session_switched',
        success: false,
        error: `Session "${payload.sessionName}" does not exist`,
        requestId,
      });
      return;
    }

    // Switch input target to this tmux session
    this.injector.setActiveSession(payload.sessionName);
    console.log(`WebSocket: Switched to tmux session "${payload.sessionName}"`);

    // Tag the session as managed by Companion (adopt if not already tagged)
    await this.tmux.tagSession(payload.sessionName);
    // Refresh tmux paths so watcher picks up the newly tagged session
    await this.watcher.refreshTmuxPaths();

    // Try to find and switch to the corresponding conversation session
    // Get the tmux session's working directory
    const sessions = await this.tmux.listSessions();
    const tmuxSession = sessions.find((s) => s.name === payload.sessionName);
    let conversationSessionId: string | undefined;

    if (tmuxSession?.workingDir) {
      // Store the session config for potential recreation later
      this.storeTmuxSessionConfig(payload.sessionName, tmuxSession.workingDir, true);

      // With UUID-based session IDs, match by projectPath instead of encoded ID
      const convSessions = this.watcher.getSessions();
      const matchingConv = convSessions.find((cs) => cs.projectPath === tmuxSession!.workingDir);

      if (matchingConv) {
        this.watcher.setActiveSession(matchingConv.id);
        conversationSessionId = matchingConv.id;
        console.log(
          `WebSocket: Switched conversation to "${matchingConv.id}" for project ${tmuxSession.workingDir}`
        );
      } else {
        // No conversation yet for this project - clear active session so old data stops flowing
        this.watcher.clearActiveSession();
        console.log(
          `WebSocket: No conversation found for ${tmuxSession!.workingDir}, cleared active session. Available: ${convSessions.map((c) => c.id).join(', ')}`
        );
      }
    } else {
      // No working directory - clear active session
      this.watcher.clearActiveSession();
      console.log(`WebSocket: No working directory for tmux session, cleared active session`);
    }

    this.send(client.ws, {
      type: 'tmux_session_switched',
      success: true,
      payload: {
        sessionName: payload.sessionName,
        conversationSessionId,
      },
      requestId,
    });
  }

  private async handleRecreateTmuxSession(
    client: AuthenticatedClient,
    payload: { sessionName?: string } | undefined,
    requestId?: string
  ): Promise<void> {
    // Use provided session name or the currently active one
    const sessionName = payload?.sessionName || this.injector.getActiveSession();
    const savedConfig = this.tmuxSessionConfigs.get(sessionName);

    if (!savedConfig) {
      this.send(client.ws, {
        type: 'tmux_session_recreated',
        success: false,
        error: `No saved configuration for session "${sessionName}"`,
        requestId,
      });
      return;
    }

    // Check if directory still exists
    if (!fs.existsSync(savedConfig.workingDir)) {
      this.send(client.ws, {
        type: 'tmux_session_recreated',
        success: false,
        error: `Working directory no longer exists: ${savedConfig.workingDir}`,
        requestId,
      });
      return;
    }

    // Check if session already exists (maybe it was recreated manually)
    const exists = await this.tmux.sessionExists(sessionName);
    if (exists) {
      this.send(client.ws, {
        type: 'tmux_session_recreated',
        success: true,
        payload: {
          sessionName,
          workingDir: savedConfig.workingDir,
          alreadyExisted: true,
        },
        requestId,
      });
      return;
    }

    console.log(`WebSocket: Recreating tmux session "${sessionName}" in ${savedConfig.workingDir}`);

    const result = await this.tmux.createSession(
      savedConfig.name,
      savedConfig.workingDir,
      savedConfig.startCli
    );

    if (result.success) {
      // Update the last used timestamp
      this.storeTmuxSessionConfig(savedConfig.name, savedConfig.workingDir, savedConfig.startCli);

      // Ensure we're targeting this session
      this.injector.setActiveSession(sessionName);

      this.send(client.ws, {
        type: 'tmux_session_recreated',
        success: true,
        payload: {
          sessionName,
          workingDir: savedConfig.workingDir,
        },
        requestId,
      });

      // Broadcast to all clients
      this.broadcast('tmux_sessions_changed', { action: 'recreated', sessionName });
    } else {
      this.send(client.ws, {
        type: 'tmux_session_recreated',
        success: false,
        error: result.error,
        requestId,
      });
    }
  }

  private async handleBrowseDirectories(
    client: AuthenticatedClient,
    payload: { path?: string } | undefined,
    requestId?: string
  ): Promise<void> {
    const basePath = payload?.path || this.tmux.getHomeDir();

    try {
      // Get directory contents
      const entries: Array<{ name: string; path: string; isDirectory: boolean }> = [];

      // Add parent directory option if not at root
      if (basePath !== '/') {
        entries.push({
          name: '..',
          path: path.dirname(basePath),
          isDirectory: true,
        });
      }

      const items = fs.readdirSync(basePath, { withFileTypes: true });

      for (const item of items) {
        // Skip hidden files and common non-project directories
        if (item.name.startsWith('.') && item.name !== '..') continue;
        if (['node_modules', '__pycache__', 'venv', '.git'].includes(item.name)) continue;

        if (item.isDirectory()) {
          entries.push({
            name: item.name,
            path: path.join(basePath, item.name),
            isDirectory: true,
          });
        }
      }

      // Sort: directories first, then alphabetically
      entries.sort((a, b) => {
        if (a.name === '..') return -1;
        if (b.name === '..') return 1;
        return a.name.localeCompare(b.name);
      });

      this.send(client.ws, {
        type: 'directory_listing',
        success: true,
        payload: {
          currentPath: basePath,
          entries: entries.slice(0, 100), // Limit to 100 entries
        },
        requestId,
      });
    } catch (err) {
      this.send(client.ws, {
        type: 'directory_listing',
        success: false,
        error: `Cannot read directory: ${basePath}`,
        requestId,
      });
    }
  }

  private async handleReadFile(
    client: AuthenticatedClient,
    payload: { path: string } | undefined,
    requestId?: string
  ): Promise<void> {
    const filePath = payload?.path;

    if (!filePath) {
      this.send(client.ws, {
        type: 'file_content',
        success: false,
        error: 'No file path provided',
        requestId,
      });
      return;
    }

    try {
      const homeDir = this.tmux.getHomeDir();
      let resolvedPath: string;

      // Handle different path formats
      if (filePath.startsWith('~/')) {
        // Expand ~ to home directory
        resolvedPath = path.join(homeDir, filePath.slice(2));
      } else if (filePath.startsWith('/')) {
        // Absolute path
        resolvedPath = filePath;
      } else {
        // Relative path - resolve against active tmux session's working directory
        // (more reliable than decoded project path which can mangle hyphenated names)
        const activeSessionId = this.watcher.getActiveSessionId();

        // Try to find working directory from the active conversation's projectPath
        let workingDir = homeDir;
        if (activeSessionId) {
          const convSession = this.watcher.getSessions().find((s) => s.id === activeSessionId);
          if (convSession?.projectPath) {
            workingDir = convSession.projectPath;
          }
        }

        resolvedPath = path.resolve(workingDir, filePath);
      }

      // Normalize the path
      resolvedPath = path.normalize(resolvedPath);

      // Security: only allow reading files in certain directories
      const allowedPaths = [homeDir, '/tmp', '/var/tmp'];

      const isAllowed = allowedPaths.some((allowed) => resolvedPath.startsWith(allowed));

      if (!isAllowed) {
        this.send(client.ws, {
          type: 'file_content',
          success: false,
          error: `Access denied: file outside allowed directories (resolved: ${resolvedPath})`,
          requestId,
        });
        return;
      }

      // Check file exists and is readable
      const stats = fs.statSync(resolvedPath);

      if (stats.isDirectory()) {
        this.send(client.ws, {
          type: 'file_content',
          success: false,
          error: 'Path is a directory, not a file',
          requestId,
        });
        return;
      }

      // Limit file size (5MB for images, 1MB for text)
      const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp']);
      const ext = path.extname(resolvedPath).slice(1).toLowerCase();
      const isImageExt = IMAGE_EXTS.has(ext);
      const maxSize = isImageExt ? 5 * 1024 * 1024 : 1024 * 1024;

      if (stats.size > maxSize) {
        this.send(client.ws, {
          type: 'file_content',
          success: false,
          error: `File too large (max ${isImageExt ? '5MB' : '1MB'})`,
          requestId,
        });
        return;
      }

      // Detect binary: read first 8KB and check for null bytes
      const MIME_TYPES: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
        ico: 'image/x-icon', bmp: 'image/bmp',
      };

      if (isImageExt) {
        // Return base64-encoded image
        const buf = fs.readFileSync(resolvedPath);
        const base64 = buf.toString('base64');
        this.send(client.ws, {
          type: 'file_content',
          success: true,
          payload: {
            content: base64,
            path: resolvedPath,
            encoding: 'base64',
            mimeType: MIME_TYPES[ext] || 'application/octet-stream',
          },
          requestId,
        });
        return;
      }

      // Check for binary content (null bytes in first 8KB)
      const probe = Buffer.alloc(Math.min(8192, stats.size));
      const fd = fs.openSync(resolvedPath, 'r');
      fs.readSync(fd, probe, 0, probe.length, 0);
      fs.closeSync(fd);
      const isBinary = probe.includes(0);

      if (isBinary) {
        this.send(client.ws, {
          type: 'file_content',
          success: true,
          payload: { binary: true, size: stats.size, path: resolvedPath },
          requestId,
        });
        return;
      }

      const content = fs.readFileSync(resolvedPath, 'utf-8');

      this.send(client.ws, {
        type: 'file_content',
        success: true,
        payload: { content, path: resolvedPath },
        requestId,
      });
    } catch (err) {
      this.send(client.ws, {
        type: 'file_content',
        success: false,
        error: `Cannot read file: ${err instanceof Error ? err.message : 'Unknown error'}`,
        requestId,
      });
    }
  }

  private async handleOpenInEditor(
    client: AuthenticatedClient,
    payload: { path: string } | undefined,
    requestId?: string
  ): Promise<void> {
    const filePath = payload?.path;

    if (!filePath) {
      this.send(client.ws, {
        type: 'open_in_editor',
        success: false,
        error: 'No file path provided',
        requestId,
      });
      return;
    }

    try {
      const homeDir = this.tmux.getHomeDir();
      let resolvedPath: string;

      if (filePath.startsWith('~/')) {
        resolvedPath = path.join(homeDir, filePath.slice(2));
      } else if (filePath.startsWith('/')) {
        resolvedPath = filePath;
      } else {
        resolvedPath = path.resolve(homeDir, filePath);
      }

      resolvedPath = path.normalize(resolvedPath);

      // Security: only allow opening files in home directory or /tmp
      const allowedPaths = [homeDir, '/tmp', '/var/tmp'];
      const isAllowed = allowedPaths.some((allowed) => resolvedPath.startsWith(allowed));

      if (!isAllowed) {
        this.send(client.ws, {
          type: 'open_in_editor',
          success: false,
          error: `Access denied: file outside allowed directories`,
          requestId,
        });
        return;
      }

      // Check file exists
      if (!fs.existsSync(resolvedPath)) {
        this.send(client.ws, {
          type: 'open_in_editor',
          success: false,
          error: 'File not found',
          requestId,
        });
        return;
      }

      // Determine the editor command
      // Priority: $VISUAL > $EDITOR > platform default (open/xdg-open)
      const editor = process.env.VISUAL || process.env.EDITOR;
      let cmd: string;
      let args: string[];

      if (editor) {
        // Split editor string in case it has flags (e.g. "code --wait")
        const parts = editor.split(/\s+/);
        cmd = parts[0];
        args = [...parts.slice(1), resolvedPath];
      } else if (process.platform === 'darwin') {
        cmd = 'open';
        args = [resolvedPath];
      } else {
        cmd = 'xdg-open';
        args = [resolvedPath];
      }

      // Spawn detached so it doesn't block the daemon
      const child = spawn(cmd, args, {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      console.log(`Open in editor: ${cmd} ${args.join(' ')}`);

      this.send(client.ws, {
        type: 'open_in_editor',
        success: true,
        payload: { path: resolvedPath, editor: cmd },
        requestId,
      });
    } catch (err) {
      this.send(client.ws, {
        type: 'open_in_editor',
        success: false,
        error: `Failed to open file: ${err instanceof Error ? err.message : 'Unknown error'}`,
        requestId,
      });
    }
  }

  private async handleDownloadFile(
    client: AuthenticatedClient,
    payload: { path: string } | undefined,
    requestId?: string
  ): Promise<void> {
    const filePath = payload?.path;

    if (!filePath) {
      this.send(client.ws, {
        type: 'file_download',
        success: false,
        error: 'No file path provided',
        requestId,
      });
      return;
    }

    try {
      const homeDir = this.tmux.getHomeDir();
      let resolvedPath: string;

      // Handle different path formats
      if (filePath.startsWith('~/')) {
        resolvedPath = path.join(homeDir, filePath.slice(2));
      } else if (filePath.startsWith('/')) {
        resolvedPath = filePath;
      } else {
        // Relative path - resolve against home
        resolvedPath = path.resolve(homeDir, filePath);
      }

      resolvedPath = path.normalize(resolvedPath);

      // Security: only allow downloading files in certain directories
      const allowedPaths = [homeDir, '/tmp', '/var/tmp'];
      const isAllowed = allowedPaths.some((allowed) => resolvedPath.startsWith(allowed));

      if (!isAllowed) {
        this.send(client.ws, {
          type: 'file_download',
          success: false,
          error: `Access denied: file outside allowed directories`,
          requestId,
        });
        return;
      }

      // Only allow specific file types for download
      const allowedExtensions = ['.apk', '.ipa', '.zip', '.tar.gz', '.tgz'];
      const ext = path.extname(resolvedPath).toLowerCase();
      const isApkOrZip = allowedExtensions.some((e) => resolvedPath.toLowerCase().endsWith(e));

      if (!isApkOrZip) {
        this.send(client.ws, {
          type: 'file_download',
          success: false,
          error: `File type not allowed for download. Allowed: ${allowedExtensions.join(', ')}`,
          requestId,
        });
        return;
      }

      const stats = fs.statSync(resolvedPath);

      if (stats.isDirectory()) {
        this.send(client.ws, {
          type: 'file_download',
          success: false,
          error: 'Path is a directory, not a file',
          requestId,
        });
        return;
      }

      // Limit to 150MB for APKs
      const maxSize = 150 * 1024 * 1024;
      if (stats.size > maxSize) {
        this.send(client.ws, {
          type: 'file_download',
          success: false,
          error: `File too large (max 150MB, file is ${Math.round(stats.size / 1024 / 1024)}MB)`,
          requestId,
        });
        return;
      }

      // Read file as binary and encode as base64
      const content = fs.readFileSync(resolvedPath);
      const base64 = content.toString('base64');
      const fileName = path.basename(resolvedPath);

      console.log(
        `WebSocket: Sending file download: ${fileName} (${Math.round(stats.size / 1024)}KB)`
      );

      this.send(client.ws, {
        type: 'file_download',
        success: true,
        payload: {
          fileName,
          size: stats.size,
          mimeType:
            ext === '.apk' ? 'application/vnd.android.package-archive' : 'application/octet-stream',
          data: base64,
        },
        requestId,
      });
    } catch (err) {
      this.send(client.ws, {
        type: 'file_download',
        success: false,
        error: `Cannot download file: ${err instanceof Error ? err.message : 'Unknown error'}`,
        requestId,
      });
    }
  }

  private async handleGetApiUsage(
    client: AuthenticatedClient,
    payload:
      | { period?: 'today' | 'month' | 'custom'; startDate?: string; endDate?: string }
      | undefined,
    requestId?: string
  ): Promise<void> {
    const adminApiKey = this.config.anthropicAdminApiKey;

    if (!adminApiKey) {
      this.send(client.ws, {
        type: 'api_usage',
        success: false,
        error:
          'No Anthropic Admin API key configured. Add "anthropicAdminApiKey" to your config.json (key starts with sk-ant-admin-...)',
        requestId,
      });
      return;
    }

    try {
      const period = payload?.period || 'today';
      let stats;

      if (period === 'today') {
        stats = await fetchTodayUsage(adminApiKey);
      } else if (period === 'month') {
        stats = await fetchMonthUsage(adminApiKey);
      } else if (period === 'custom' && payload?.startDate && payload?.endDate) {
        stats = await fetchAnthropicUsage(
          adminApiKey,
          new Date(payload.startDate),
          new Date(payload.endDate)
        );
      } else {
        stats = await fetchTodayUsage(adminApiKey);
      }

      this.send(client.ws, {
        type: 'api_usage',
        success: true,
        payload: stats,
        requestId,
      });
    } catch (err) {
      console.error('Failed to get API usage:', err);
      this.send(client.ws, {
        type: 'api_usage',
        success: false,
        error: `Failed to fetch API usage: ${err instanceof Error ? err.message : 'Unknown error'}`,
        requestId,
      });
    }
  }

  private async handleGetCostDashboard(
    client: AuthenticatedClient,
    payload: { period?: '7d' | '30d' } | undefined,
    requestId?: string
  ): Promise<void> {
    try {
      const period = payload?.period || '7d';
      const data = await this.usageTracker.getCostDashboard(period);
      this.send(client.ws, {
        type: 'cost_dashboard',
        success: true,
        payload: data,
        requestId,
      });
    } catch (err) {
      console.error('Failed to get cost dashboard:', err);
      this.send(client.ws, {
        type: 'cost_dashboard',
        success: false,
        error: `Failed to fetch cost dashboard: ${err instanceof Error ? err.message : 'Unknown error'}`,
        requestId,
      });
    }
  }

  private async handleGetOAuthUsage(
    client: AuthenticatedClient,
    requestId?: string
  ): Promise<void> {
    try {
      const data = await this.oauthUsageFetcher.getUsage();
      this.send(client.ws, {
        type: 'oauth_usage',
        success: true,
        payload: data,
        requestId,
      });
    } catch (err) {
      console.error('Failed to get OAuth usage:', err);
      this.send(client.ws, {
        type: 'oauth_usage',
        success: false,
        error: `Failed to fetch OAuth usage: ${err instanceof Error ? err.message : 'Unknown error'}`,
        requestId,
      });
    }
  }

  private handleGetAgentTree(
    client: AuthenticatedClient,
    payload: { sessionId?: string } | undefined,
    requestId?: string
  ): void {
    if (!this.subAgentWatcher) {
      this.send(client.ws, {
        type: 'agent_tree',
        success: false,
        error: 'Sub-agent watcher not initialized',
        requestId,
      });
      return;
    }

    try {
      const tree = this.subAgentWatcher.getAgentTree(payload?.sessionId);
      this.send(client.ws, {
        type: 'agent_tree',
        success: true,
        payload: tree,
        requestId,
      });
    } catch (err) {
      console.error('Failed to get agent tree:', err);
      this.send(client.ws, {
        type: 'agent_tree',
        success: false,
        error: 'Failed to get agent tree',
        requestId,
      });
    }
  }

  private handleGetAgentDetail(
    client: AuthenticatedClient,
    payload: { agentId: string } | undefined,
    requestId?: string
  ): void {
    if (!this.subAgentWatcher) {
      this.send(client.ws, {
        type: 'agent_detail',
        success: false,
        error: 'Sub-agent watcher not initialized',
        requestId,
      });
      return;
    }

    if (!payload?.agentId) {
      this.send(client.ws, {
        type: 'agent_detail',
        success: false,
        error: 'Missing agentId',
        requestId,
      });
      return;
    }

    try {
      const detail = this.subAgentWatcher.getAgentDetail(payload.agentId);
      if (!detail) {
        this.send(client.ws, {
          type: 'agent_detail',
          success: false,
          error: 'Agent not found',
          requestId,
        });
        return;
      }

      this.send(client.ws, {
        type: 'agent_detail',
        success: true,
        payload: detail,
        requestId,
      });
    } catch (err) {
      console.error('Failed to get agent detail:', err);
      this.send(client.ws, {
        type: 'agent_detail',
        success: false,
        error: 'Failed to get agent detail',
        requestId,
      });
    }
  }

  private handleClientError(
    client: AuthenticatedClient,
    payload: ClientError,
    requestId?: string
  ): void {
    // Log to console (goes to journalctl)
    console.error('Client error:', payload.message);
    if (payload.stack) {
      console.error('Stack:', payload.stack);
    }

    // Store in memory for later retrieval
    const error: ClientError = {
      message: payload.message,
      stack: payload.stack,
      componentStack: payload.componentStack,
      timestamp: payload.timestamp || Date.now(),
      deviceId: client.deviceId,
    };

    this.clientErrors.unshift(error);
    if (this.clientErrors.length > this.MAX_CLIENT_ERRORS) {
      this.clientErrors = this.clientErrors.slice(0, this.MAX_CLIENT_ERRORS);
    }

    this.send(client.ws, {
      type: 'client_error',
      success: true,
      requestId,
    });
  }

  private handleGetClientErrors(client: AuthenticatedClient, requestId?: string): void {
    this.send(client.ws, {
      type: 'client_errors',
      success: true,
      payload: {
        errors: this.clientErrors,
        count: this.clientErrors.length,
      },
      requestId,
    });
  }

  private handleScrollLog(payload: { event: string; ts: number; [key: string]: unknown }): void {
    this.scrollLogs.push(payload);
    if (this.scrollLogs.length > this.MAX_SCROLL_LOGS) {
      this.scrollLogs = this.scrollLogs.slice(-this.MAX_SCROLL_LOGS);
    }
    // Also log to console for real-time viewing via journalctl
    console.log(`[SCROLL] ${payload.event}:`, JSON.stringify(payload));
  }

  private handleGetScrollLogs(client: AuthenticatedClient, requestId?: string): void {
    this.send(client.ws, {
      type: 'scroll_logs',
      success: true,
      payload: {
        logs: this.scrollLogs,
        count: this.scrollLogs.length,
      },
      requestId,
    });
  }

  private handleGetUsage(client: AuthenticatedClient, requestId?: string): void {
    try {
      const sessions = this.watcher.getSessions();
      const sessionUsages = [];

      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCacheCreationTokens = 0;
      let totalCacheReadTokens = 0;

      for (const session of sessions) {
        if (session.conversationPath) {
          const usage = extractUsageFromFile(session.conversationPath, session.name);
          sessionUsages.push(usage);

          totalInputTokens += usage.totalInputTokens;
          totalOutputTokens += usage.totalOutputTokens;
          totalCacheCreationTokens += usage.totalCacheCreationTokens;
          totalCacheReadTokens += usage.totalCacheReadTokens;
        }
      }

      this.send(client.ws, {
        type: 'usage',
        success: true,
        payload: {
          sessions: sessionUsages,
          totalInputTokens,
          totalOutputTokens,
          totalCacheCreationTokens,
          totalCacheReadTokens,
          periodStart: Date.now() - 24 * 60 * 60 * 1000, // Last 24h
          periodEnd: Date.now(),
        },
        requestId,
      });
    } catch (err) {
      console.error('Failed to get usage:', err);
      this.send(client.ws, {
        type: 'usage',
        success: false,
        error: 'Failed to get usage statistics',
        requestId,
      });
    }
  }

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

  // --- Work Group handlers ---

  private async handleSpawnWorkGroup(
    client: AuthenticatedClient,
    payload:
      | {
          name: string;
          foremanSessionId: string;
          foremanTmuxSession: string;
          parentDir: string;
          planFile?: string;
          workers: {
            taskSlug: string;
            taskDescription: string;
            planSection: string;
            files: string[];
          }[];
        }
      | undefined,
    requestId?: string
  ): Promise<void> {
    if (!this.workGroupManager) {
      this.send(client.ws, {
        type: 'work_group_spawned',
        success: false,
        error: 'Work groups not enabled',
        requestId,
      });
      return;
    }
    if (!payload?.name || !payload.workers?.length) {
      this.send(client.ws, {
        type: 'work_group_spawned',
        success: false,
        error: 'Missing name or workers',
        requestId,
      });
      return;
    }

    try {
      const group = await this.workGroupManager.createWorkGroup({
        name: payload.name,
        foremanSessionId: payload.foremanSessionId,
        foremanTmuxSession: payload.foremanTmuxSession,
        parentDir: payload.parentDir,
        planFile: payload.planFile,
        workers: payload.workers,
      });

      this.send(client.ws, {
        type: 'work_group_spawned',
        success: true,
        payload: group,
        requestId,
      });
    } catch (err) {
      this.send(client.ws, {
        type: 'work_group_spawned',
        success: false,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
    }
  }

  private handleGetWorkGroups(client: AuthenticatedClient, requestId?: string): void {
    if (!this.workGroupManager) {
      this.send(client.ws, {
        type: 'work_groups',
        success: true,
        payload: { groups: [] },
        requestId,
      });
      return;
    }
    const groups = this.workGroupManager.getWorkGroups();
    this.send(client.ws, { type: 'work_groups', success: true, payload: { groups }, requestId });
  }

  private handleGetWorkGroup(
    client: AuthenticatedClient,
    payload: { groupId: string } | undefined,
    requestId?: string
  ): void {
    if (!this.workGroupManager || !payload?.groupId) {
      this.send(client.ws, {
        type: 'work_group',
        success: false,
        error: 'Missing groupId',
        requestId,
      });
      return;
    }
    const group = this.workGroupManager.getWorkGroup(payload.groupId);
    if (!group) {
      this.send(client.ws, { type: 'work_group', success: false, error: 'Not found', requestId });
      return;
    }
    this.send(client.ws, { type: 'work_group', success: true, payload: group, requestId });
  }

  private async handleMergeWorkGroup(
    client: AuthenticatedClient,
    payload: { groupId: string } | undefined,
    requestId?: string
  ): Promise<void> {
    if (!this.workGroupManager || !payload?.groupId) {
      this.send(client.ws, {
        type: 'work_group_merged',
        success: false,
        error: 'Missing groupId',
        requestId,
      });
      return;
    }
    const result = await this.workGroupManager.mergeWorkGroup(payload.groupId);
    this.send(client.ws, {
      type: 'work_group_merged',
      success: result.success,
      payload: result,
      requestId,
    });
  }

  private async handleCancelWorkGroup(
    client: AuthenticatedClient,
    payload: { groupId: string } | undefined,
    requestId?: string
  ): Promise<void> {
    if (!this.workGroupManager || !payload?.groupId) {
      this.send(client.ws, {
        type: 'work_group_cancelled',
        success: false,
        error: 'Missing groupId',
        requestId,
      });
      return;
    }
    const result = await this.workGroupManager.cancelWorkGroup(payload.groupId);
    this.send(client.ws, {
      type: 'work_group_cancelled',
      success: result.success,
      error: result.error,
      requestId,
    });
  }

  private async handleRetryWorker(
    client: AuthenticatedClient,
    payload: { groupId: string; workerId: string } | undefined,
    requestId?: string
  ): Promise<void> {
    if (!this.workGroupManager || !payload?.groupId || !payload?.workerId) {
      this.send(client.ws, {
        type: 'worker_retried',
        success: false,
        error: 'Missing groupId or workerId',
        requestId,
      });
      return;
    }
    const result = await this.workGroupManager.retryWorker(payload.groupId, payload.workerId);
    this.send(client.ws, {
      type: 'worker_retried',
      success: result.success,
      error: result.error,
      requestId,
    });
  }

  private async handleSendWorkerInput(
    client: AuthenticatedClient,
    payload: { groupId: string; workerId: string; text: string } | undefined,
    requestId?: string
  ): Promise<void> {
    if (!this.workGroupManager || !payload?.groupId || !payload?.workerId || !payload?.text) {
      this.send(client.ws, {
        type: 'worker_input_sent',
        success: false,
        error: 'Missing groupId, workerId, or text',
        requestId,
      });
      return;
    }
    const result = await this.workGroupManager.sendWorkerInput(
      payload.groupId,
      payload.workerId,
      payload.text
    );
    this.send(client.ws, {
      type: 'worker_input_sent',
      success: result.success,
      error: result.error,
      requestId,
    });
  }

  private async handleDismissWorkGroup(
    client: AuthenticatedClient,
    payload: { groupId: string } | undefined,
    requestId?: string
  ): Promise<void> {
    if (!this.workGroupManager || !payload?.groupId) {
      this.send(client.ws, {
        type: 'work_group_dismissed',
        success: false,
        error: 'Missing groupId',
        requestId,
      });
      return;
    }
    const result = await this.workGroupManager.dismissWorkGroup(payload.groupId);
    this.send(client.ws, {
      type: 'work_group_dismissed',
      success: result.success,
      error: result.success ? undefined : 'Group is not in completed or cancelled state',
      requestId,
    });
  }

  private broadcast(type: string, payload: unknown, sessionId?: string): void {
    // Get the session ID to include in the message
    const activeSessionId = sessionId || this.watcher.getActiveSessionId();

    const message = JSON.stringify({
      type,
      success: true,
      payload,
      sessionId: activeSessionId, // Always include session context
    });

    for (const client of this.clients.values()) {
      if (client.authenticated && client.subscribed && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    }
  }

  getConnectedClientCount(): number {
    return this.clients.size;
  }

  getAuthenticatedClientCount(): number {
    return Array.from(this.clients.values()).filter((c) => c.authenticated).length;
  }

  // --- Skill management endpoints ---

  private handleListSkills(client: AuthenticatedClient, requestId?: string): void {
    try {
      // Scan installed skills from project and global
      const projectRoot = this.getProjectRoot();
      const projectSkills = projectRoot ? scanProjectSkills(projectRoot) : [];
      const globalSkills = scanGlobalSkills();

      // Get catalog skills
      const catalogSkills = this.skillCatalog.getAvailableSkills();

      // Build installed set for lookup
      const installedIds = new Set([
        ...projectSkills.map((s) => s.id),
        ...globalSkills.map((s) => s.id),
      ]);

      // Merge: installed skills + catalog skills not yet installed
      const skills = [
        ...projectSkills.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          category: 'installed',
          scope: 'universal' as const,
          installed: true,
          source: s.source,
        })),
        ...globalSkills
          .filter((s) => !projectSkills.some((p) => p.id === s.id))
          .map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            category: 'installed',
            scope: 'universal' as const,
            installed: true,
            source: s.source,
          })),
        ...catalogSkills
          .filter((s) => !installedIds.has(s.id))
          .map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            category: s.category,
            scope: s.scope,
            installed: false,
            source: 'catalog' as const,
          })),
      ];

      this.send(client.ws, {
        type: 'skills_list',
        success: true,
        payload: { skills },
        requestId,
      });
    } catch (err) {
      this.send(client.ws, {
        type: 'skills_list',
        success: false,
        error: String(err),
        requestId,
      });
    }
  }

  private handleInstallSkill(
    client: AuthenticatedClient,
    payload: { skillId: string; target: 'project' | 'global' } | undefined,
    requestId?: string
  ): void {
    try {
      if (!payload?.skillId) {
        this.send(client.ws, {
          type: 'skill_installed',
          success: false,
          error: 'Missing skillId',
          requestId,
        });
        return;
      }

      const projectRoot = this.getProjectRoot() || os.homedir();
      this.skillCatalog.installSkill(payload.skillId, payload.target, projectRoot);

      this.send(client.ws, {
        type: 'skill_installed',
        success: true,
        payload: { skillId: payload.skillId, target: payload.target },
        requestId,
      });
    } catch (err) {
      this.send(client.ws, {
        type: 'skill_installed',
        success: false,
        error: String(err),
        requestId,
      });
    }
  }

  private handleUninstallSkill(
    client: AuthenticatedClient,
    payload: { skillId: string; source: 'project' | 'global' } | undefined,
    requestId?: string
  ): void {
    try {
      if (!payload?.skillId) {
        this.send(client.ws, {
          type: 'skill_uninstalled',
          success: false,
          error: 'Missing skillId',
          requestId,
        });
        return;
      }

      const projectRoot = this.getProjectRoot() || os.homedir();
      this.skillCatalog.uninstallSkill(payload.skillId, payload.source, projectRoot);

      this.send(client.ws, {
        type: 'skill_uninstalled',
        success: true,
        payload: { skillId: payload.skillId },
        requestId,
      });
    } catch (err) {
      this.send(client.ws, {
        type: 'skill_uninstalled',
        success: false,
        error: String(err),
        requestId,
      });
    }
  }

  private handleGetSkillContent(
    client: AuthenticatedClient,
    payload: { skillId: string } | undefined,
    requestId?: string
  ): void {
    if (!payload?.skillId) {
      this.send(client.ws, {
        type: 'skill_content',
        success: false,
        error: 'Missing skillId',
        requestId,
      });
      return;
    }

    const content = this.skillCatalog.getSkillContent(payload.skillId);
    if (content) {
      this.send(client.ws, {
        type: 'skill_content',
        success: true,
        payload: { skillId: payload.skillId, content },
        requestId,
      });
    } else {
      this.send(client.ws, {
        type: 'skill_content',
        success: false,
        error: `Skill not found: ${payload.skillId}`,
        requestId,
      });
    }
  }

  // --- Conversation search ---

  /**
   * Escape a string for safe use as a shell argument (single-quote wrapping).
   */
  private shellEscape(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }

  private async handleSearchConversations(
    client: AuthenticatedClient,
    payload: { query: string; limit?: number } | undefined,
    requestId?: string
  ): Promise<void> {
    if (!payload?.query || !payload.query.trim()) {
      this.send(client.ws, {
        type: 'search_conversations',
        success: false,
        error: 'Missing query',
        requestId,
      });
      return;
    }

    const query = payload.query.trim();
    const resultLimit = Math.min(payload.limit || 20, 50);

    try {
      // Get the project directory from the active session
      const activeSessionId = this.watcher.getActiveSessionId();
      if (!activeSessionId) {
        this.send(client.ws, {
          type: 'search_conversations',
          success: true,
          payload: { results: [] },
          requestId,
        });
        return;
      }

      const sessions = this.watcher.getSessions();
      const activeSession = sessions.find(s => s.id === activeSessionId);
      if (!activeSession?.conversationPath) {
        this.send(client.ws, {
          type: 'search_conversations',
          success: true,
          payload: { results: [] },
          requestId,
        });
        return;
      }

      const projectDir = path.dirname(activeSession.conversationPath);

      // List all .jsonl files in the project directory (exclude subagents/)
      let files: { path: string; name: string; mtime: number }[];
      try {
        const entries = fs.readdirSync(projectDir);
        files = entries
          .filter(f => f.endsWith('.jsonl'))
          .map(f => {
            const fullPath = path.join(projectDir, f);
            try {
              const stats = fs.statSync(fullPath);
              return { path: fullPath, name: f, mtime: stats.mtimeMs };
            } catch {
              return null;
            }
          })
          .filter((f): f is { path: string; name: string; mtime: number } => f !== null)
          .sort((a, b) => b.mtime - a.mtime); // Most recent first
      } catch {
        files = [];
      }

      // Search each file with grep (fast, doesn't load into memory)
      const escaped = this.shellEscape(query);
      const results: Array<{
        filePath: string;
        fileName: string;
        lastModified: number;
        snippet: string;
        matchCount: number;
      }> = [];

      for (const file of files) {
        if (results.length >= resultLimit) break;

        try {
          // Get match count
          const { stdout: countOut } = await execAsync(
            `grep -i -c ${escaped} ${this.shellEscape(file.path)}`,
            { timeout: 3000 }
          ).catch(err => {
            // grep returns exit code 1 for no matches
            if (err.code === 1) return { stdout: '0' };
            throw err;
          });
          const matchCount = parseInt(countOut.trim(), 10);
          if (!matchCount || matchCount === 0) continue;

          // Get up to 5 matching lines and pick the first with readable text
          const { stdout: matchOut } = await execAsync(
            `grep -i -m 5 ${escaped} ${this.shellEscape(file.path)}`,
            { timeout: 3000 }
          ).catch(() => ({ stdout: '' }));

          let snippet = '';
          const matchLines = matchOut.trim().split('\n').filter(Boolean);
          const lowerQuery = query.toLowerCase();
          for (const matchLine of matchLines) {
            try {
              const entry = JSON.parse(matchLine);
              const msg = entry.message;
              if (!msg?.content) continue;
              let text = '';
              if (typeof msg.content === 'string') {
                text = msg.content;
              } else if (Array.isArray(msg.content)) {
                text = msg.content
                  .filter((b: { type: string; text?: string }) => b.type === 'text' && b.text)
                  .map((b: { text: string }) => b.text)
                  .join(' ');
              }
              if (!text.trim()) continue;
              // Find match position and extract surrounding context
              const lowerText = text.toLowerCase();
              const idx = lowerText.indexOf(lowerQuery);
              if (idx >= 0) {
                const start = Math.max(0, idx - 60);
                const end = Math.min(text.length, idx + query.length + 60);
                snippet = (start > 0 ? '...' : '') +
                  text.slice(start, end).replace(/\n/g, ' ') +
                  (end < text.length ? '...' : '');
              } else {
                snippet = text.slice(0, 120).replace(/\n/g, ' ');
              }
              break; // Found a good snippet
            } catch {
              continue;
            }
          }

          results.push({
            filePath: file.path,
            fileName: file.name,
            lastModified: file.mtime,
            snippet,
            matchCount,
          });
        } catch {
          // Skip files that fail
          continue;
        }
      }

      this.send(client.ws, {
        type: 'search_conversations',
        success: true,
        payload: { results },
        requestId,
      });
    } catch (err) {
      this.send(client.ws, {
        type: 'search_conversations',
        success: false,
        error: String(err),
        requestId,
      });
    }
  }

  private handleGetConversationFile(
    client: AuthenticatedClient,
    payload: { filePath: string; limit?: number; offset?: number } | undefined,
    requestId?: string
  ): void {
    if (!payload?.filePath) {
      this.send(client.ws, {
        type: 'conversation_file',
        success: false,
        error: 'Missing filePath',
        requestId,
      });
      return;
    }

    // Security: validate filePath is within ~/.claude/projects/
    const projectsDir = path.join(this.config.codeHome, 'projects');
    const resolved = path.resolve(payload.filePath);
    if (!resolved.startsWith(projectsDir)) {
      this.send(client.ws, {
        type: 'conversation_file',
        success: false,
        error: 'Invalid file path',
        requestId,
      });
      return;
    }

    if (!fs.existsSync(resolved)) {
      this.send(client.ws, {
        type: 'conversation_file',
        success: false,
        error: 'File not found',
        requestId,
      });
      return;
    }

    try {
      const messages = parseConversationFile(resolved);
      const allHighlights = extractHighlights(messages);
      const total = allHighlights.length;
      const limit = payload.limit || 50;
      const offset = payload.offset || 0;
      const startIdx = Math.max(0, total - offset - limit);
      const endIdx = Math.max(total - offset, 0);
      const highlights = allHighlights.slice(startIdx, endIdx);
      const hasMore = startIdx > 0;

      this.send(client.ws, {
        type: 'conversation_file',
        success: true,
        payload: { highlights, total, hasMore, filePath: resolved },
        requestId,
      });
    } catch (err) {
      this.send(client.ws, {
        type: 'conversation_file',
        success: false,
        error: String(err),
        requestId,
      });
    }
  }

  // --- File search ---

  private fileTreeCache: { files: string[]; projectRoot: string; timestamp: number } | null = null;
  private static FILE_TREE_TTL = 30_000; // 30s cache

  private static IGNORE_DIRS = new Set([
    '.git', 'node_modules', 'dist', '__pycache__', 'target', '.next',
    '.turbo', '.nuxt', 'build', 'coverage', '.cache', '.expo', 'venv',
    '.venv', 'env', '.tox', '.mypy_cache', '.pytest_cache',
  ]);

  private walkDirectory(dir: string, root: string, files: string[], depth: number = 0): void {
    if (depth > 10) return; // Max depth
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.isDirectory()) continue;
        if (WebSocketHandler.IGNORE_DIRS.has(entry.name) && entry.isDirectory()) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          this.walkDirectory(fullPath, root, files, depth + 1);
        } else {
          files.push(fullPath);
        }
      }
    } catch {
      // Permission errors, etc.
    }
  }

  private getFileTree(projectRoot: string): string[] {
    const now = Date.now();
    if (
      this.fileTreeCache &&
      this.fileTreeCache.projectRoot === projectRoot &&
      now - this.fileTreeCache.timestamp < WebSocketHandler.FILE_TREE_TTL
    ) {
      return this.fileTreeCache.files;
    }

    const files: string[] = [];
    this.walkDirectory(projectRoot, projectRoot, files);
    this.fileTreeCache = { files, projectRoot, timestamp: now };
    return files;
  }

  private fuzzyScore(query: string, filePath: string, projectRoot: string): number {
    const relativePath = path.relative(projectRoot, filePath).toLowerCase();
    const basename = path.basename(filePath).toLowerCase();
    const q = query.toLowerCase();

    // Exact basename match scores highest
    if (basename === q) return 1000;
    // Basename starts with query
    if (basename.startsWith(q)) return 500 + (q.length / basename.length) * 100;
    // Basename contains query
    const basenameIdx = basename.indexOf(q);
    if (basenameIdx >= 0) return 300 + (q.length / basename.length) * 100 - basenameIdx;
    // Path contains query
    const pathIdx = relativePath.indexOf(q);
    if (pathIdx >= 0) return 100 - pathIdx * 0.1;

    // Subsequence match on basename
    let qi = 0;
    let consecutive = 0;
    let maxConsecutive = 0;
    for (let i = 0; i < basename.length && qi < q.length; i++) {
      if (basename[i] === q[qi]) {
        qi++;
        consecutive++;
        maxConsecutive = Math.max(maxConsecutive, consecutive);
      } else {
        consecutive = 0;
      }
    }
    if (qi === q.length) return 50 + maxConsecutive * 10;

    return -1; // No match
  }

  private handleSearchFiles(
    client: AuthenticatedClient,
    payload: { query: string; limit?: number } | undefined,
    requestId?: string
  ): void {
    const query = payload?.query?.trim();
    if (!query) {
      this.send(client.ws, {
        type: 'search_files_result',
        success: true,
        payload: { files: [] },
        requestId,
      });
      return;
    }

    const projectRoot = this.getProjectRoot();
    if (!projectRoot) {
      this.send(client.ws, {
        type: 'search_files_result',
        success: false,
        error: 'No active project',
        requestId,
      });
      return;
    }

    try {
      const allFiles = this.getFileTree(projectRoot);
      const limit = payload?.limit || 20;

      const scored = allFiles
        .map((f) => ({ path: f, relativePath: path.relative(projectRoot, f), score: this.fuzzyScore(query, f, projectRoot) }))
        .filter((f) => f.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      this.send(client.ws, {
        type: 'search_files_result',
        success: true,
        payload: { files: scored.map((f) => ({ path: f.path, relativePath: f.relativePath })) },
        requestId,
      });
    } catch (err) {
      this.send(client.ws, {
        type: 'search_files_result',
        success: false,
        error: `Search failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        requestId,
      });
    }
  }

  private handleCheckFilesExist(
    client: AuthenticatedClient,
    payload: { paths: string[] } | undefined,
    requestId?: string
  ): void {
    const paths = payload?.paths;
    if (!paths || !Array.isArray(paths)) {
      this.send(client.ws, {
        type: 'files_exist_result',
        success: true,
        payload: { results: {} },
        requestId,
      });
      return;
    }

    const projectRoot = this.getProjectRoot();
    const results: Record<string, boolean> = {};

    for (const p of paths) {
      const resolved = projectRoot ? path.resolve(projectRoot, p) : null;
      results[p] = resolved ? fs.existsSync(resolved) : false;
    }

    this.send(client.ws, {
      type: 'files_exist_result',
      success: true,
      payload: { results },
      requestId,
    });
  }

  private getProjectRoot(): string | null {
    // Get the actual project root from the active session's decoded project path
    const conv = this.watcher.getActiveConversation();
    if (conv?.projectPath) {
      return conv.projectPath;
    }
    return null;
  }
}
