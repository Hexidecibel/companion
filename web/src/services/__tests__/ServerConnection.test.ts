import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ServerConnection } from '../ServerConnection';
import type { Server } from '../../types';

// ---------------------------------------------------------------------------
// Mock WebSocket
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

  url: string;
  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    // Simulate async open
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

  // Test helpers
  simulateMessage(data: object): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose(reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ reason });
  }
}

// Install mock
let lastCreatedWs: MockWebSocket | null = null;
vi.stubGlobal('WebSocket', class extends MockWebSocket {
  constructor(url: string) {
    super(url);
    lastCreatedWs = this;
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeServer(overrides: Partial<Server> = {}): Server {
  return {
    id: 'srv1',
    name: 'Test Server',
    host: 'localhost',
    port: 9877,
    token: 'secret',
    useTls: false,
    ...overrides,
  };
}

/** Flush microtasks (lets async continuations run). */
function flushMicrotasks(): Promise<void> {
  return new Promise((r) => queueMicrotask(r));
}

/** Advance timers until the WebSocket opens and auth message is sent. */
async function connectAndAuth(conn: ServerConnection): Promise<MockWebSocket> {
  conn.connect();
  // Flush the setTimeout(0) that opens the WebSocket
  await vi.advanceTimersByTimeAsync(0);
  const ws = lastCreatedWs!;
  // Flush the 50ms delay before authenticate() is called
  await vi.advanceTimersByTimeAsync(50);
  return ws;
}

/** Complete auth handshake and flush async continuations. */
async function completeAuth(
  ws: MockWebSocket,
  extras: Record<string, unknown> = {}
): Promise<void> {
  const authMsg = JSON.parse(ws.sentMessages[0]);
  ws.simulateMessage({
    type: 'authenticate',
    success: true,
    requestId: authMsg.requestId,
    ...extras,
  });
  // The authenticate() method is async — flush its continuations
  await flushMicrotasks();
  await flushMicrotasks();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ServerConnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lastCreatedWs = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- Connection lifecycle ----

  it('creates WebSocket with correct URL', async () => {
    const conn = new ServerConnection(makeServer());
    const ws = await connectAndAuth(conn);
    expect(ws.url).toBe('ws://localhost:9877');
  });

  it('uses wss:// when useTls is true', async () => {
    const conn = new ServerConnection(makeServer({ useTls: true }));
    const ws = await connectAndAuth(conn);
    expect(ws.url).toBe('wss://localhost:9877');
  });

  it('sends authenticate message on open', async () => {
    const conn = new ServerConnection(makeServer({ token: 'mytoken' }));
    const ws = await connectAndAuth(conn);
    expect(ws.sentMessages.length).toBeGreaterThanOrEqual(1);
    const authMsg = JSON.parse(ws.sentMessages[0]);
    expect(authMsg.type).toBe('authenticate');
    expect(authMsg.token).toBe('mytoken');
    expect(authMsg.requestId).toBeDefined();
  });

  it('transitions to connected on successful auth', async () => {
    const conn = new ServerConnection(makeServer());
    const states: string[] = [];
    conn.onStateChange((state) => states.push(state.status));

    const ws = await connectAndAuth(conn);
    await completeAuth(ws);

    expect(states).toContain('connecting');
    expect(states).toContain('connected');
    expect(conn.isConnected()).toBe(true);
  });

  it('transitions to error on failed auth', async () => {
    const conn = new ServerConnection(makeServer());
    const ws = await connectAndAuth(conn);

    const authMsg = JSON.parse(ws.sentMessages[0]);
    ws.simulateMessage({
      type: 'authenticate',
      success: false,
      error: 'Bad token',
      requestId: authMsg.requestId,
    });
    await flushMicrotasks();

    expect(conn.getState().status).toBe('error');
    expect(conn.getState().error).toContain('Bad token');
  });

  it('does not connect when server is disabled', () => {
    const conn = new ServerConnection(makeServer({ enabled: false }));
    conn.connect();
    expect(lastCreatedWs).toBeNull();
    expect(conn.getState().status).toBe('disconnected');
  });

  it('guards against double-connect', async () => {
    const conn = new ServerConnection(makeServer());
    conn.connect();
    await vi.advanceTimersByTimeAsync(0);
    const firstWs = lastCreatedWs;

    conn.connect(); // second connect — should be no-op
    expect(lastCreatedWs).toBe(firstWs); // no new WS created
  });

  // ---- Disconnect ----

  it('disconnects cleanly', async () => {
    const conn = new ServerConnection(makeServer());
    const ws = await connectAndAuth(conn);
    await completeAuth(ws);

    conn.disconnect();
    expect(conn.getState().status).toBe('disconnected');
    expect(conn.isConnected()).toBe(false);
  });

  it('rejects pending requests on disconnect', async () => {
    const conn = new ServerConnection(makeServer());
    const ws = await connectAndAuth(conn);
    await completeAuth(ws);

    // Send a request that won't get a response
    const promise = conn.sendRequest('get_status');
    conn.disconnect();

    await expect(promise).rejects.toThrow('Disconnected');
  });

  // ---- Reconnection ----

  it('schedules reconnection on close', async () => {
    const conn = new ServerConnection(makeServer());
    const ws = await connectAndAuth(conn);
    await completeAuth(ws);

    // Simulate unexpected close
    ws.simulateClose('Server went away');

    expect(conn.getState().status).toBe('reconnecting');
    expect(conn.getState().reconnectAttempts).toBe(1);
  });

  it('increments reconnect attempts on repeated failures', async () => {
    const conn = new ServerConnection(makeServer());
    const ws = await connectAndAuth(conn);

    ws.simulateClose('disconnected');
    const firstAttempts = conn.getState().reconnectAttempts;
    expect(firstAttempts).toBeGreaterThanOrEqual(1);

    // Advance past first reconnect delay (1s)
    await vi.advanceTimersByTimeAsync(1000);
    const ws2 = lastCreatedWs!;
    await vi.advanceTimersByTimeAsync(0); // let it "open"
    ws2.simulateClose('still down');

    // Should have incremented
    expect(conn.getState().reconnectAttempts).toBeGreaterThan(firstAttempts);
  });

  // ---- Request/Response matching ----

  it('matches responses by requestId', async () => {
    const conn = new ServerConnection(makeServer());
    const ws = await connectAndAuth(conn);
    await completeAuth(ws);

    // Send request
    const promise = conn.sendRequest('get_status', { sessionId: 's1' });

    // Find the requestId from the sent message
    const reqMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
    expect(reqMsg.type).toBe('get_status');
    expect(reqMsg.requestId).toBeDefined();

    // Respond
    ws.simulateMessage({
      type: 'get_status',
      success: true,
      payload: { status: 'ok' },
      requestId: reqMsg.requestId,
    });

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.payload).toEqual({ status: 'ok' });
  });

  it('times out requests', async () => {
    const conn = new ServerConnection(makeServer());
    const ws = await connectAndAuth(conn);
    await completeAuth(ws);

    // Send request with short timeout
    const promise = conn.sendRequest('get_status', undefined, 100);

    // Advance only enough to trigger our request timeout, not the subscribe timeout (10s)
    vi.advanceTimersByTime(100);

    await expect(promise).rejects.toThrow('Request timeout');

    // Clean up to avoid unhandled rejections from other pending timers
    conn.disconnect();
    vi.clearAllTimers();
  });

  // ---- Message handlers ----

  it('dispatches broadcast messages to handlers', async () => {
    const conn = new ServerConnection(makeServer());
    const ws = await connectAndAuth(conn);
    await completeAuth(ws);

    const received: object[] = [];
    conn.onMessage((msg) => received.push(msg));

    // Simulate broadcast (no requestId)
    ws.simulateMessage({ type: 'status_change', success: true, payload: { waiting: true } });

    expect(received).toHaveLength(1);
    expect((received[0] as any).type).toBe('status_change');
  });

  it('unsubscribes message handlers', async () => {
    const conn = new ServerConnection(makeServer());
    const ws = await connectAndAuth(conn);
    await completeAuth(ws);

    const received: object[] = [];
    const unsub = conn.onMessage((msg) => received.push(msg));
    unsub();

    ws.simulateMessage({ type: 'status_change', success: true });
    expect(received).toHaveLength(0);
  });

  // ---- State change handlers ----

  it('calls state handler immediately with current state on subscribe', () => {
    const conn = new ServerConnection(makeServer());
    const states: string[] = [];
    conn.onStateChange((state) => states.push(state.status));
    expect(states).toContain('disconnected');
  });

  it('unsubscribes state change handlers', async () => {
    const conn = new ServerConnection(makeServer());
    const states: string[] = [];
    const unsub = conn.onStateChange((state) => states.push(state.status));
    states.length = 0;
    unsub();

    conn.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toHaveLength(0);
  });

  // ---- isLocal / gitEnabled ----

  it('parses isLocal from auth response', async () => {
    const conn = new ServerConnection(makeServer());
    const ws = await connectAndAuth(conn);
    await completeAuth(ws, { isLocal: true });

    expect(conn.isLocal).toBe(true);
  });

  it('parses gitEnabled from auth response', async () => {
    const conn = new ServerConnection(makeServer());
    const ws = await connectAndAuth(conn);
    await completeAuth(ws, { gitEnabled: false });

    expect(conn.gitEnabled).toBe(false);
  });

  it('defaults gitEnabled to true', async () => {
    const conn = new ServerConnection(makeServer());
    const ws = await connectAndAuth(conn);
    await completeAuth(ws);

    expect(conn.gitEnabled).toBe(true);
  });

  // ---- Server config update ----

  it('reconnects when server config changes', async () => {
    const conn = new ServerConnection(makeServer());
    const ws = await connectAndAuth(conn);
    await completeAuth(ws);
    expect(conn.isConnected()).toBe(true);

    // Update config with different host
    conn.updateServerConfig(makeServer({ host: '192.168.1.2' }));

    // Should disconnect and create a new WebSocket
    await vi.advanceTimersByTimeAsync(0);
    expect(lastCreatedWs!.url).toBe('ws://192.168.1.2:9877');
  });

  it('disconnects when server is disabled via config update', async () => {
    const conn = new ServerConnection(makeServer());
    const ws = await connectAndAuth(conn);
    await completeAuth(ws);

    conn.updateServerConfig(makeServer({ enabled: false }));
    expect(conn.getState().status).toBe('disconnected');
  });

  // ---- send() errors ----

  it('throws when sending on disconnected socket', async () => {
    const conn = new ServerConnection(makeServer());
    await expect(conn.send({ type: 'ping' })).rejects.toThrow('not connected');
  });
});
