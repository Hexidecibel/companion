import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage, Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { ClaudeWatcher } from './watcher';
import { InputInjector } from './input-injector';
import { PushNotificationService } from './push';
import { TmuxManager } from './tmux-manager';
import { extractHighlights, extractUsageFromFile } from './parser';
import { WebSocketMessage, WebSocketResponse, DaemonConfig, TmuxSessionConfig } from './types';
import { loadConfig, saveConfig } from './config';

// File for persisting tmux session configs
const TMUX_CONFIGS_FILE = path.join(os.homedir(), '.claude-companion', 'tmux-sessions.json');

interface AuthenticatedClient {
  id: string;
  ws: WebSocket;
  authenticated: boolean;
  deviceId?: string;
  subscribed: boolean;
}

export class WebSocketHandler {
  private wss: WebSocketServer;
  private clients: Map<string, AuthenticatedClient> = new Map();
  private token: string;
  private watcher: ClaudeWatcher;
  private injector: InputInjector;
  private push: PushNotificationService;
  private tmux: TmuxManager;
  private tmuxSessionConfigs: Map<string, TmuxSessionConfig> = new Map();
  private config: DaemonConfig;

  constructor(
    server: Server,
    config: DaemonConfig,
    watcher: ClaudeWatcher,
    injector: InputInjector,
    push: PushNotificationService,
    tmux?: TmuxManager
  ) {
    this.config = config;
    this.token = config.token;
    this.watcher = watcher;
    this.injector = injector;
    this.push = push;
    this.tmux = tmux || new TmuxManager('claude');

    this.wss = new WebSocketServer({ server });

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));

    // Forward watcher events to subscribed clients
    this.watcher.on('conversation-update', (data) => {
      this.broadcast('conversation_update', data);
    });

    this.watcher.on('status-change', (data) => {
      this.broadcast('status_change', data);

      // Schedule push notification if waiting for input
      if (data.isWaitingForInput && data.lastMessage) {
        this.push.scheduleWaitingNotification(data.lastMessage.content);
      } else {
        this.push.cancelPendingNotification();
      }
    });

    // Notify about activity in other (non-active) sessions
    this.watcher.on('other-session-activity', (data) => {
      this.broadcast('other_session_activity', data);
    });

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

  private storeTmuxSessionConfig(name: string, workingDir: string, startClaude: boolean = true): void {
    this.tmuxSessionConfigs.set(name, {
      name,
      workingDir,
      startClaude,
      lastUsed: Date.now(),
    });
    this.saveTmuxSessionConfigs();
    console.log(`WebSocket: Stored tmux session config for "${name}" (${workingDir})`);
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const clientId = uuidv4();
    const client: AuthenticatedClient = {
      id: clientId,
      ws,
      authenticated: false,
      subscribed: false,
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

    ws.on('close', () => {
      this.clients.delete(clientId);
      console.log(`WebSocket: Client disconnected (${clientId})`);
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

    // Authenticate first
    if (type === 'authenticate') {
      if (token === this.token) {
        client.authenticated = true;
        client.deviceId = (payload as { deviceId?: string })?.deviceId;

        this.send(client.ws, {
          type: 'authenticated',
          success: true,
          requestId,
        });
        console.log(`WebSocket: Client authenticated (${client.id})`);
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
        client.subscribed = true;
        console.log(`WebSocket: Client subscribed (${client.id})`);
        this.send(client.ws, {
          type: 'subscribed',
          success: true,
          requestId,
        });
        break;

      case 'unsubscribe':
        client.subscribed = false;
        this.send(client.ws, {
          type: 'unsubscribed',
          success: true,
          requestId,
        });
        break;

      case 'get_highlights':
        const messages = this.watcher.getMessages();
        const highlights = extractHighlights(messages);
        this.send(client.ws, {
          type: 'highlights',
          success: true,
          payload: { highlights },
          requestId,
        });
        break;

      case 'get_full':
        const fullMessages = this.watcher.getMessages();
        this.send(client.ws, {
          type: 'full',
          success: true,
          payload: { messages: fullMessages },
          requestId,
        });
        break;

      case 'get_status':
        const status = this.watcher.getStatus();
        this.send(client.ws, {
          type: 'status',
          success: true,
          payload: status,
          requestId,
        });
        break;

      case 'get_server_summary':
        // Get tmux sessions to filter - only show conversations with active tmux sessions
        this.tmux.listSessions().then(async (tmuxSessions) => {
          const summary = await this.watcher.getServerSummary(tmuxSessions);
          this.send(client.ws, {
            type: 'server_summary',
            success: true,
            payload: summary,
            requestId,
          });
        }).catch((err) => {
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

      case 'switch_session':
        const switchPayload = payload as { sessionId: string };
        if (switchPayload?.sessionId) {
          const switched = this.watcher.setActiveSession(switchPayload.sessionId);

          // Also switch the input target to the corresponding tmux session
          if (switched) {
            const convSession = this.watcher.getSessions().find(s => s.id === switchPayload.sessionId);
            if (convSession?.projectPath) {
              // Find tmux session with matching working directory
              this.tmux.listSessions().then(tmuxSessions => {
                const matchingTmux = tmuxSessions.find(ts => ts.workingDir === convSession.projectPath);
                if (matchingTmux) {
                  this.injector.setActiveSession(matchingTmux.name);
                  console.log(`WebSocket: Switched input target to tmux session "${matchingTmux.name}"`);
                }
              }).catch(err => {
                console.error('Failed to find matching tmux session:', err);
              });
            }
          }

          this.send(client.ws, {
            type: 'session_switched',
            success: switched,
            payload: { sessionId: switchPayload.sessionId },
            error: switched ? undefined : 'Session not found',
            requestId,
          });
        } else {
          this.send(client.ws, {
            type: 'session_switched',
            success: false,
            error: 'Missing sessionId',
            requestId,
          });
        }
        break;

      case 'send_input':
        this.handleSendInput(client, payload as { input: string }, requestId);
        break;

      case 'send_image':
        this.handleSendImage(client, payload as { base64: string; mimeType: string }, requestId);
        break;

      case 'upload_image':
        // Just upload and save, don't send to Claude yet
        this.handleUploadImage(client, payload as { base64: string; mimeType: string }, requestId);
        break;

      case 'send_with_images':
        // Send message with image paths combined
        this.handleSendWithImages(client, payload as { imagePaths: string[]; message: string }, requestId);
        break;

      case 'register_push':
        const pushPayload = payload as { fcmToken: string; deviceId: string; tokenType?: string };
        if (pushPayload?.fcmToken && pushPayload?.deviceId) {
          const isExpoToken = pushPayload.fcmToken.startsWith('ExponentPushToken');
          console.log(`Push registration: device=${pushPayload.deviceId}, type=${isExpoToken ? 'expo' : 'fcm'}, token=${pushPayload.fcmToken.substring(0, 30)}...`);
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

      case 'set_instant_notify':
        const instantPayload = payload as { enabled: boolean };
        if (client.deviceId) {
          this.push.setInstantNotify(client.deviceId, instantPayload?.enabled ?? false);
          this.send(client.ws, {
            type: 'instant_notify_set',
            success: true,
            payload: { enabled: instantPayload?.enabled ?? false },
            requestId,
          });
        } else {
          this.send(client.ws, {
            type: 'instant_notify_set',
            success: false,
            error: 'Device not registered for push',
            requestId,
          });
        }
        break;

      case 'set_notification_prefs':
        const notifPrefs = payload as {
          quietHoursEnabled?: boolean;
          quietHoursStart?: string;
          quietHoursEnd?: string;
          throttleMinutes?: number;
        };
        if (client.deviceId) {
          this.push.setNotificationPrefs(client.deviceId, {
            quietHoursEnabled: notifPrefs?.quietHoursEnabled ?? false,
            quietHoursStart: notifPrefs?.quietHoursStart ?? '22:00',
            quietHoursEnd: notifPrefs?.quietHoursEnd ?? '08:00',
            throttleMinutes: notifPrefs?.throttleMinutes ?? 0,
          });
          this.send(client.ws, {
            type: 'notification_prefs_set',
            success: true,
            requestId,
          });
        } else {
          this.send(client.ws, {
            type: 'notification_prefs_set',
            success: false,
            error: 'Device not registered for push',
            requestId,
          });
        }
        break;

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
        this.handleListTmuxSessions(client, requestId);
        break;

      case 'create_tmux_session':
        this.handleCreateTmuxSession(
          client,
          payload as { name?: string; workingDir: string; startClaude?: boolean },
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

      case 'browse_directories':
        this.handleBrowseDirectories(client, payload as { path?: string }, requestId);
        break;

      case 'read_file':
        this.handleReadFile(client, payload as { path: string }, requestId);
        break;

      case 'get_usage':
        this.handleGetUsage(client, requestId);
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
    payload: { input: string } | undefined,
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

    // Cancel any pending push notification since user is responding
    this.push.cancelPendingNotification();

    // Check if the target session exists before trying to send
    const activeSession = this.injector.getActiveSession();
    const sessionExists = await this.injector.checkSessionExists(activeSession);

    if (!sessionExists) {
      // Check if we have a stored config for this session
      const savedConfig = this.tmuxSessionConfigs.get(activeSession);

      this.send(client.ws, {
        type: 'input_sent',
        success: false,
        error: 'tmux_session_not_found',
        payload: {
          sessionName: activeSession,
          canRecreate: !!savedConfig,
          savedConfig: savedConfig ? {
            name: savedConfig.name,
            workingDir: savedConfig.workingDir,
          } : undefined,
        },
        requestId,
      });
      return;
    }

    const success = await this.injector.sendInput(payload.input);
    this.send(client.ws, {
      type: 'input_sent',
      success,
      error: success ? undefined : 'Failed to send input to Claude',
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
      const filename = `claude-companion-${Date.now()}.${ext}`;
      const filepath = path.join(os.tmpdir(), filename);

      // Save image to temp file
      const buffer = Buffer.from(payload.base64, 'base64');
      fs.writeFileSync(filepath, buffer);

      console.log(`Image saved to: ${filepath}`);

      // Cancel any pending push notification
      this.push.cancelPendingNotification();

      // Send the file path to Claude Code
      const success = await this.injector.sendInput(`Please look at this image: ${filepath}`);

      this.send(client.ws, {
        type: 'image_sent',
        success,
        payload: { filepath },
        error: success ? undefined : 'Failed to send image path to Claude',
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
      const filename = `claude-companion-${Date.now()}.${ext}`;
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

    // Cancel any pending push notification
    this.push.cancelPendingNotification();

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

  private handleRotateToken(client: AuthenticatedClient, requestId?: string): void {
    try {
      // Generate new token
      const newToken = crypto.randomBytes(32).toString('hex');

      // Update config file
      const config = loadConfig();
      config.token = newToken;
      saveConfig(config);

      // Update in-memory token
      this.token = newToken;

      // Notify the requesting client of the new token
      this.send(client.ws, {
        type: 'token_rotated',
        success: true,
        payload: { newToken },
        requestId,
      });

      console.log('WebSocket: Token rotated successfully');

      // Disconnect all other clients (they need to re-authenticate)
      for (const [id, c] of this.clients) {
        if (id !== client.id && c.authenticated) {
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
    payload: { name?: string; workingDir: string; startClaude?: boolean } | undefined,
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
    const startClaude = payload.startClaude !== false; // Default true

    console.log(`WebSocket: Creating tmux session "${sessionName}" in ${payload.workingDir}`);

    const result = await this.tmux.createSession(sessionName, payload.workingDir, startClaude);

    if (result.success) {
      // Store the session config for potential recreation later
      this.storeTmuxSessionConfig(sessionName, payload.workingDir, startClaude);

      // Switch to the new session
      this.injector.setActiveSession(sessionName);

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
      this.broadcast('tmux_sessions_changed', { action: 'killed', sessionName: payload.sessionName });
    } else {
      this.send(client.ws, {
        type: 'tmux_session_killed',
        success: false,
        error: result.error,
        requestId,
      });
    }
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

    // Try to find and switch to the corresponding conversation session
    // Get the tmux session's working directory
    const sessions = await this.tmux.listSessions();
    const tmuxSession = sessions.find(s => s.name === payload.sessionName);
    let conversationSessionId: string | undefined;

    if (tmuxSession?.workingDir) {
      // Store the session config for potential recreation later
      this.storeTmuxSessionConfig(payload.sessionName, tmuxSession.workingDir, true);

      // Encode the working directory the same way Claude does: /a/b/c -> -a-b-c
      const encodedPath = tmuxSession.workingDir.replace(/\//g, '-');

      // Find conversation session whose ID matches or starts with this encoded path
      const convSessions = this.watcher.getSessions();
      const matchingConv = convSessions.find(cs => cs.id === encodedPath);

      if (matchingConv) {
        this.watcher.setActiveSession(matchingConv.id);
        conversationSessionId = matchingConv.id;
        console.log(`WebSocket: Switched conversation to "${matchingConv.id}" for project ${tmuxSession.workingDir}`);
      } else {
        console.log(`WebSocket: No conversation found for ${encodedPath}, available: ${convSessions.map(c => c.id).join(', ')}`);
      }
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
      savedConfig.startClaude
    );

    if (result.success) {
      // Update the last used timestamp
      this.storeTmuxSessionConfig(savedConfig.name, savedConfig.workingDir, savedConfig.startClaude);

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
          const matchingSession = sessions.find(s => {
            if (!s.workingDir) return false;
            const encoded = s.workingDir.replace(/\//g, '-');
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
      const allowedPaths = [
        homeDir,
        '/tmp',
        '/var/tmp',
      ];

      const isAllowed = allowedPaths.some(allowed => resolvedPath.startsWith(allowed));

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
      ws.send(JSON.stringify(response));
    }
  }

  private sendError(ws: WebSocket, error: string): void {
    this.send(ws, {
      type: 'error',
      success: false,
      error,
    });
  }

  private broadcast(type: string, payload: unknown): void {
    const message = JSON.stringify({
      type,
      success: true,
      payload,
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
}
