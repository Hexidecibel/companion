import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionManager } from '../ConnectionManager';
import type { Server } from '../../types';

// ---------------------------------------------------------------------------
// Mock WebSocket (minimal — enough for ConnectionManager tests)
// ---------------------------------------------------------------------------

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sentMessages: string[] = [];

  constructor(_url: string) {
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);

// Mock document.addEventListener for visibilitychange
const listeners: Record<string, Function[]> = {};
vi.stubGlobal('document', {
  addEventListener: (event: string, handler: Function) => {
    listeners[event] = listeners[event] || [];
    listeners[event].push(handler);
  },
  visibilityState: 'visible',
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeServer(id: string, overrides: Partial<Server> = {}): Server {
  return {
    id,
    name: `Server ${id}`,
    host: 'localhost',
    port: 9877,
    token: 'secret',
    useTls: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConnectionManager', () => {
  let manager: ConnectionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new ConnectionManager();
  });

  afterEach(() => {
    manager.disconnectAll();
    vi.useRealTimers();
  });

  it('connects a server and tracks it', () => {
    manager.connectServer(makeServer('s1'));
    expect(manager.getTotalCount()).toBe(1);
    expect(manager.getConnection('s1')).toBeDefined();
  });

  it('connects multiple servers', () => {
    manager.connectServer(makeServer('s1'));
    manager.connectServer(makeServer('s2'));
    expect(manager.getTotalCount()).toBe(2);
  });

  it('returns snapshots for all connections', () => {
    manager.connectServer(makeServer('s1'));
    manager.connectServer(makeServer('s2'));

    const snapshots = manager.getSnapshots();
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((s) => s.serverId).sort()).toEqual(['s1', 's2']);
  });

  it('includes serverName and gitEnabled in snapshots', () => {
    manager.connectServer(makeServer('s1', { name: 'My Server' }));

    const snapshots = manager.getSnapshots();
    expect(snapshots[0].serverName).toBe('My Server');
    // gitEnabled defaults to true before auth
    expect(snapshots[0].gitEnabled).toBe(true);
  });

  it('disconnects a specific server', () => {
    manager.connectServer(makeServer('s1'));
    manager.connectServer(makeServer('s2'));
    manager.disconnectServer('s1');

    expect(manager.getTotalCount()).toBe(1);
    expect(manager.getConnection('s1')).toBeUndefined();
    expect(manager.getConnection('s2')).toBeDefined();
  });

  it('disconnects all servers', () => {
    manager.connectServer(makeServer('s1'));
    manager.connectServer(makeServer('s2'));
    manager.disconnectAll();

    expect(manager.getTotalCount()).toBe(0);
  });

  it('updates existing server config without creating duplicate', () => {
    manager.connectServer(makeServer('s1', { port: 9877 }));
    manager.connectServer(makeServer('s1', { port: 9878 }));

    // Should still be 1 connection
    expect(manager.getTotalCount()).toBe(1);
  });

  it('connectAll removes servers no longer in list', () => {
    manager.connectServer(makeServer('s1'));
    manager.connectServer(makeServer('s2'));
    manager.connectServer(makeServer('s3'));

    // Only s1 and s3 should remain
    manager.connectAll([makeServer('s1'), makeServer('s3')]);
    expect(manager.getTotalCount()).toBe(2);
    expect(manager.getConnection('s2')).toBeUndefined();
  });

  it('notifies change handlers on connect', () => {
    const snapshots: any[] = [];
    manager.onChange((s) => snapshots.push(s));

    manager.connectServer(makeServer('s1'));
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    // Last snapshot should include the new server
    const latest = snapshots[snapshots.length - 1];
    expect(latest.some((s: any) => s.serverId === 's1')).toBe(true);
  });

  it('notifies change handlers on disconnect', () => {
    manager.connectServer(makeServer('s1'));

    const snapshots: any[] = [];
    manager.onChange((s) => snapshots.push(s));

    manager.disconnectServer('s1');
    const latest = snapshots[snapshots.length - 1];
    expect(latest).toHaveLength(0);
  });

  it('unsubscribes change handlers', () => {
    const calls: any[] = [];
    const unsub = manager.onChange((s) => calls.push(s));
    unsub();

    manager.connectServer(makeServer('s1'));
    expect(calls).toHaveLength(0);
  });

  it('does not connect disabled servers', () => {
    manager.connectServer(makeServer('s1', { enabled: false }));
    expect(manager.getTotalCount()).toBe(1); // tracked but not connected
    // The state should be disconnected
    const snapshots = manager.getSnapshots();
    expect(snapshots[0].state.status).toBe('disconnected');
  });

  it('getConnectedCount returns 0 when no servers are authenticated', () => {
    // Servers are added but WS hasn't completed auth yet
    manager.connectServer(makeServer('s1'));
    expect(manager.getConnectedCount()).toBe(0);
  });

  it('handles disconnect of non-existent server gracefully', () => {
    expect(() => manager.disconnectServer('nonexistent')).not.toThrow();
  });
});
