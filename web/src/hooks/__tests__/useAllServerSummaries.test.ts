import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ServerSummary } from '../../types';

// ---- a controllable fake ConnectionManager -------------------------------------
type Pending = { resolve: (r: unknown) => void; reject: (e: Error) => void };
const pending: Pending[] = [];
let status: 'connected' | 'reconnecting' = 'connected';
let lastConnected = 1;
const changeHandlers = new Set<(s: unknown[]) => void>();
const snapshot = () => [{ serverId: 'a', serverName: 'A', state: { status, reconnectAttempts: 0, lastConnected }, gitEnabled: true }];
const conn = {
  isConnected: () => status === 'connected',
  getState: () => ({ status, reconnectAttempts: 0, lastConnected }),
  sendRequest: vi.fn(() => new Promise((resolve, reject) => pending.push({ resolve, reject }))),
};

vi.mock('../../services/ConnectionManager', () => ({
  connectionManager: {
    getSnapshots: () => snapshot(),
    getConnection: () => conn,
    onChange: (h: (s: unknown[]) => void) => { changeHandlers.add(h); return () => changeHandlers.delete(h); },
  },
}));
vi.mock('../../services/storage', () => ({ getServers: () => [{ id: 'a' }] }));
const saved: ServerSummary[] = [];
vi.mock('../../services/offlineCache', () => ({
  initOfflineCache: () => Promise.resolve(),
  getCachedSummaries: () => new Map([['a', { key: 'a', updatedAt: 1, summary: cachedSummary }]]),
  saveSummary: (_id: string, s: ServerSummary) => { saved.push(s); },
  onOfflineCacheLoaded: () => () => {},
  forgetServer: () => Promise.resolve(),
}));

const sess = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, status: 'idle', ...extra });
const summary = (...sessions: ReturnType<typeof sess>[]) =>
  ({ sessions, totalSessions: sessions.length, waitingCount: 0, workingCount: 0 }) as unknown as ServerSummary;
const cachedSummary = summary(sess('cached'));

import { useAllServerSummaries, mergeSummary } from '../useAllServerSummaries';

const answer = async (i: number, payload: ServerSummary | null, ok = true) => {
  await act(async () => {
    pending[i].resolve({ success: ok, payload });
  });
};

describe('useAllServerSummaries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pending.length = 0;
    saved.length = 0;
    status = 'connected';
    lastConnected = 1;
    conn.sendRequest.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the cached summary immediately, before any answer', () => {
    const { result } = renderHook(() => useAllServerSummaries());
    expect(result.current.get('a')?.sessions[0].id).toBe('cached');
  });

  it('keeps one request in flight per server', async () => {
    renderHook(() => useAllServerSummaries());
    expect(conn.sendRequest).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000 * 3); });
    expect(conn.sendRequest).toHaveBeenCalledTimes(1); // still waiting on the first
    await answer(0, summary(sess('x')));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(conn.sendRequest).toHaveBeenCalledTimes(2);
  });

  it('discards an answer that arrives after a newer one (reconnect in between)', async () => {
    const { result } = renderHook(() => useAllServerSummaries());
    // New connection generation: the old request no longer blocks a new one.
    lastConnected = 2;
    status = 'reconnecting';
    act(() => changeHandlers.forEach((h) => h(snapshot())));
    status = 'connected';
    act(() => changeHandlers.forEach((h) => h(snapshot())));
    expect(conn.sendRequest).toHaveBeenCalledTimes(2);
    await answer(1, summary(sess('new')));
    expect(result.current.get('a')?.sessions[0].id).toBe('new');
    await answer(0, summary(sess('old')));
    expect(result.current.get('a')?.sessions[0].id).toBe('new');
  });

  it('keeps the last good summary when a refresh fails or the server drops', async () => {
    const { result } = renderHook(() => useAllServerSummaries());
    await answer(0, summary(sess('good')));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await act(async () => { pending[1].reject(new Error('Request timeout')); });
    expect(result.current.get('a')?.sessions[0].id).toBe('good');
    status = 'reconnecting';
    act(() => changeHandlers.forEach((h) => h(snapshot())));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(result.current.get('a')?.sessions[0].id).toBe('good');
  });

  it('keeps Map and session identity when nothing changed', async () => {
    const { result } = renderHook(() => useAllServerSummaries());
    await answer(0, summary(sess('x'), sess('y')));
    const map1 = result.current;
    const y1 = map1.get('a')!.sessions[1];
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await answer(1, summary(sess('x'), sess('y')));
    expect(result.current).toBe(map1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await answer(2, summary(sess('x', { status: 'working' }), sess('y')));
    expect(result.current).not.toBe(map1);
    expect(result.current.get('a')!.sessions[1]).toBe(y1);
    expect(saved.length).toBe(3);
  });

  it('does not re-poll on connection changes that are not a (re)connect', () => {
    renderHook(() => useAllServerSummaries());
    act(() => changeHandlers.forEach((h) => h(snapshot())));
    act(() => changeHandlers.forEach((h) => h(snapshot())));
    expect(conn.sendRequest).toHaveBeenCalledTimes(1);
  });
});

describe('mergeSummary', () => {
  it('returns prev when equal and reuses unchanged sessions', () => {
    const a = summary(sess('1'), sess('2'));
    expect(mergeSummary(a, summary(sess('1'), sess('2')))).toBe(a);
    const b = mergeSummary(a, summary(sess('1'), sess('2', { status: 'waiting' })));
    expect(b).not.toBe(a);
    expect(b.sessions[0]).toBe(a.sessions[0]);
    expect(b.sessions[1]).not.toBe(a.sessions[1]);
  });
});
