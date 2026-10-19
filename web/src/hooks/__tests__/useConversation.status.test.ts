import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// A connection whose get_status answers are released by the test.
type Req = { type: string; payload: { sessionId?: string }; resolve: (r: unknown) => void };
const requests: Req[] = [];
const messageHandlers = new Set<(m: unknown) => void>();
const conn = {
  isConnected: () => true,
  getState: () => ({ status: 'connected', reconnectAttempts: 0 }),
  switchSession: vi.fn(async () => true),
  sendRequest: vi.fn(
    (type: string, payload: { sessionId?: string }) =>
      new Promise((resolve) => requests.push({ type, payload, resolve }))
  ),
  onMessage: (h: (m: unknown) => void) => {
    messageHandlers.add(h);
    return () => messageHandlers.delete(h);
  },
  onStateChange: (h: (s: { status: string }) => void) => {
    h({ status: 'connected' });
    return () => {};
  },
};
vi.mock('../../services/ConnectionManager', () => ({
  connectionManager: { getConnection: () => conn },
}));
vi.mock('../../services/offlineCache', () => ({
  loadConversation: () => Promise.resolve(null),
  saveConversation: () => {},
}));

import { useConversation, statusChanged } from '../useConversation';
import { backgroundWorkLabel } from '../../utils/backgroundWork';

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
};
const answerAll = async (sessionId: string, status: Record<string, unknown>) => {
  for (const r of requests.splice(0)) {
    if (r.type === 'get_status') r.resolve({ success: true, sessionId: r.payload.sessionId, payload: status });
    else if (r.type === 'get_highlights')
      r.resolve({ success: true, sessionId: r.payload.sessionId, payload: { highlights: [], total: 0, hasMore: false } });
  }
  void sessionId;
  await flush();
};

describe('useConversation status', () => {
  beforeEach(() => {
    requests.length = 0;
    messageHandlers.clear();
    conn.sendRequest.mockClear();
  });

  it("never shows the previous session's status for the one just opened", async () => {
    const { result, rerender } = renderHook(({ sid }) => useConversation('srv', sid), {
      initialProps: { sid: 'A' },
    });
    await flush();
    await answerAll('A', { isRunning: true, isWaitingForInput: true, lastActivity: 1 });
    expect(result.current.status?.isWaitingForInput).toBe(true);

    // Open B: its answer is still on the way.
    rerender({ sid: 'B' });
    await flush();
    expect(result.current.status).toBeNull();

    // A late answer for A (sent before the switch) must not land on B.
    await act(async () => {
      for (const r of requests.splice(0)) {
        if (r.type === 'get_status') r.resolve({ success: true, sessionId: 'A', payload: { isRunning: true, isWaitingForInput: true, lastActivity: 1 } });
        else r.resolve({ success: true, payload: { highlights: [], total: 0, hasMore: false } });
      }
    });
    await flush();
    expect(result.current.status).toBeNull();
  });

  it('a status_change push for the open session applies at once', async () => {
    const { result } = renderHook(() => useConversation('srv', 'A'));
    await flush();
    await answerAll('A', { isRunning: true, isWaitingForInput: true, lastActivity: 1 });
    act(() =>
      messageHandlers.forEach((h) =>
        h({ type: 'status_change', success: true, sessionId: 'A', payload: { isRunning: true, isWaitingForInput: false, lastActivity: 2, currentActivity: '2 agents running', backgroundWork: { agents: 2, shells: 0 } } })
      )
    );
    expect(result.current.status?.isWaitingForInput).toBe(false);
    expect(result.current.status?.backgroundWork).toEqual({ agents: 2, shells: 0 });
  });
});

describe('statusChanged / backgroundWorkLabel', () => {
  const base = { isRunning: true, isWaitingForInput: false, lastActivity: 1, currentActivity: 'x' };
  it('notices background work changes', () => {
    expect(statusChanged(base, { ...base })).toBe(false);
    expect(statusChanged(base, { ...base, backgroundWork: { agents: 1, shells: 0 } })).toBe(true);
    expect(statusChanged({ ...base, backgroundWork: { agents: 1, shells: 0 } }, { ...base, backgroundWork: { agents: 2, shells: 0 } })).toBe(true);
  });
  it('labels', () => {
    expect(backgroundWorkLabel({ agents: 2, shells: 0 })).toBe('Agents working · 2 running');
    expect(backgroundWorkLabel({ agents: 1, shells: 1 })).toBe('Agents working · 1 running · 1 shell');
    expect(backgroundWorkLabel({ agents: 0, shells: 2 })).toBe('Shells working · 2 running');
    expect(backgroundWorkLabel({ agents: 0, shells: 0 })).toBeNull();
    expect(backgroundWorkLabel(undefined)).toBeNull();
  });
});
