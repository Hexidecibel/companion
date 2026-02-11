import { Server, ConnectionState, WebSocketMessage, WebSocketResponse } from '../types';

type MessageHandler = (message: WebSocketResponse) => void;
type StateChangeHandler = (state: ConnectionState) => void;

const MAX_RECONNECT_ATTEMPTS = Infinity;
const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const PING_INTERVAL = 25000;
const CONNECTION_TIMEOUT = 10000;

export class ServerConnection {
  readonly serverId: string;
  private ws: WebSocket | null = null;
  private server: Server;
  private _isLocal = false;
  private _gitEnabled = true;
  private connectionState: ConnectionState = {
    status: 'disconnected',
    reconnectAttempts: 0,
  };

  private messageHandlers: Set<MessageHandler> = new Set();
  private stateChangeHandlers: Set<StateChangeHandler> = new Set();
  private pendingRequests: Map<string, { resolve: (r: WebSocketResponse) => void; reject: (e: Error) => void }> = new Map();

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private requestCounter = 0;

  constructor(server: Server) {
    this.server = server;
    this.serverId = server.id;
  }

  connect(): void {
    if (this.server.enabled === false) {
      return;
    }

    // Guard against double-connect
    if (
      this.connectionState.status === 'connecting' ||
      this.connectionState.status === 'reconnecting' ||
      (this.connectionState.status === 'connected' && this.ws?.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    this.doConnect();
  }

  private doConnect(): void {
    this.clearTimers();

    this.updateState({
      status: this.connectionState.reconnectAttempts > 0 ? 'reconnecting' : 'connecting',
    });

    const protocol = this.server.useTls ? 'wss' : 'ws';
    const url = `${protocol}://${this.server.host}:${this.server.port}`;

    try {
      this.ws = new WebSocket(url);

      this.connectionTimer = setTimeout(() => {
        if (this.connectionState.status === 'connecting' || this.connectionState.status === 'reconnecting') {
          this.ws?.close();
          this.handleDisconnect('Connection timeout');
        }
      }, CONNECTION_TIMEOUT);

      this.ws.onopen = () => this.handleOpen();
      this.ws.onmessage = (event) => this.handleMessage(event);
      this.ws.onclose = (event) => this.handleClose(event);
      this.ws.onerror = () => {};
    } catch {
      this.handleDisconnect('Failed to create connection');
    }
  }

  private handleOpen(): void {
    this.clearConnectionTimer();

    setTimeout(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.authenticate(this.server.token);
      }
    }, 50);
  }

  private async authenticate(token: string): Promise<void> {
    try {
      const requestId = `req_${++this.requestCounter}`;
      const response = await new Promise<WebSocketResponse>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingRequests.delete(requestId);
          reject(new Error('Auth timeout'));
        }, 10000);
        this.pendingRequests.set(requestId, {
          resolve: (r) => { clearTimeout(timeout); resolve(r); },
          reject: (e) => { clearTimeout(timeout); reject(e); },
        });
        this.send({ type: 'authenticate', token, requestId }).catch(reject);
      });

      if (response.success) {
        this._isLocal = !!(response as unknown as { isLocal?: boolean }).isLocal;
        this._gitEnabled = (response as unknown as { gitEnabled?: boolean }).gitEnabled !== false;

        // Subscribe to broadcasts so we receive real-time status_change events
        await this.send({ type: 'subscribe', requestId: `req_${++this.requestCounter}` });

        this.updateState({
          status: 'connected',
          error: undefined,
          lastConnected: Date.now(),
          reconnectAttempts: 0,
        });
        this.startPingInterval();
      } else {
        this.updateState({
          status: 'error',
          error: 'Authentication failed: ' + (response.error || 'Invalid token'),
        });
        this.ws?.close();
      }
    } catch {
      this.handleDisconnect('Authentication failed');
    }
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const message: WebSocketResponse = JSON.parse(event.data as string);

      if (message.requestId && this.pendingRequests.has(message.requestId)) {
        const { resolve } = this.pendingRequests.get(message.requestId)!;
        this.pendingRequests.delete(message.requestId);
        resolve(message);
        return;
      }

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
    this.clearTimers();
    this.handleDisconnect(event.reason || 'Connection closed');
  }

  private handleDisconnect(reason: string): void {
    this.ws = null;
    this.clearTimers();

    this.pendingRequests.forEach(({ reject }) => {
      reject(new Error('Connection lost'));
    });
    this.pendingRequests.clear();

    if (this.server.enabled !== false && this.connectionState.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const attempts = this.connectionState.reconnectAttempts + 1;
      const delay = Math.min(
        INITIAL_RECONNECT_DELAY * Math.pow(2, attempts - 1),
        MAX_RECONNECT_DELAY,
      );

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
    this.clearTimers();

    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }

    this.pendingRequests.forEach(({ reject }) => {
      reject(new Error('Disconnected'));
    });
    this.pendingRequests.clear();

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
        this.send({ type: 'ping' }).catch(() => {});
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

  async sendRequest(type: string, payload?: unknown, timeoutMs: number = 10000): Promise<WebSocketResponse> {
    const requestId = `req_${++this.requestCounter}`;

    return new Promise((resolve, reject) => {
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

  getServer(): Server {
    return this.server;
  }

  get isLocal(): boolean {
    return this._isLocal;
  }

  get gitEnabled(): boolean {
    return this._gitEnabled;
  }

  updateServerConfig(server: Server): void {
    const wasConnected = this.isConnected();
    const configChanged =
      this.server.host !== server.host ||
      this.server.port !== server.port ||
      this.server.token !== server.token ||
      this.server.useTls !== server.useTls;

    this.server = server;

    if (server.enabled === false) {
      this.disconnect();
      return;
    }

    if (configChanged && wasConnected) {
      this.disconnect();
      this.connect();
    }
  }

  reconnect(): void {
    this.connectionState.reconnectAttempts = 0;
    this.disconnect();
    this.connect();
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStateChange(handler: StateChangeHandler): () => void {
    this.stateChangeHandlers.add(handler);
    handler(this.connectionState);
    return () => this.stateChangeHandlers.delete(handler);
  }
}
