import { Server, ConnectionState, WebSocketMessage, WebSocketResponse } from '../types';
import { messageQueue, QueuedMessage } from './messageQueue';

type MessageHandler = (message: WebSocketResponse) => void;
type StateChangeHandler = (state: ConnectionState) => void;
type QueueFlushHandler = (message: QueuedMessage, success: boolean) => void;

const MAX_RECONNECT_ATTEMPTS = 3;
const INITIAL_RECONNECT_DELAY = 2000;
const MAX_RECONNECT_DELAY = 10000;
const PING_INTERVAL = 30000;
const CONNECTION_TIMEOUT = 10000;

export class WebSocketService {
  private ws: WebSocket | null = null;
  private server: Server | null = null;
  private connectionState: ConnectionState = {
    status: 'disconnected',
    reconnectAttempts: 0,
  };

  private messageHandlers: Set<MessageHandler> = new Set();
  private stateChangeHandlers: Set<StateChangeHandler> = new Set();
  private queueFlushHandlers: Set<QueueFlushHandler> = new Set();
  private pendingRequests: Map<
    string,
    { resolve: (r: WebSocketResponse) => void; reject: (e: Error) => void }
  > = new Map();
  private isFlushingQueue: boolean = false;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private requestCounter = 0;

  connect(server: Server): void {
    // Don't connect to disabled servers
    if (server.enabled === false) {
      console.log(`Server ${server.id} is disabled, skipping connect`);
      return;
    }

    // Guard against double-connect: if already connecting/connected to same server, skip
    // For 'connected' status, also verify the WebSocket is actually open - WiFi drops
    // can leave status as 'connected' while the socket is dead
    if (
      this.server?.id === server.id &&
      (this.connectionState.status === 'connecting' ||
        this.connectionState.status === 'reconnecting' ||
        (this.connectionState.status === 'connected' && this.ws?.readyState === WebSocket.OPEN))
    ) {
      console.log(`Already ${this.connectionState.status} to ${server.id}, skipping connect`);
      return;
    }

    // If switching servers, disconnect first
    if (this.server && this.server.id !== server.id) {
      this.disconnect();
    }

    this.server = server;
    this.doConnect();
  }

  private doConnect(): void {
    if (!this.server) return;

    // Clear any existing timers
    this.clearTimers();

    // Update state
    this.updateState({
      status: this.connectionState.reconnectAttempts > 0 ? 'reconnecting' : 'connecting',
    });

    const protocol = this.server.useTls ? 'wss' : 'ws';
    const url = `${protocol}://${this.server.host}:${this.server.port}`;

    console.log(`Connecting to ${url}...`);

    try {
      this.ws = new WebSocket(url);

      // Set connection timeout
      this.connectionTimer = setTimeout(() => {
        if (
          this.connectionState.status === 'connecting' ||
          this.connectionState.status === 'reconnecting'
        ) {
          console.log('Connection timeout');
          this.ws?.close();
          this.handleDisconnect('Connection timeout');
        }
      }, CONNECTION_TIMEOUT);

      this.ws.onopen = () => this.handleOpen();
      this.ws.onmessage = (event) => this.handleMessage(event);
      this.ws.onclose = (event) => this.handleClose(event);
      this.ws.onerror = (event) => this.handleError(event);
    } catch (error) {
      console.error('Failed to create WebSocket:', error);
      this.handleDisconnect('Failed to create connection');
    }
  }

  private handleOpen(): void {
    console.log('WebSocket connected');
    this.clearConnectionTimer();

    // Wait a tick for connection to stabilize, then authenticate
    setTimeout(() => {
      if (this.server && this.ws?.readyState === WebSocket.OPEN) {
        this.authenticate(this.server.token);
      }
    }, 50);
  }

