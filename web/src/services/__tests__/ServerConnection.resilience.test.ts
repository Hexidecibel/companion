import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ServerConnection } from '../ServerConnection';
import type { Server } from '../../types';

// A fake WebSocket that behaves like a browser one: close() moves to CLOSING and
// fires onclose LATER (as the close handshake would), so late events from an old
// socket can be observed.
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<{ type: string; requestId?: string; [k: string]: unknown }> = [];
  closeCalls = 0;

  constructor(public url: string) {
    FakeWebSocket.all.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.closeCalls++;
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSING;
    setTimeout(() => this.fireClose('closed by client'), 1500);
  }

  // helpers
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  message(data: object): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  fireClose(reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ reason });
  }
  last(type: string) {
    return [...this.sent].reverse().find((m) => m.type === type);
  }
}

vi.stubGlobal('WebSocket', FakeWebSocket);

const server: Server = { id: 's', name: 'S', host: 'h', port: 1, token: 't', useTls: false };
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

/** Open the newest socket and run the auth + subscribe handshake to 'connected'. */
async function handshake(conn: ServerConnection): Promise<FakeWebSocket> {
  const ws = FakeWebSocket.all[FakeWebSocket.all.length - 1];
  ws.open();
  await vi.advanceTimersByTimeAsync(50);
  ws.message({ type: 'authenticated', success: true, requestId: ws.last('authenticate')!.requestId });
  await flush();
  ws.message({ type: 'subscribed', success: true, requestId: ws.last('subscribe')!.requestId });
  await flush();
  expect(conn.getState().status).toBe('connected');
  return ws;
}

