import { describe, expect, it, vi } from 'vitest';
import type { WebSocketResponse } from '../../types';
import type { SubagentSummary } from '../../types/subagents';

vi.mock('../ConnectionManager', () => ({ connectionManager: { getSnapshots: () => [], onChange: () => () => undefined, getConnection: () => undefined } }));

import { AgentsStore, type AgentsTransport } from '../agentsStore';

const ag = (agentId: string, sessionId = 'c1', version = 1): SubagentSummary => ({
  agentId, sessionId, depth: 1, name: agentId, status: 'running', startedAt: 1, lastEntryAt: 2,
  toolCalls: 0, edits: 0, filesTouched: 0, tokens: 0, recent: [], version,
});

function fakeTransport(listPayload: unknown, opts: { unsupported?: boolean; facts?: unknown } = {}) {
  const handlers = new Set<(m: WebSocketResponse) => void>();
  const reconnects = new Set<() => void>();
  const calls: Array<[string, unknown]> = [];
  const t: AgentsTransport = {
    isConnected: () => true,
    request: async (type, payload) => {
      calls.push([type, payload]);
      if (type === 'subagent_list') {
        if (opts.unsupported) return { type, success: false, error: 'Unknown message type: subagent_list' } as WebSocketResponse;
        return { type, success: true, payload: listPayload } as WebSocketResponse;
      }
      if (type === 'subagent_rollup') return { type, success: true, payload: { text: '', running: 0, total: 0, facts: opts.facts } } as WebSocketResponse;
      return { type, success: true, payload: { watching: 1 } } as WebSocketResponse;
    },
    onMessage: (h) => { handlers.add(h); return () => handlers.delete(h); },
    onReconnect: (h) => { reconnects.add(h); return () => reconnects.delete(h); },
  };
  return { t, calls, emit: (m: WebSocketResponse) => handlers.forEach((h) => h(m)), handlers };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('AgentsStore', () => {
  it('lists every session, watches all, merges deltas, ignores per-session events, unwatches on release', async () => {
    const f = fakeTransport({ agents: [ag('a')], running: 1, total: 1, rollup: '', generatedAt: 0, sessions: { c1: { session: 'Out4', sessionId: 'out4' } } });
    const store = new AgentsStore({ servers: () => [{ serverId: 's', serverName: 'hexi' }], onServersChange: () => () => undefined, transport: () => f.t });
    const release = store.retain();
    await flush(); await flush();
    expect(f.calls.slice(0, 2)).toEqual([['subagent_list', {}], ['subagent_watch', { live: true }]]);
    expect(store.getSnapshot()[0].labels.c1.session).toBe('Out4');
    f.emit({ type: 'subagent_update', success: true, payload: { agents: [ag('b')], at: 1 } } as WebSocketResponse);
    f.emit({ type: 'subagent_update', success: true, payload: { sessionId: 'out4', agents: [ag('c')], at: 1 } } as WebSocketResponse);
    await flush();
    expect(store.getSnapshot()[0].agents.map((a) => a.agentId).sort()).toEqual(['a', 'b']);
    release();
    await flush();
    expect(f.calls[f.calls.length - 1]).toEqual(['subagent_watch', { live: false }]);
    expect(f.handlers.size).toBe(0);
  });

  it('older daemon without labels: names from facts', async () => {
    const f = fakeTransport(
      { agents: [ag('a')], running: 1, total: 1, rollup: '', generatedAt: 0 },
      { facts: { sessions: [{ conversationId: 'c1', session: 'Docs', sessionId: 'docs' }] } },
    );
    const store = new AgentsStore({ servers: () => [{ serverId: 's', serverName: 'hexi' }], onServersChange: () => () => undefined, transport: () => f.t });
    const release = store.retain();
    await flush(); await flush(); await flush();
    expect(store.getSnapshot()[0].labels.c1).toEqual({ session: 'Docs', sessionId: 'docs' });
    release();
  });

  it('marks a server without the tracker unsupported and never watches', async () => {
    const f = fakeTransport(null, { unsupported: true });
    const store = new AgentsStore({ servers: () => [{ serverId: 's', serverName: 'hexi' }], onServersChange: () => () => undefined, transport: () => f.t });
    const release = store.retain();
    await flush(); await flush();
    expect(store.getSnapshot()[0]).toMatchObject({ unsupported: true, loaded: true });
    expect(f.calls.some(([t]) => t === 'subagent_watch')).toBe(false);
    release();
  });

  it('hidden page: no list / watch; becoming visible lists, hiding unwatches', async () => {
    let visible = false;
    let onVis: () => void = () => undefined;
    const f = fakeTransport({ agents: [], running: 0, total: 0, rollup: '', generatedAt: 0, sessions: {} });
    const store = new AgentsStore({
      servers: () => [{ serverId: 's', serverName: 'hexi' }],
      onServersChange: () => () => undefined,
      transport: () => f.t,
      visible: () => visible,
      onVisibilityChange: (h) => { onVis = h; return () => undefined; },
    });
    const release = store.retain();
    await flush();
    expect(f.calls).toEqual([]);
    visible = true; onVis();
    await flush(); await flush();
    expect(f.calls.map(([t]) => t)).toEqual(['subagent_list', 'subagent_watch']);
    visible = false; onVis();
    await flush();
    expect(f.calls[f.calls.length - 1]).toEqual(['subagent_watch', { live: false }]);
    release();
  });

  it('shares one watch between several subscribers (ref-counted)', async () => {
    const f = fakeTransport({ agents: [], running: 0, total: 0, rollup: '', generatedAt: 0, sessions: {} });
    const store = new AgentsStore({ servers: () => [{ serverId: 's', serverName: 'hexi' }], onServersChange: () => () => undefined, transport: () => f.t });
    const r1 = store.retain();
    const r2 = store.retain();
    await flush(); await flush();
    r1();
    await flush();
    expect(f.calls.filter(([t, p]) => t === 'subagent_watch' && (p as { live: boolean }).live === false)).toHaveLength(0);
    r2();
    await flush();
    expect(f.calls.filter(([t, p]) => t === 'subagent_watch' && (p as { live: boolean }).live === false)).toHaveLength(1);
  });
});
