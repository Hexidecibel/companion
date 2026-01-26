import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage, Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ClaudeWatcher } from './watcher';
import { InputInjector } from './input-injector';
import { PushNotificationService } from './push';
import { extractHighlights } from './parser';
import { WebSocketMessage, WebSocketResponse } from './types';

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

  constructor(
    server: Server,
    token: string,
    watcher: ClaudeWatcher,
    injector: InputInjector,
    push: PushNotificationService
  ) {
    this.token = token;
    this.watcher = watcher;
    this.injector = injector;
    this.push = push;

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

    console.log('WebSocket: Server initialized');
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
        const pushPayload = payload as { fcmToken: string; deviceId: string };
        if (pushPayload?.fcmToken && pushPayload?.deviceId) {
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
