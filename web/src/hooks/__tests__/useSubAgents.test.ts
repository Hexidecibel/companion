import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSubAgents, SAFETY_RELIST_MS, type SubAgentsTransport } from '../useSubAgents';
import { useSubAgentDetail, nextDetailDelay, POLL_RUNNING } from '../useSubAgentDetail';
import { applyUpdate, orderTree, summaryToSubAgent, statusChip } from '../../services/subagents';
import type { WebSocketResponse } from '../../types';
import type { SubagentSummary } from '../../types/subagents';

function sum(p: Partial<SubagentSummary>): SubagentSummary {
  const now = Date.now();
  return {
    agentId: 'a1',
    sessionId: 'conv',
    depth: 1,
    name: 'Agent one',
    status: 'running',
    startedAt: now - 60_000,
    lastEntryAt: now - 1000,
    toolCalls: 3,
    edits: 0,
    filesTouched: 0,
    tokens: 1000,
    recent: [],
    version: 1,
    ...p,
  };
}

function fakeTransport(handler: (type: string, payload: unknown) => WebSocketResponse) {
  const handlers = new Set<(m: WebSocketResponse) => void>();
  const reconnects = new Set<() => void>();
  const calls: Array<{ type: string; payload: unknown }> = [];
  const t: SubAgentsTransport = {
    isConnected: () => true,
    request: vi.fn(async (type: string, payload: unknown) => {
      calls.push({ type, payload });
      return handler(type, payload);
    }),
    onMessage: (h) => { handlers.add(h); return () => handlers.delete(h); },
    onReconnect: (h) => { reconnects.add(h); return () => reconnects.delete(h); },
  };
  return { t, calls, emit: (m: WebSocketResponse) => handlers.forEach((h) => h(m)), reconnect: () => reconnects.forEach((h) => h()), handlers };
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('subagent helpers', () => {
  it('applyUpdate replaces changed agents, drops removed, keeps identity when nothing changed', () => {
    const m = new Map([['a1', sum({})]]);
    expect(applyUpdate(m, { agents: [sum({})], at: 1 })).toBe(m);
    const n = applyUpdate(m, { agents: [sum({ version: 2, activity: 'Bash: ls' }), sum({ agentId: 'a2' })], at: 1 });
    expect(n.get('a1')!.activity).toBe('Bash: ls');
    expect(n.size).toBe(2);
    expect(applyUpdate(n, { agents: [], removed: ['a2'], at: 2 }).size).toBe(1);
  });

  it('orderTree puts children under their parent, running first', () => {
    const now = Date.now();
    const list = [
      summaryToSubAgent(sum({ agentId: 'child', parentAgentId: 'p1', depth: 2, lastEntryAt: now })),
      summaryToSubAgent(sum({ agentId: 'done', status: 'done', endedAt: now, lastEntryAt: now })),
      summaryToSubAgent(sum({ agentId: 'p1', lastEntryAt: now - 5000 })),
    ];
    expect(orderTree(list).map((a) => a.agentId)).toEqual(['p1', 'child', 'done']);
  });

  it('status chips', () => {
    expect(statusChip(summaryToSubAgent(sum({ status: 'waiting_child' }))).label).toBe('waiting on child');
    expect(statusChip(summaryToSubAgent(sum({ status: 'done_unconfirmed' }))).label).toBe('finished (unconfirmed)');
    expect(statusChip(summaryToSubAgent(sum({ stuck: { kind: 'loop', severity: 'medium', headline: 'x', summary: 'y', since: 0 } }))).label).toBe('stuck');
    expect(summaryToSubAgent(sum({ status: 'failed', endedAt: 5 })).status).toBe('error');
  });
});

describe('useSubAgents', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: false }));
  afterEach(() => vi.useRealTimers());

  it('lists once, watches, merges deltas for its session, suppresses no-op updates', async () => {
    const f = fakeTransport((type) => {
      if (type === 'subagent_list')
        return { type, success: true, payload: { agents: [sum({})], running: 1, total: 1, rollup: '', generatedAt: 1 } };
      return { type, success: true, payload: { watching: 1 } };
    });
    let renders = 0;
    const { result, unmount } = renderHook(() => {
      renders++;
      return useSubAgents('srv', 'tmux1', f.t);
    });
    await flush();
    expect(result.current.mode).toBe('watch');
    expect(result.current.agents).toHaveLength(1);
    expect(result.current.runningCount).toBe(1);
    expect(f.calls.map((c) => c.type)).toEqual(['subagent_list', 'subagent_watch']);
    expect(f.calls[1].payload).toEqual({ sessionId: 'tmux1', live: true });

    const before = renders;
    act(() => {
      // Same version: no state change, no re-render.
      f.emit({ type: 'subagent_update', success: true, payload: { sessionId: 'tmux1', agents: [sum({})], at: 2 } });
      // Another session's event is ignored.
      f.emit({ type: 'subagent_update', success: true, payload: { sessionId: 'other', agents: [sum({ agentId: 'zz' })], at: 2 } });
    });
    expect(renders).toBe(before);
    act(() => {
      f.emit({ type: 'subagent_update', success: true, payload: { sessionId: 'tmux1', agents: [sum({ version: 2, status: 'done', endedAt: Date.now() })], at: 3 } });
    });
    expect(result.current.agents[0].status).toBe('completed');
    expect(result.current.runningCount).toBe(0);

    // Safety re-list, then reconnect re-list + re-watch.
    await act(async () => { vi.advanceTimersByTime(SAFETY_RELIST_MS); });
    await flush();
    expect(f.calls.filter((c) => c.type === 'subagent_list')).toHaveLength(2);
    act(() => f.reconnect());
    await flush();
    expect(f.calls.filter((c) => c.type === 'subagent_watch')).toHaveLength(2);
    unmount();
    expect(f.calls[f.calls.length - 1]).toEqual({ type: 'subagent_watch', payload: { sessionId: 'tmux1', live: false } });
    expect(f.handlers.size).toBe(0);
  });

  it('falls back to get_agent_tree polling on an older daemon', async () => {
    const f = fakeTransport((type) => {
      if (type === 'subagent_list') return { type: 'error', success: false, error: 'Unknown message type: subagent_list' };
      return {
        type,
        success: true,
        payload: {
          agents: [{ agentId: 'x', slug: 'x', sessionId: 'c', status: 'running', startedAt: 1, messageCount: 2, lastActivity: 2 }],
          totalAgents: 1,
          runningCount: 1,
          completedCount: 0,
        },
      };
    });
    const { result } = renderHook(() => useSubAgents('srv', 'tmux1', f.t));
    await flush();
    await flush();
    expect(result.current.mode).toBe('legacy');
    expect(result.current.agents).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(2000); });
    await flush();
    expect(f.calls.filter((c) => c.type === 'get_agent_tree').length).toBe(2);
    expect(f.calls.some((c) => c.type === 'subagent_watch')).toBe(false);
  });
});

