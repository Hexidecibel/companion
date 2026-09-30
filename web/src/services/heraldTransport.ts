import type { WebSocketResponse } from '../types';
import type { HeraldEvent } from '../types/herald';
import { connectionManager } from './ConnectionManager';

/**
 * Minimal surface useHerald needs from a daemon connection. Lets the demo
 * fixture (dev only) stand in for a real hub without touching the socket layer.
 */
export interface HeraldTransport {
  isConnected(): boolean;
  request(type: string, payload?: unknown, timeoutMs?: number): Promise<WebSocketResponse>;
  /** Server-pushed `herald_event` payloads. */
  onEvent(handler: (event: HeraldEvent) => void): () => void;
  /**
   * Fires with the current connectivity immediately, then on every change.
   * A false -> true transition is a (re)connect: callers refetch state there.
   */
  onConnectivity(handler: (connected: boolean) => void): () => void;
}

export const HERALD_EVENT_TYPE = 'herald_event';
export const HERALD_DEMO_SERVER_ID = '__herald_demo__';

export function createConnectionTransport(serverId: string): HeraldTransport | null {
  const conn = connectionManager.getConnection(serverId);
  if (!conn) return null;
  return {
    isConnected: () => conn.isConnected(),
    request: (type, payload, timeoutMs) => conn.sendRequest(type, payload, timeoutMs),
    onEvent: (handler) =>
      conn.onMessage((msg) => {
        if (msg.type === HERALD_EVENT_TYPE && msg.payload && typeof msg.payload === 'object') {
          handler(msg.payload as HeraldEvent);
        }
      }),
    onConnectivity: (handler) => {
      let last: boolean | null = null;
      return conn.onStateChange((s) => {
        const connected = s.status === 'connected';
        if (connected !== last) {
          last = connected;
          handler(connected);
        }
      });
    },
  };
}

/**
 * Dev-only fixture mode: `?heraldDemo=1` on a Vite dev server. Always false in
 * production builds. Gated on MODE rather than DEV because this machine exports
 * NODE_ENV=production globally, which makes DEV false even under `vite` serve.
 */
export function isHeraldDemo(): boolean {
  if (import.meta.env.MODE === 'production') return false;
  try {
    return new URLSearchParams(window.location.search).get('heraldDemo') === '1';
  } catch {
    return false;
  }
}
