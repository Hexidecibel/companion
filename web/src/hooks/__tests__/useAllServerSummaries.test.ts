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
const messageHandlers = new Set<(m: { type: string }) => void>();
const conn = {
  onMessage: (h: (m: { type: string }) => void) => { messageHandlers.add(h); return () => messageHandlers.delete(h); },
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
const cacheLoaded = new Set<() => void>();
vi.mock('../../services/offlineCache', () => ({
  initOfflineCache: () => Promise.resolve(),
  getCachedSummaries: () => new Map([['a', { key: 'a', updatedAt: 1, summary: cachedSummary }]]),
  saveSummary: (_id: string, s: ServerSummary) => { saved.push(s); },
  onOfflineCacheLoaded: (fn: () => void) => { cacheLoaded.add(fn); return () => cacheLoaded.delete(fn); },
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

describe('useAllServerSummaries: live status (regressions)', () => {
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

  it('a status change reaches the list within one poll', async () => {
    const { result } = renderHook(() => useAllServerSummaries());
    await answer(0, summary(sess('s1', { status: 'waiting' })));
    expect(result.current.get('a')?.sessions[0].status).toBe('waiting');
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(conn.sendRequest).toHaveBeenCalledTimes(2);
    await answer(1, summary(sess('s1', { status: 'working', currentActivity: 'Processing...' })));
    expect(result.current.get('a')?.sessions[0].status).toBe('working');
    // ... and back, with background work: still applied on the next poll.
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await answer(2, summary(sess('s1', { status: 'working', backgroundWork: { agents: 2, shells: 0 } })));
    expect(result.current.get('a')?.sessions[0]).toMatchObject({ backgroundWork: { agents: 2, shells: 0 } });
  });

  it('a status broadcast re-polls right away instead of waiting for the interval', async () => {
    const { result } = renderHook(() => useAllServerSummaries());
    await answer(0, summary(sess('s1', { status: 'waiting' })));
    act(() => messageHandlers.forEach((h) => h({ type: 'other_session_activity' })));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(conn.sendRequest).toHaveBeenCalledTimes(2);
    await answer(1, summary(sess('s1', { status: 'working' })));
    expect(result.current.get('a')?.sessions[0].status).toBe('working');
  });

  it('a status broadcast during an in-flight poll is followed by one more poll', async () => {
    renderHook(() => useAllServerSummaries());
    act(() => messageHandlers.forEach((h) => h({ type: 'status_change' })));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(conn.sendRequest).toHaveBeenCalledTimes(1); // one in flight
    await answer(0, summary(sess('stale')));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(conn.sendRequest).toHaveBeenCalledTimes(2); // the change is fetched now, not in 5 s
  });

  it('the offline cache never overrides fresher data', async () => {
    const { result } = renderHook(() => useAllServerSummaries());
    expect(result.current.get('a')?.sessions[0].id).toBe('cached');
    await answer(0, summary(sess('fresh', { status: 'working' })));
    // The cache finishing its (slow) load afterwards must not bring the old list back.
    act(() => cacheLoaded.forEach((fn) => fn()));
    expect(result.current.get('a')?.sessions[0].id).toBe('fresh');
    expect(result.current.get('a')?.sessions[0].status).toBe('working');
    expect(saved[saved.length - 1].sessions[0].id).toBe('fresh');
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
