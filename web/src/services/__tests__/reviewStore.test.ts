import { describe, expect, it, vi } from 'vitest';
import { ReviewStore, type ReviewStoreConnection } from '../reviewStore';
import { fxSummary } from '../../components/review/__fixtures__/reviewFixtures';
import type { WebSocketResponse } from '../../types';

function fakeConn(listResponse: WebSocketResponse) {
  const msgHandlers = new Set<(m: WebSocketResponse) => void>();
  const stateHandlers = new Set<(s: { status: string }) => void>();
  let connected = false;
  const conn: ReviewStoreConnection & { emit: (m: WebSocketResponse) => void; setState: (s: string) => void; requests: string[] } = {
    requests: [],
    isConnected: () => connected,
    sendRequest: vi.fn(async (type: string) => { conn.requests.push(type); return listResponse; }),
    onMessage: (h) => { msgHandlers.add(h); return () => msgHandlers.delete(h); },
    onStateChange: (h) => { stateHandlers.add(h); h({ status: connected ? 'connected' : 'disconnected' }); return () => stateHandlers.delete(h); },
    emit: (m) => msgHandlers.forEach((h) => h(m)),
    setState: (s) => { connected = s === 'connected'; stateHandlers.forEach((h) => h({ status: s })); },
  };
  return conn;
}

describe('ReviewStore', () => {
  it('drops stale summary versions', () => {
    const store = new ReviewStore();
    expect(store.apply('srv', fxSummary({ version: 5, unreviewedFiles: 5 }))).toBe(true);
    expect(store.apply('srv', fxSummary({ version: 4, unreviewedFiles: 1 }))).toBe(false);
    expect(store.apply('srv', fxSummary({ version: 5, unreviewedFiles: 2 }))).toBe(false);
    expect(store.get('srv', 'sess-1')?.unreviewedFiles).toBe(5);
    expect(store.apply('srv', fxSummary({ version: 6, unreviewedFiles: 0 }))).toBe(true);
    expect(store.get('srv', 'sess-1')?.unreviewedFiles).toBe(0);
  });

  it('applies review_summary events and ignores older ones', () => {
    const store = new ReviewStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.handleMessage('srv', { type: 'review_summary', success: true, payload: { summary: fxSummary({ version: 9 }) } });
    store.handleMessage('srv', { type: 'review_summary', success: true, payload: { summary: fxSummary({ version: 8, unreviewedFiles: 99 }) } });
    expect(store.get('srv', 'sess-1')?.version).toBe(9);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('fetches the list on connect and on every reconnect, replacing what it had', async () => {
    const store = new ReviewStore();
    const conn = fakeConn({ type: 'review_summary_list', success: true, payload: { summaries: [fxSummary({ version: 1 })] } });
    store.attach('srv', conn);
    expect(conn.requests).toEqual([]);
    conn.setState('connected');
    await vi.waitFor(() => expect(store.get('srv', 'sess-1')?.version).toBe(1));
    // A daemon restart resets versions: the list after a reconnect is authoritative.
    store.apply('srv', fxSummary({ version: 50 }));
    conn.setState('reconnecting');
    conn.setState('connected');
    await vi.waitFor(() => expect(store.get('srv', 'sess-1')?.version).toBe(1));
    expect(conn.requests).toEqual(['review_summary_list', 'review_summary_list']);
    expect(store.supported('srv')).toBe(true);
  });

  it('marks an old daemon unsupported', async () => {
    const store = new ReviewStore();
    const conn = fakeConn({ type: 'error', success: false, error: 'Unknown message type: review_summary_list' });
    store.attach('srv', conn);
    conn.setState('connected');
    await vi.waitFor(() => expect(store.supported('srv')).toBe(false));
  });

  it('fans out review_reverted', () => {
    const store = new ReviewStore();
    const fn = vi.fn();
    store.onReverted(fn);
    const ev = { sessionId: 'sess-1', absPath: '/a', effect: 'patch', backupId: 'b1', by: 'Phone', undone: false, at: 1 };
    store.handleMessage('srv', { type: 'review_reverted', success: true, payload: ev });
    expect(fn).toHaveBeenCalledWith('srv', ev);
  });
});
