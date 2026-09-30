import { Server, ConnectionState, WebSocketMessage, WebSocketResponse } from '../types';

type MessageHandler = (message: WebSocketResponse) => void;
type StateChangeHandler = (state: ConnectionState) => void;
type ReconnectHandler = () => void;

const MAX_RECONNECT_ATTEMPTS = Infinity;
const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const PING_INTERVAL = 25000;
// Aligned with the daemon's 90s dead-connection tolerance. We tolerate
// MAX_MISSED_PONGS silent windows before declaring the socket dead, so the
// effective grace before a forced reconnect is PONG_TIMEOUT * MAX_MISSED_PONGS.
const PONG_TIMEOUT = 60000;
const MAX_MISSED_PONGS = 2;
const CONNECTION_TIMEOUT = 10000;
// Minimum continuous uptime before the reconnect backoff counter is reset to 0.
// A link that flaps faster than this keeps its accumulated attempts so the
// exponential backoff actually widens instead of resetting every reconnect.
const STABLE_UPTIME = 30000;

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
  private reconnectHandlers: Set<ReconnectHandler> = new Set();
  private hasConnectedBefore = false;
  private pendingRequests: Map<string, { resolve: (r: WebSocketResponse) => void; reject: (e: Error) => void }> = new Map();

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private requestCounter = 0;
  private lastSessionId: string | undefined;

  // Liveness / zombie-socket tracking.
  private lastPongAt = 0;
  private missedPongs = 0;
  // Latch so a single drop only runs handleDisconnect() once (the connect-timeout
  // path closes the socket AND calls handleDisconnect, and the later onclose would
  // otherwise fire it a second time, double-incrementing reconnectAttempts).
  private isDisconnecting = false;

  // Outbound send queue for fire-and-forget user payloads composed while the
  // socket is briefly down (reconnect window). Flushed on re-auth.
  private outboundQueue: unknown[] = [];
  private static readonly MAX_OUTBOUND_QUEUE = 100;

  constructor(server: Server) {
    this.server = server;
    this.serverId = server.id;
  }

  connect(): void {
    if (this.server.enabled === false) {
      return;
    }

    // Only guard against a genuinely live or in-flight socket. We key off the
    // actual WebSocket readyState rather than connectionState.status so that an
    // explicit connect() can always break out of a pending backoff: while we sit
    // in 'reconnecting' between retries there is no socket (handleDisconnect
    // nulled it), so this guard correctly lets us reconnect immediately instead
    // of waiting out the exponential delay.
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    // An explicit connect() means "retry now" — cancel any scheduled backoff so
    // a stale timer can't fire a second doConnect() on top of this one.
    this.clearReconnectTimer();
    this.doConnect();
  }

  private doConnect(): void {
    this.clearTimers();
    // New connection attempt: re-arm the once-per-drop latch.
    this.isDisconnecting = false;

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
        const subscribePayload = this.lastSessionId ? { sessionId: this.lastSessionId } : undefined;
        const subResponse = await this.sendRequest('subscribe', subscribePayload, 10000);
        if (subResponse.type === 'subscribed' && (subResponse as unknown as { sessionId?: string }).sessionId) {
          this.lastSessionId = (subResponse as unknown as { sessionId?: string }).sessionId;
        }

        // Reset liveness trackers before we start pinging.
        this.missedPongs = 0;
        this.lastPongAt = Date.now();

        this.updateState({
          status: 'connected',
          error: undefined,
          lastConnected: Date.now(),
          // NOTE: reconnectAttempts is intentionally NOT reset here — that only
          // happens after STABLE_UPTIME of continuous connection (armStableTimer),
          // so a flapping link keeps widening its backoff.
        });
        this.startPingInterval();
        this.armStableTimer();
        // Deliver anything the user composed while the socket was down.
        this.flushOutboundQueue();

        // Fire reconnect event only on subsequent connections (not the first).
        // Subscribers (e.g. useConversation) use this to refetch state that may
        // have drifted while the socket was down.
        if (this.hasConnectedBefore) {
          this.reconnectHandlers.forEach((handler) => {
            try {
              handler();
            } catch (error) {
              console.error('Reconnect handler error:', error);
            }
          });
        }
        this.hasConnectedBefore = true;
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

      if (message.type === 'pong') {
        this.clearPongTimer();
        this.missedPongs = 0;
        this.lastPongAt = Date.now();
        return;
      }

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
    // Only run once per drop. The connect-timeout path calls close() + this, and
    // the resulting onclose would otherwise re-enter and double-count attempts.
    if (this.isDisconnecting) return;
    this.isDisconnecting = true;

    this.ws = null;
    this.clearTimers();

    this.pendingRequests.forEach(({ reject }) => {
      reject(new Error('Connection lost'));
    });
    this.pendingRequests.clear();

    if (this.server.enabled !== false && this.connectionState.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const attempts = this.connectionState.reconnectAttempts + 1;
      const baseDelay = Math.min(
        INITIAL_RECONNECT_DELAY * Math.pow(2, attempts - 1),
        MAX_RECONNECT_DELAY,
      );
      const jitter = Math.random() * 1000;
      const delay = baseDelay + jitter;

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
    this.clearPongTimer();
    this.clearStableTimer();
  }

  private clearStableTimer(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private armStableTimer(): void {
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      if (this.connectionState.reconnectAttempts !== 0) {
        this.updateState({ reconnectAttempts: 0 });
      }
    }, STABLE_UPTIME);
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

  private clearPongTimer(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private startPingInterval(): void {
    this.clearPingInterval();
    // Arm the liveness baseline so checkAlive() doesn't false-positive before the
    // first pong lands.
    this.lastPongAt = Date.now();
    this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL);
  }

  private sendPing(): void {
    if (!this.isConnected()) return;
    this.send({ type: 'ping' }).catch(() => {});
    // Arm a SINGLE watchdog. Subsequent pings must NOT clear/re-arm it, because
    // PONG_TIMEOUT (60s) exceeds PING_INTERVAL (25s) — the watchdog is cleared
    // only when a pong actually arrives (see handleMessage).
    if (!this.pongTimer) {
      this.pongTimer = setTimeout(() => this.handlePongTimeout(), PONG_TIMEOUT);
    }
  }

  private handlePongTimeout(): void {
    this.pongTimer = null;
    this.missedPongs++;
    if (this.missedPongs >= MAX_MISSED_PONGS) {
      console.warn(
        `[${this.serverId}] Pong timeout (${this.missedPongs} consecutive) — connection dead, reconnecting`,
      );
      this.ws?.close();
    } else {
      console.warn(
        `[${this.serverId}] Missed pong (${this.missedPongs}/${MAX_MISSED_PONGS}) — tolerating, arming another window`,
      );
      this.pongTimer = setTimeout(() => this.handlePongTimeout(), PONG_TIMEOUT);
    }
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

  /**
   * Fire-and-forget send for user-originated payloads (e.g. send_input) that must
   * survive a brief reconnect window. If the socket is OPEN the message goes out
   * immediately; otherwise it is queued (capped, oldest dropped) and flushed once
   * the connection re-authenticates. Unlike send()/sendRequest this never throws.
   *
   * Control messages (ping/authenticate/subscribe) must NOT use this path — they
   * go through send()/sendRequest so their disconnect semantics are preserved and
   * they are never queued or double-sent.
   */
  sendQueued(message: WebSocketMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(message));
        return;
      } catch {
        // fall through to queue
      }
    }
    if (this.outboundQueue.length >= ServerConnection.MAX_OUTBOUND_QUEUE) {
      this.outboundQueue.shift();
      console.warn(`[${this.serverId}] Outbound queue full — dropping oldest queued message`);
    }
    this.outboundQueue.push(message);
  }

  private flushOutboundQueue(): void {
    if (this.outboundQueue.length === 0) return;
    const queued = this.outboundQueue;
    this.outboundQueue = [];
    for (const message of queued) {
      try {
        this.ws?.send(JSON.stringify(message));
      } catch (error) {
        console.error(`[${this.serverId}] Failed to flush queued message:`, error);
      }
    }
  }

  /**
   * Detect and recover a "zombie" socket after mobile suspend/resume: readyState
   * is OPEN and status is 'connected', but no traffic has flowed and the peer is
   * effectively gone. Safe to call frequently; no-op unless currently connected.
   */
  checkAlive(): void {
    if (this.connectionState.status !== 'connected') return;
    const silent = this.lastPongAt > 0 ? Date.now() - this.lastPongAt : 0;
    if (silent > PING_INTERVAL + PONG_TIMEOUT) {
      console.warn(
        `[${this.serverId}] Socket stale on resume (${Math.round(silent / 1000)}s silent) — forcing reconnect`,
      );
      try {
        this.ws?.close();
      } catch {
        // ignore
      }
      this.handleDisconnect('stale on resume');
      return;
    }
    // Not stale yet — send an immediate ping so a dead-but-OPEN socket surfaces
    // fast rather than waiting for the next scheduled ping.
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendPing();
    }
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

  async switchSession(sessionId: string): Promise<boolean> {
    this.lastSessionId = sessionId;
    if (this.isConnected()) {
      try {
        const response = await this.sendRequest('switch_session', { sessionId });
        return response.success;
      } catch {
        return false;
      }
    }
    return false;
  }

  clearSessionSubscription(): void {
    this.lastSessionId = undefined;
    if (this.isConnected()) {
      this.send({ type: 'switch_session', payload: { sessionId: null } }).catch(() => {});
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

  /**
   * Subscribe to reconnect events. Fires once per successful re-auth + re-subscribe
   * AFTER the connection had previously been established and dropped. Does NOT fire
   * on the initial connect — only on subsequent reconnections. Use this to refetch
   * state that may have drifted while the socket was down.
   */
  onReconnect(handler: ReconnectHandler): () => void {
    this.reconnectHandlers.add(handler);
    return () => this.reconnectHandlers.delete(handler);
  }
}