  private async authenticate(token: string): Promise<void> {
    try {
      // Send token at top level, not in payload
      const requestId = `req_${++this.requestCounter}`;
      const response = await new Promise<WebSocketResponse>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingRequests.delete(requestId);
          reject(new Error('Auth timeout'));
        }, 10000);
        this.pendingRequests.set(requestId, {
          resolve: (r) => {
            clearTimeout(timeout);
            resolve(r);
          },
          reject: (e) => {
            clearTimeout(timeout);
            reject(e);
          },
        });
        this.send({ type: 'authenticate', token, requestId } as any).catch(reject);
      });
      if (response.success) {
        console.log('Authenticated successfully');
        this.updateState({
          status: 'connected',
          error: undefined,
          lastConnected: Date.now(),
          reconnectAttempts: 0,
        });
        this.startPingInterval();

        // Flush queued messages
        this.flushMessageQueue();
      } else {
        console.error('Authentication failed:', response.error);
        this.updateState({
          status: 'error',
          error: 'Authentication failed: ' + (response.error || 'Invalid token'),
        });
        this.ws?.close();
      }
    } catch (error) {
      console.error('Authentication error:', error);
      this.handleDisconnect('Authentication failed');
    }
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const message: WebSocketResponse = JSON.parse(event.data);

      // Handle request responses
      if (message.requestId && this.pendingRequests.has(message.requestId)) {
        const { resolve } = this.pendingRequests.get(message.requestId)!;
        this.pendingRequests.delete(message.requestId);
        resolve(message);
        return;
      }

      // Notify message handlers
      this.messageHandlers.forEach((handler) => {
        try {
          handler(message);
        } catch (error) {
          console.error('Message handler error:', error);
        }
      });
    } catch (error) {
      console.error('Failed to parse message:', error);
    }
  }

  private handleClose(event: CloseEvent): void {
    console.log(`WebSocket closed: ${event.code} ${event.reason}`);
    this.clearTimers();
    this.handleDisconnect(event.reason || 'Connection closed');
  }

  private handleError(event: Event): void {
    console.error('WebSocket error:', event);
    // The close event will follow, so we don't need to do much here
  }

  private handleDisconnect(reason: string): void {
    this.ws = null;
    this.clearTimers();

    // Reject all pending requests
    this.pendingRequests.forEach(({ reject }) => {
      reject(new Error('Connection lost'));
    });
    this.pendingRequests.clear();

    // Attempt reconnection if we have an enabled server and haven't exceeded attempts
    if (
      this.server &&
      this.server.enabled !== false &&
      this.connectionState.reconnectAttempts < MAX_RECONNECT_ATTEMPTS
    ) {
      const attempts = this.connectionState.reconnectAttempts + 1;
      const delay = Math.min(
        INITIAL_RECONNECT_DELAY * Math.pow(2, attempts - 1),
        MAX_RECONNECT_DELAY
      );

      console.log(`Reconnecting in ${delay}ms (attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS})`);

      this.updateState({
        status: 'reconnecting',
        error: reason,
        reconnectAttempts: attempts,
      });

      this.reconnectTimer = setTimeout(() => this.doConnect(), delay);
    } else {
      this.updateState({
        status: 'error',
        error: reason || 'Connection failed',
      });
    }
  }

  disconnect(): void {
    this.server = null;
    this.clearTimers();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.updateState({
      status: 'disconnected',
      error: undefined,
      reconnectAttempts: 0,
    });
  }

  private clearTimers(): void {
    this.clearConnectionTimer();
    this.clearReconnectTimer();
    this.clearPingInterval();
  }

  private clearConnectionTimer(): void {
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearPingInterval(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private startPingInterval(): void {
    this.clearPingInterval();
    this.pingTimer = setInterval(() => {
      if (this.isConnected()) {
        this.send({ type: 'ping' }).catch(() => {
          // Ping failed, connection may be dead
          console.log('Ping failed, connection may be dead');
        });
      }
    }, PING_INTERVAL);
  }

  private updateState(updates: Partial<ConnectionState>): void {
    this.connectionState = { ...this.connectionState, ...updates };
    this.stateChangeHandlers.forEach((handler) => {
      try {
        handler(this.connectionState);
      } catch (error) {
        console.error('State change handler error:', error);
      }
    });
  }

  async sendRequest(
    type: string,
    payload?: unknown,
    timeoutMs: number = 10000
  ): Promise<WebSocketResponse> {
    const requestId = `req_${++this.requestCounter}`;

    return new Promise((resolve, reject) => {
      // Set timeout for request
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('Request timeout'));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.send({ type, payload, requestId }).catch((error) => {
        this.pendingRequests.delete(requestId);
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  async send(message: WebSocketMessage): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }

    this.ws.send(JSON.stringify(message));
  }

  isConnected(): boolean {
    return this.connectionState.status === 'connected' && this.ws?.readyState === WebSocket.OPEN;
  }

  getState(): ConnectionState {
    return this.connectionState;
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStateChange(handler: StateChangeHandler): () => void {
    this.stateChangeHandlers.add(handler);
    // Immediately call with current state
    handler(this.connectionState);
    return () => this.stateChangeHandlers.delete(handler);
  }

  // Check if the connection is actually alive and reconnect if dead.
  // Called on app resume from background where the OS may have killed the socket.
  checkHealth(): void {
    if (!this.server || this.server.enabled === false) return;

    // If we think we're connected but the socket is dead, force reconnect
    if (this.connectionState.status === 'connected' && this.ws?.readyState !== WebSocket.OPEN) {
      console.log('Health check: socket dead, reconnecting');
      this.connectionState.reconnectAttempts = 0;
      this.disconnect();
      this.connect(this.server);
      return;
    }

    // If we're in error state (e.g., max reconnects exhausted while backgrounded), retry
    if (this.connectionState.status === 'error') {
      console.log('Health check: in error state, retrying');
      this.connectionState.reconnectAttempts = 0;
      this.connect(this.server);
      return;
    }

    // If connected, restart the ping interval (timers may have been frozen)
    if (this.connectionState.status === 'connected' && this.ws?.readyState === WebSocket.OPEN) {
      this.startPingInterval();
    }
  }

  // Force a reconnection attempt
  reconnect(): void {
    const server = this.server;
    if (server) {
      this.connectionState.reconnectAttempts = 0;
      this.disconnect();
      this.connect(server);
    }
  }

  // Get current server ID
  getServerId(): string | null {
    return this.server?.id || null;
  }

  // Get current server connection info for HTTP requests
  getServerInfo(): { host: string; port: number; token: string; useTls: boolean } | null {
    if (!this.server) return null;
    return {
      host: this.server.host,
      port: this.server.port,
      token: this.server.token,
      useTls: this.server.useTls,
    };
  }

  // Flush queued messages when connected
  private async flushMessageQueue(): Promise<void> {
    if (this.isFlushingQueue || !this.server) return;

    this.isFlushingQueue = true;
    const serverId = this.server.id;

    try {
      const queued = await messageQueue.getMessagesForServer(serverId);
      console.log(`Flushing ${queued.length} queued messages`);

      for (const msg of queued) {
        if (!this.isConnected()) {
          console.log('Connection lost during queue flush');
          break;
        }

        let success = false;
        try {
          switch (msg.type) {
            case 'text': {
              const textResponse = await this.sendRequest('send_input', { input: msg.content });
              success = textResponse.success;
              break;
            }
            case 'combined': {
              const combinedResponse = await this.sendRequest('send_with_images', {
                imagePaths: msg.imagePaths || [],
                message: msg.content,
              });
              success = combinedResponse.success;
              break;
            }
            default:
              success = false;
          }
        } catch (err) {
          console.error('Failed to send queued message:', err);
          success = false;
        }

        // Notify listeners
        this.queueFlushHandlers.forEach((handler) => {
          try {
            handler(msg, success);
          } catch (err) {
            console.error('Queue flush handler error:', err);
          }
        });

        if (success) {
          await messageQueue.dequeue(msg.id);
        }
      }
    } finally {
      this.isFlushingQueue = false;
    }
  }

  // Subscribe to queue flush events
  onQueueFlush(handler: QueueFlushHandler): () => void {
    this.queueFlushHandlers.add(handler);
    return () => this.queueFlushHandlers.delete(handler);
  }
}

// Singleton instance
export const wsService = new WebSocketService();
