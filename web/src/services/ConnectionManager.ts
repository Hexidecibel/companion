import { Server, ConnectionState } from '../types';
import { ServerConnection } from './ServerConnection';

export interface ConnectionSnapshot {
  serverId: string;
  serverName: string;
  state: ConnectionState;
  gitEnabled: boolean;
}

type ChangeHandler = (snapshots: ConnectionSnapshot[]) => void;

export class ConnectionManager {
  private connections: Map<string, ServerConnection> = new Map();
  private changeHandlers: Set<ChangeHandler> = new Set();
  private cleanupFns: Map<string, () => void> = new Map();

  constructor() {
    // Reconnect dropped connections when app returns from background
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        for (const conn of this.connections.values()) {
          const state = conn.getState();
          if (conn.getServer().enabled !== false && state.status !== 'connected' && state.status !== 'connecting') {
            conn.reconnect();
          }
        }
      }
    });
  }

  connectServer(server: Server): void {
    let conn = this.connections.get(server.id);
    if (conn) {
      conn.updateServerConfig(server);
      if (server.enabled !== false && !conn.isConnected()) {
        conn.connect();
      }
      return;
    }

    conn = new ServerConnection(server);

    const unsub = conn.onStateChange(() => {
      this.notifyChange();
    });
    this.cleanupFns.set(server.id, unsub);

    this.connections.set(server.id, conn);

    if (server.enabled !== false) {
      conn.connect();
    }

    this.notifyChange();
  }

  connectAll(servers: Server[]): void {
    // Remove connections for servers no longer in the list
    for (const id of this.connections.keys()) {
      if (!servers.find((s) => s.id === id)) {
        this.disconnectServer(id);
      }
    }

    for (const server of servers) {
      this.connectServer(server);
    }
  }

  disconnectServer(serverId: string): void {
    const conn = this.connections.get(serverId);
    if (conn) {
      conn.disconnect();
      this.connections.delete(serverId);
      const cleanup = this.cleanupFns.get(serverId);
      if (cleanup) {
        cleanup();
        this.cleanupFns.delete(serverId);
      }
      this.notifyChange();
    }
  }

  disconnectAll(): void {
    for (const [id, conn] of this.connections) {
      conn.disconnect();
      const cleanup = this.cleanupFns.get(id);
      if (cleanup) cleanup();
    }
    this.connections.clear();
    this.cleanupFns.clear();
    this.notifyChange();
  }

  getConnection(serverId: string): ServerConnection | undefined {
    return this.connections.get(serverId);
  }

  getSnapshots(): ConnectionSnapshot[] {
    const snapshots: ConnectionSnapshot[] = [];
    for (const conn of this.connections.values()) {
      snapshots.push({
        serverId: conn.serverId,
        serverName: conn.getServer().name,
        state: conn.getState(),
        gitEnabled: conn.gitEnabled,
      });
    }
    return snapshots;
  }

  getConnectedCount(): number {
    let count = 0;
    for (const conn of this.connections.values()) {
      if (conn.isConnected()) count++;
    }
    return count;
  }

  getTotalCount(): number {
    return this.connections.size;
  }

  onChange(handler: ChangeHandler): () => void {
    this.changeHandlers.add(handler);
    return () => this.changeHandlers.delete(handler);
  }

  private notifyChange(): void {
    const snapshots = this.getSnapshots();
    this.changeHandlers.forEach((handler) => {
      try {
        handler(snapshots);
      } catch (error) {
        console.error('ConnectionManager change handler error:', error);
      }
    });
  }
}

export const connectionManager = new ConnectionManager();