describe('useSubAgentDetail', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: false }));
  afterEach(() => vi.useRealTimers());

  it('decides the next delay from the latest status', () => {
    expect(nextDetailDelay(true, 'running')).toBe(POLL_RUNNING);
    expect(nextDetailDelay(true, 'completed')).toBeNull();
    expect(nextDetailDelay(false, 'completed')).toBe(10000);
  });

  it('stops polling a finished agent; does nothing while disabled', async () => {
    let status = 'running';
    const request = vi.fn(async (type: string) => ({
      type,
      success: true,
      payload: { agent: { agentId: 'a', slug: 'a', sessionId: 'c', status, startedAt: 1, messageCount: 1, lastActivity: 1 }, highlights: [] },
    }));
    const transport = { isConnected: () => true, request };
    const { rerender } = renderHook((p: { enabled: boolean }) => useSubAgentDetail('srv', 'a', { enabled: p.enabled, transport }), {
      initialProps: { enabled: false },
    });
    await flush();
    expect(request).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(POLL_RUNNING); });
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    status = 'completed';
    await act(async () => { vi.advanceTimersByTime(POLL_RUNNING); });
    await flush();
    expect(request).toHaveBeenCalledTimes(3);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    await flush();
    expect(request).toHaveBeenCalledTimes(3);
  });
});
