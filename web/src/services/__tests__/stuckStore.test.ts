import { describe, expect, it, vi } from 'vitest';
import { StuckStore, type StuckStoreConnection } from '../stuckStore';
import type { WebSocketResponse } from '../../types';
import { STUCK_DEFAULTS, type StuckFinding } from '../../types/stuck';

export const fxFinding = (over: Partial<StuckFinding> = {}): StuckFinding => ({
  id: 'out4|repeated_failure|abc',
  sessionId: 'out4',
  sessionName: 'Out4',
  kind: 'repeated_failure',
  severity: 'medium',
  signature: 'abc',
  summary: 'Same test failing 6 times in 18 min: api.test.ts › retries',
  headline: 'same test failing 6 times',
  evidence: ['$ npm test 2>&1 | tail -40', 'expect(received).toBe(expected)'],
  firstSeen: Date.now() - 18 * 60_000,
  lastSeen: Date.now(),
  count: 6,
  turnId: 't1',
  ...over,
});

function fakeConn(list: WebSocketResponse) {
  const msg = new Set<(m: WebSocketResponse) => void>();
  const st = new Set<(s: { status: string }) => void>();
  let connected = false;
  const conn: StuckStoreConnection & { emit: (m: WebSocketResponse) => void; setState: (s: string) => void } = {
    isConnected: () => connected,
    sendRequest: vi.fn(async () => list),
    onMessage: (h) => { msg.add(h); return () => msg.delete(h); },
    onStateChange: (h) => { st.add(h); h({ status: connected ? 'connected' : 'disconnected' }); return () => st.delete(h); },
    emit: (m) => msg.forEach((h) => h(m)),
    setState: (s) => { connected = s === 'connected'; st.forEach((h) => h({ status: s })); },
  };
  return conn;
}

describe('StuckStore', () => {
  it('fetches stuck_list on connect and applies stuck_update events (full list)', async () => {
    const store = new StuckStore();
    const conn = fakeConn({ type: 'stuck_list', success: true, payload: { findings: [fxFinding()], settings: STUCK_DEFAULTS } });
    store.attach('srv', conn);
    conn.setState('connected');
    await Promise.resolve();
    await Promise.resolve();
    expect(store.forSession('srv', 'out4')).toHaveLength(1);
    expect(store.settings('srv')?.noProgressMin).toBe(30);
    conn.emit({ type: 'stuck_update', success: true, payload: { findings: [] } });
    expect(store.forSession('srv', 'out4')).toEqual([]);
    expect(store.supported('srv')).toBe(true);
  });

  it('marks old daemons unsupported', async () => {
    const store = new StuckStore();
    const conn = fakeConn({ type: 'stuck_list', success: false, error: 'Unknown message type: stuck_list' });
    store.attach('srv', conn);
    conn.setState('connected');
    await Promise.resolve();
    await Promise.resolve();
    expect(store.supported('srv')).toBe(false);
  });

  it('hides optimistically until the daemon list drops the finding', () => {
    const store = new StuckStore();
    store.replace('srv', [fxFinding()]);
    store.hide(['out4|repeated_failure|abc']);
    expect(store.forSession('srv', 'out4')).toEqual([]);
    store.replace('srv', [fxFinding()]);
    expect(store.forSession('srv', 'out4')).toEqual([]);
    store.replace('srv', []);
    store.replace('srv', [fxFinding()]);
    expect(store.forSession('srv', 'out4')).toHaveLength(1);
  });
});
