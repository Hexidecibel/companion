import WebSocket from 'ws';
import { randomUUID } from 'crypto';

import { ServerConfig } from './config';
import {
  CapabilityDisabled,
  DaemonRequestFailed,
  DaemonUnreachable,
  OriginNotAllowed,
  TransportInsecure,
} from './errors';

const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30_000;
const CONNECTION_TIMEOUT = 10_000;
const AUTH_TIMEOUT = 10_000;
const DEFAULT_REQUEST_TIMEOUT = 15_000;

export interface RemoteCapabilities {
  enabled: boolean;
  exec: boolean;
  dispatch: boolean;
  write: { enabled: boolean; roots: string[] };
}

export interface CapabilitiesResponse {
  daemonVersion?: string;
  protocolVersion?: number;
  remoteCapabilities: RemoteCapabilities;
}

const DISABLED_CAPS: RemoteCapabilities = {
  enabled: false,
  exec: false,
  dispatch: false,
  write: { enabled: false, roots: [] },
};

interface WsMessage {
  type: string;
  success?: boolean;
  payload?: unknown;
  error?: string;
  requestId?: string;
  [key: string]: unknown;
}

interface Pending {
  resolve: (response: WsMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isLoopback(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.startsWith('127.')
  );
}

export class DaemonClient {
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private pending: Map<string, Pending> = new Map();
  private capabilities: RemoteCapabilities | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    public readonly config: ServerConfig,
    private readonly origin: string
  ) {
    this.assertTransportSafe();
  }

  get name(): string {
    return this.config.name;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.capabilities !== null;
  }

  getCapabilities(): RemoteCapabilities | null {
    return this.capabilities;
  }