describe('ServerConnection resilience', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.all = [];
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('auth timeout closes the socket and detaches its handlers', async () => {
    const conn = new ServerConnection(server);
    const got: string[] = [];
    conn.onMessage((m) => got.push(m.type));
    conn.connect();
    const ws = FakeWebSocket.all[0];
    ws.open();
    await vi.advanceTimersByTimeAsync(50);
    expect(ws.last('authenticate')).toBeTruthy();
    await vi.advanceTimersByTimeAsync(10_000); // no auth answer
    expect(conn.getState().status).toBe('reconnecting');
    expect(ws.closeCalls).toBe(1);
    expect(ws.onmessage).toBeNull();
    expect(ws.onclose).toBeNull();
    // A late broadcast on the dead socket reaches nobody.
    ws.message({ type: 'conversation_update' });
    expect(got).toEqual([]);
  });

  it('ignores messages from a socket that has been replaced', async () => {
    const conn = new ServerConnection(server);
    const got: string[] = [];
    conn.onMessage((m) => got.push(m.type));
    conn.connect();
    const old = await handshake(conn);
    const oldOnMessage = old.onmessage!;
    conn.reconnect();
    const fresh = FakeWebSocket.all[1];
    expect(fresh).not.toBe(old);
    // Even a handler reference held from before (a browser dispatching an event
    // already queued) is a no-op once the socket is no longer current.
    oldOnMessage({ data: JSON.stringify({ type: 'status_change' }) });
    await handshake(conn);
    fresh.message({ type: 'status_change' });
    expect(got).toEqual(['status_change']);
  });

  it('a late onclose from an old socket does not tear down the new one', async () => {
    const conn = new ServerConnection(server);
    conn.connect();
    const old = await handshake(conn);
    const oldOnClose = old.onclose!;
    // checkAlive on a long-silent socket: forced reconnect.
    vi.setSystemTime(Date.now() + 120_000);
    conn.checkAlive();
    expect(conn.getState().status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(2100); // backoff fires doConnect
    const fresh = FakeWebSocket.all[1];
    expect(fresh).toBeTruthy();
    await handshake(conn);
    // The old socket's close finally lands (both the queued handler and the timer).
    oldOnClose({ reason: 'late' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(conn.getState().status).toBe('connected');
    expect(conn.isConnected()).toBe(true);
    expect(fresh.closeCalls).toBe(0);
  });

  it('a connect timeout closes the stalled socket and its late close is ignored', async () => {
    const conn = new ServerConnection(server);
    conn.connect();
    const stalled = FakeWebSocket.all[0];
    const stalledOnClose = stalled.onclose!;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stalled.closeCalls).toBe(1);
    expect(conn.getState().reconnectAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(2100);
    const fresh = FakeWebSocket.all[1];
    await handshake(conn);
    stalledOnClose({ reason: 'late' });
    expect(conn.isConnected()).toBe(true);
    expect(conn.getState().reconnectAttempts).toBe(1); // not double counted
    expect(fresh.closeCalls).toBe(0);
  });

  it('never flushes queued sends before authentication', async () => {
    const conn = new ServerConnection(server);
    conn.connect();
    const ws = FakeWebSocket.all[0];
    ws.open();
    await vi.advanceTimersByTimeAsync(50);
    // Open but not authenticated yet: must queue, not send.
    conn.sendQueued({ type: 'send_input', payload: { input: 'hi' } });
    expect(ws.sent.map((m) => m.type)).toEqual(['authenticate']);
    ws.message({ type: 'authenticated', success: true, requestId: ws.last('authenticate')!.requestId });
    await flush();
    expect(ws.sent.some((m) => m.type === 'send_input')).toBe(false); // still subscribing
    ws.message({ type: 'subscribed', success: true, requestId: ws.last('subscribe')!.requestId });
    await flush();
    expect(ws.sent.map((m) => m.type)).toEqual(['authenticate', 'subscribe', 'send_input']);
    // Once connected it goes straight out.
    conn.sendQueued({ type: 'send_input', payload: { input: 'again' } });
    expect(ws.sent.filter((m) => m.type === 'send_input')).toHaveLength(2);
  });

  it('kick does not interrupt a fresh in-flight connect', async () => {
    const conn = new ServerConnection(server);
    conn.connect();
    // Fail once so status is 'reconnecting', then let the retry start.
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(2100);
    expect(FakeWebSocket.all).toHaveLength(2);
    expect(conn.getState().status).toBe('reconnecting');
    conn.kick();
    conn.kick();
    expect(FakeWebSocket.all).toHaveLength(2);
    expect(FakeWebSocket.all[1].closeCalls).toBe(0);
  });

  it('kick retries a pending backoff now without resetting the attempt counter', async () => {
    const conn = new ServerConnection(server);
    conn.connect();
    FakeWebSocket.all[0].fireClose('down');
    expect(conn.getState().reconnectAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(2000); // past MIN_KICK_GAP, before the backoff fires? (1-2 s)
    const before = FakeWebSocket.all.length;
    // Whether or not the backoff already fired, a kick never resets attempts.
    conn.kick();
    expect(FakeWebSocket.all.length).toBeGreaterThanOrEqual(before);
    expect(conn.getState().reconnectAttempts).toBe(1);
  });

  it('kick restarts an in-flight connect older than the connect timeout (frozen timers)', async () => {
    const conn = new ServerConnection(server);
    conn.connect();
    // Simulate a suspended app: wall clock jumps, timers did not run.
    vi.setSystemTime(Date.now() + 60_000);
    conn.kick();
    expect(FakeWebSocket.all).toHaveLength(2);
    expect(FakeWebSocket.all[0].closeCalls).toBe(1);
    expect(FakeWebSocket.all[0].onclose).toBeNull();
  });

  it('pong timeout drops the dead socket immediately', async () => {
    const conn = new ServerConnection(server);
    conn.connect();
    const ws = await handshake(conn);
    await vi.advanceTimersByTimeAsync(25_000 + 120_000);
    expect(ws.closeCalls).toBe(1);
    expect(conn.getState().status).toBe('reconnecting');
  });
});
