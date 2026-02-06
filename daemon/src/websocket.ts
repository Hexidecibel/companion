import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage, Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { SessionWatcher } from './watcher';
import { InputInjector } from './input-injector';
import { PushNotificationService } from './push';
import { TmuxManager } from './tmux-manager';
import {
  extractHighlights,
  extractUsageFromFile,
  extractTasks,
  parseConversationChain,
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
import { templates as scaffoldTemplates } from './scaffold/templates';
import { scaffoldProject, previewScaffold } from './scaffold/generator';
import { ProjectConfig } from './scaffold/types';
import { scoreTemplates } from './scaffold/scorer';
import { EscalationService, EscalationEvent } from './escalation';
import { NotificationEventType, EscalationConfig } from './types';

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
  private escalation: EscalationService;
  private workGroupManager: WorkGroupManager | null;

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
      this.broadcast('conversation_update', data);
    });

    this.watcher.on('status-change', (data) => {
      this.broadcast('status_change', data);

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

  private handleConnection(ws: WebSocket, _req: IncomingMessage, listenerPort: number): void {
    const clientId = uuidv4();
    const client: AuthenticatedClient = {
      id: clientId,
      ws,
      authenticated: false,
      subscribed: false,
      listenerPort,
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
          requestId,
        });
        console.log(
          `WebSocket: Client authenticated (${client.id}) on port ${client.listenerPort}`
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
        const hlParams = payload as { limit?: number; offset?: number } | undefined;
        const t0 = Date.now();
        const hlSessionId = this.watcher.getActiveSessionId();

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
          const messages = this.watcher.getMessages();
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

        const t1 = Date.now();
        console.log(
          `WebSocket: get_highlights - ${t1 - t0}ms, chain: ${chain.length} files, returning ${resultHighlights.length}/${total}`
        );
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
        const t0 = Date.now();
        const fullMessages = this.watcher.getMessages();
        const t1 = Date.now();
        const fullSessionId = this.watcher.getActiveSessionId();
        console.log(`WebSocket: get_full - getMessages: ${t1 - t0}ms, ${fullMessages.length} msgs`);
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
        const t0 = Date.now();
        const status = this.watcher.getStatus();
        const t1 = Date.now();
        const statusSessionId = this.watcher.getActiveSessionId();
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
        // Get tmux sessions to filter - only show conversations with active tmux sessions
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
        if (enabled) {
          this.watcher.checkAndEmitPendingApproval();
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
        const termPayload = payload as { sessionName: string; lines?: number } | undefined;
        if (termPayload?.sessionName) {
          this.tmux
            .capturePane(termPayload.sessionName, termPayload.lines || 100)
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

      default:
        this.send(client.ws, {
          type: 'error',
          success: false,
          error: `Unknown message type: ${type}`,
          requestId,
        });
    }
  }

  private async handleSendInput(
    client: AuthenticatedClient,
    payload: { input: string; sessionId?: string } | undefined,
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

    // Resolve the target tmux session:
    // If a sessionId (encoded project path) is provided, find the matching tmux session
    let targetTmuxSession: string | undefined;
    if (payload.sessionId) {
      const convSession = this.watcher.getSessions().find((s) => s.id === payload.sessionId);
      if (convSession?.projectPath) {
        const tmuxSessions = await this.tmux.listSessions();
        const match = tmuxSessions.find((ts) => ts.workingDir === convSession.projectPath);
        if (match) {
          targetTmuxSession = match.name;
        }
      }
    }

    // Fall back to the global active session
    const sessionToUse = targetTmuxSession || this.injector.getActiveSession();

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
    this.send(client.ws, {
      type: 'input_sent',
      success,
      error: success ? undefined : 'Failed to send input to session',
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
    payload: { imagePaths: string[]; message: string } | undefined,
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

    const success = await this.injector.sendInput(combinedMessage);
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

    // 1. Switch the watcher's active session
    const switched = this.watcher.setActiveSession(sessionId);
    if (!switched) {
      this.send(client.ws, {
        type: 'session_switched',
        success: false,
        error: 'Session not found',
        sessionId,
        requestId,
      } as WebSocketResponse);
      return;
    }

    // 2. Update client's subscription to this session
    client.subscribedSessionId = sessionId;

    // 3. Find and switch to corresponding tmux session
    let tmuxSessionName: string | undefined;
    try {
      const convSession = this.watcher.getSessions().find((s) => s.id === sessionId);
      if (convSession?.projectPath) {
        const tmuxSessions = await this.tmux.listSessions();
        const matchingTmux = tmuxSessions.find((ts) => ts.workingDir === convSession.projectPath);
        if (matchingTmux) {
          this.injector.setActiveSession(matchingTmux.name);
          tmuxSessionName = matchingTmux.name;
        }
      }
    } catch (err) {
      console.error('Failed to switch tmux session:', err);
      // Continue anyway - watcher switch succeeded
    }

    // 4. Return success with session context
    this.send(client.ws, {
      type: 'session_switched',
      success: true,
      payload: {
        sessionId,
        tmuxSession: tmuxSessionName,
        epoch, // Echo back epoch for client validation
      },
      sessionId, // Include at top level for validation
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

      // Clear the watcher's active session - no conversation exists yet
      // This prevents returning old session data until the new conversation is created
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

      // Encode the working directory the same way the CLI does: /a/b_c -> -a-b-c
      const encodedPath = tmuxSession.workingDir.replace(/[/_]/g, '-');

      // Find conversation session whose ID matches or starts with this encoded path
      const convSessions = this.watcher.getSessions();
      const matchingConv = convSessions.find((cs) => cs.id === encodedPath);

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
          `WebSocket: No conversation found for ${encodedPath}, cleared active session. Available: ${convSessions.map((c) => c.id).join(', ')}`
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
        const sessions = await this.tmux.listSessions();
        const activeSessionId = this.watcher.getActiveSessionId();

        // Try to find matching tmux session by encoded path
        let workingDir = homeDir;
        if (activeSessionId) {
          // The session ID is the encoded path like -Users-foo-project
          // Match it against tmux session working directories
          const matchingSession = sessions.find((s) => {
            if (!s.workingDir) return false;
            const encoded = s.workingDir.replace(/[/_]/g, '-');
            return encoded === activeSessionId || s.name === activeSessionId;
          });
          if (matchingSession?.workingDir) {
            workingDir = matchingSession.workingDir;
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

      // Limit file size to 1MB
      if (stats.size > 1024 * 1024) {
        this.send(client.ws, {
          type: 'file_content',
          success: false,
          error: 'File too large (max 1MB)',
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
        // Only send to clients subscribed to this session (or all if no session filter)
        if (!client.subscribedSessionId || client.subscribedSessionId === activeSessionId) {
          client.ws.send(message);
        }
      }
    }
  }

  getConnectedClientCount(): number {
    return this.clients.size;
  }

  getAuthenticatedClientCount(): number {
    return Array.from(this.clients.values()).filter((c) => c.authenticated).length;
  }
}