  requireCapability(action: 'exec' | 'dispatch' | 'write'): void {
    const caps = this.capabilities;
    if (!caps || !caps.enabled) {
      throw new CapabilityDisabled(action, this.config.name);
    }
    if (action === 'write') {
      if (!caps.write.enabled) {
        throw new CapabilityDisabled(action, this.config.name);
      }
      return;
    }
    if (!caps[action]) {
      throw new CapabilityDisabled(action, this.config.name);
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Client closed'));
    }
    this.pending.clear();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  async ensureConnected(): Promise<void> {
    if (this.isConnected()) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async sendRequest<T = unknown>(
    type: string,
    payload?: unknown,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT
  ): Promise<T> {
    await this.ensureConnected();
    return this.rawRequest<T>(type, payload, timeoutMs);
  }

  private assertTransportSafe(): void {
    const { host, useTls, trustedNetwork } = this.config;
    if (useTls) return;
    if (isLoopback(host)) return;
    if (trustedNetwork) return;
    throw new TransportInsecure(host);
  }

  private async doConnect(): Promise<void> {
    if (this.closed) throw new Error('Client closed');

    const protocol = this.config.useTls ? 'wss' : 'ws';
    const url = `${protocol}://${this.config.host}:${this.config.port}`;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      const connectTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        reject(new DaemonUnreachable(this.config.name, 'connection timeout'));
      }, CONNECTION_TIMEOUT);

      ws.on('open', () => {
        clearTimeout(connectTimer);
        if (settled) return;
        settled = true;
        this.ws = ws;
        this.wireWs(ws);
        resolve();
      });

      ws.on('error', (err) => {
        clearTimeout(connectTimer);
        if (settled) return;
        settled = true;
        reject(new DaemonUnreachable(this.config.name, String(err)));
      });

      ws.on('close', () => {
        clearTimeout(connectTimer);
        if (!settled) {
          settled = true;
          reject(new DaemonUnreachable(this.config.name, 'closed before open'));
        }
      });
    });

    // Authenticate
    const authResponse = await this.rawRequest<WsMessage>(
      'authenticate',
      undefined,
      AUTH_TIMEOUT,
      { token: this.config.token, origin: this.origin }
    );
    if (!authResponse.success) {
      this.teardown();
      if (authResponse.error === 'origin_not_allowed') {
        throw new OriginNotAllowed(this.config.name, this.origin);
      }
      throw new DaemonRequestFailed('authenticate', authResponse.error || 'auth failed');
    }

    // Probe capabilities. Old daemons reply with "Unknown message type" — treat as all-off.
    try {
      const caps = await this.rawRequest<WsMessage>(
        'get_capabilities',
        undefined,
        AUTH_TIMEOUT
      );
      if (caps.success && caps.payload) {
        const payload = caps.payload as CapabilitiesResponse;
        this.capabilities = payload.remoteCapabilities ?? DISABLED_CAPS;
      } else if (caps.error && /unknown message type/i.test(caps.error)) {
        this.capabilities = DISABLED_CAPS;
      } else {
        this.capabilities = DISABLED_CAPS;
      }
    } catch {
      this.capabilities = DISABLED_CAPS;
    }

    this.reconnectAttempts = 0;
  }

  private wireWs(ws: WebSocket): void {
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as WsMessage;
        if (msg.requestId && this.pending.has(msg.requestId)) {
          const p = this.pending.get(msg.requestId)!;
          this.pending.delete(msg.requestId);
          clearTimeout(p.timer);
          p.resolve(msg);
        }
        // Broadcasts without requestId are ignored — this client is request/response only.
      } catch (err) {
        process.stderr.write(
          `[companion-remote-mcp] Failed to parse daemon message: ${String(err)}\n`
        );
      }
    });

    ws.on('close', () => {
      this.handleDisconnect();
    });

    ws.on('error', (err) => {
      process.stderr.write(
        `[companion-remote-mcp] WS error for "${this.config.name}": ${String(err)}\n`
      );
    });
  }

  private handleDisconnect(): void {
    this.teardown();
    if (this.closed) return;

    this.reconnectAttempts++;
    const delay = Math.min(
      INITIAL_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts - 1),
      MAX_RECONNECT_DELAY
    );
    const jitter = Math.random() * 500;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected().catch((err) => {
        process.stderr.write(
          `[companion-remote-mcp] Reconnect failed for "${this.config.name}": ${String(err)}\n`
        );
      });
    }, delay + jitter);
  }

  private teardown(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Connection lost'));
    }
    this.pending.clear();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.capabilities = null;
  }

  private rawRequest<T = unknown>(
    type: string,
    payload: unknown,
    timeoutMs: number,
    extra?: Record<string, unknown>
  ): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new DaemonUnreachable(this.config.name, 'not connected'));
    }

    const requestId = randomUUID();
    const message: Record<string, unknown> = { type, requestId, ...extra };
    if (payload !== undefined) {
      message.payload = payload;
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new DaemonRequestFailed(type, 'request timeout'));
      }, timeoutMs);

      this.pending.set(requestId, {
        resolve: (response) => resolve(response as unknown as T),
        reject,
        timer,
      });

      try {
        ws.send(JSON.stringify(message));
      } catch (err) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(new DaemonRequestFailed(type, String(err)));
      }
    });
  }
}

export class DaemonPool {
  private clients: Map<string, DaemonClient> = new Map();

  constructor(
    private readonly servers: ServerConfig[],
    private readonly origin: string
  ) {}

  list(): ServerConfig[] {
    return this.servers;
  }

  getOrigin(): string {
    return this.origin;
  }

  getCached(name: string): DaemonClient | null {
    return this.clients.get(name) ?? null;
  }

  get(name: string): DaemonClient {
    let client = this.clients.get(name);
    if (client) return client;

    const cfg = this.servers.find((s) => s.name === name);
    if (!cfg) {
      throw new Error(`Unknown server "${name}"`);
    }
    client = new DaemonClient(cfg, this.origin);
    this.clients.set(name, client);
    return client;
  }

  closeAll(): void {
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
  }
}
