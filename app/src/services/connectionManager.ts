import {
  Server,
  ConnectionState,
  WebSocketMessage,
  WebSocketResponse,
} from '../types';
import { WebSocketService } from './websocket';
import { QueuedMessage } from './messageQueue';

type StateChangeHandler = (serverId: string, state: ConnectionState) => void;
type MessageHandler = (serverId: string, message: WebSocketResponse) => void;

class ConnectionManager {
  private connections: Map<string, WebSocketService> = new Map();
  private servers: Map<string, Server> = new Map();
  private stateHandlers: Set<StateChangeHandler> = new Set();
  private messageHandlers: Set<MessageHandler> = new Set();
  private cleanupFns: Map<string, (() => void)[]> = new Map();
  activeServerId: string | null = null;

  syncServers(serverList: Server[]): void {
    const serverIds = new Set(serverList.map((s) => s.id));

    // Remove connections for servers no longer in list
    for (const id of [...this.connections.keys()]) {
      if (!serverIds.has(id)) {
        this.removeConnection(id);
      }
    }

    // Add/update connections
    for (const server of serverList) {
      this.servers.set(server.id, server);

      if (server.enabled === false) {
        // Disconnect disabled servers
        if (this.connections.has(server.id)) {
          this.removeConnection(server.id);
        }
        continue;
      }

      let conn = this.connections.get(server.id);
      if (!conn) {
        conn = new WebSocketService();
        this.connections.set(server.id, conn);

        const cleanups: (() => void)[] = [];

        // Track state changes
        const unsubState = conn.onStateChange((state) => {
          this.stateHandlers.forEach((handler) => {
            try {
              handler(server.id, state);
            } catch (err) {
              console.error('ConnectionManager state handler error:', err);
            }
          });
        });
        cleanups.push(unsubState);

        // Track messages
        const unsubMsg = conn.onMessage((msg) => {
          this.messageHandlers.forEach((handler) => {
            try {
              handler(server.id, msg);
            } catch (err) {
              console.error('ConnectionManager message handler error:', err);
            }
          });
        });
        cleanups.push(unsubMsg);

        this.cleanupFns.set(server.id, cleanups);
        conn.connect(server);
      }
    }
  }

  private removeConnection(serverId: string): void {
    const conn = this.connections.get(serverId);
    if (conn) {
      conn.disconnect();
      this.connections.delete(serverId);
    }
    const cleanups = this.cleanupFns.get(serverId);
    if (cleanups) {
      cleanups.forEach((fn) => fn());
      this.cleanupFns.delete(serverId);
    }
    this.servers.delete(serverId);
    if (this.activeServerId === serverId) {
      this.activeServerId = null;
    }
  }

  addConnection(server: Server): void {
    this.syncServers([...this.servers.values(), server]);
  }

  getConnection(serverId: string): WebSocketService | undefined {
    return this.connections.get(serverId);
  }

  getActive(): WebSocketService | null {
    if (!this.activeServerId) return null;
    return this.connections.get(this.activeServerId) || null;
  }

  setActive(serverId: string | null): void {
    this.activeServerId = serverId;
  }

  checkHealthAll(): void {
    for (const conn of this.connections.values()) {
      conn.checkHealth();
    }
  }

  onStateChange(handler: StateChangeHandler): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  disconnectAll(): void {
    for (const id of [...this.connections.keys()]) {
      this.removeConnection(id);
    }
  }

  getConnectedCount(): number {
    let count = 0;
    for (const conn of this.connections.values()) {
      if (conn.isConnected()) count++;
    }
    return count;
  }
}

export const connectionManager = new ConnectionManager();

// Backward-compatible wsService proxy that delegates to the active connection.
// Screens that operate on a specific server (SessionView, etc.) use this after
// App.tsx sets the active server via connectionManager.setActive(server.id).
export const wsService = {
  connect(server: Server): void {
    connectionManager.setActive(server.id);
    if (!connectionManager.getConnection(server.id)) {
      connectionManager.addConnection(server);
    }
  },

  disconnect(): void {
    connectionManager.setActive(null);
  },

  sendRequest(
    type: string,
    payload?: unknown,
    timeoutMs: number = 10000
  ): Promise<WebSocketResponse> {
    const conn = connectionManager.getActive();
    if (!conn) return Promise.reject(new Error('No active connection'));
    return conn.sendRequest(type, payload, timeoutMs);
  },

  async send(message: WebSocketMessage): Promise<void> {
    const conn = connectionManager.getActive();
    if (!conn) throw new Error('No active connection');
    return conn.send(message);
  },

  isConnected(): boolean {
    return connectionManager.getActive()?.isConnected() ?? false;
  },

  getState(): ConnectionState {
    return (
      connectionManager.getActive()?.getState() ?? {
        status: 'disconnected' as const,
        reconnectAttempts: 0,
      }
    );
  },

  getServerId(): string | null {
    return connectionManager.activeServerId;
  },

  getServerInfo(): {
    host: string;
    port: number;
    token: string;
    useTls: boolean;
  } | null {
    return connectionManager.getActive()?.getServerInfo() ?? null;
  },

  onMessage(handler: (message: WebSocketResponse) => void): () => void {
    const conn = connectionManager.getActive();
    if (!conn) return () => {};
    return conn.onMessage(handler);
  },

  onStateChange(handler: (state: ConnectionState) => void): () => void {
    const conn = connectionManager.getActive();
    if (!conn) {
      handler({ status: 'disconnected', reconnectAttempts: 0 });
      return () => {};
    }
    return conn.onStateChange(handler);
  },

  checkHealth(): void {
    connectionManager.checkHealthAll();
  },

  reconnect(): void {
    connectionManager.getActive()?.reconnect();
  },

  onQueueFlush(
    handler: (message: QueuedMessage, success: boolean) => void
  ): () => void {
    const conn = connectionManager.getActive();
    if (!conn) return () => {};
    return conn.onQueueFlush(handler);
  },
};
