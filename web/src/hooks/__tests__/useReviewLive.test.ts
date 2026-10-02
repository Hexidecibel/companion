import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { applyLiveEvent, useReviewLive, type LiveEventSource } from '../useReviewLive';
import { fxEdits } from '../../components/review/__fixtures__/reviewFixtures';
import type { WebSocketResponse } from '../../types';
import type { ReviewRequestFn } from '../../services/reviewApi';

describe('applyLiveEvent', () => {
  it('replaces an edit in place when its phase moves on', () => {
    let list = applyLiveEvent([], { sessionId: 's', phase: 'started', edit: { ...fxEdits[0], pending: true } });
    list = applyLiveEvent(list, { sessionId: 's', phase: 'started', edit: fxEdits[1] });
    list = applyLiveEvent(list, { sessionId: 's', phase: 'completed', edit: fxEdits[0] });
    expect(list.map((e) => [e.edit.id, e.phase])).toEqual([['toolu_02', 'started'], ['toolu_01', 'completed']]);
  });
});

describe('useReviewLive', () => {
  it('watches while on, filters by session, re-watches on reconnect, unwatches on off', async () => {
    const handlers = new Set<(m: WebSocketResponse) => void>();
    const reconnects = new Set<() => void>();
    const source: LiveEventSource = {
      onMessage: (h) => { handlers.add(h); return () => handlers.delete(h); },
      onReconnect: (h) => { reconnects.add(h); return () => reconnects.delete(h); },
    };
    const calls: unknown[] = [];
    const request = vi.fn(async (_t: string, p: unknown) => { calls.push(p); return {}; }) as unknown as ReviewRequestFn;
    const { result, rerender } = renderHook((p: { on: boolean }) => useReviewLive({ serverId: 'srv', sessionId: 's', on: p.on, request, source }), { initialProps: { on: true } });
    expect(calls).toEqual([{ sessionId: 's', live: true }]);
    act(() => {
      handlers.forEach((h) => h({ type: 'review_live', success: true, payload: { sessionId: 'other', phase: 'started', edit: fxEdits[0] } }));
      handlers.forEach((h) => h({ type: 'review_live', success: true, payload: { sessionId: 's', phase: 'started', edit: fxEdits[1] } }));
    });
    expect(result.current.entries).toHaveLength(1);
    act(() => { reconnects.forEach((h) => h()); });
    expect(calls).toHaveLength(2);
    rerender({ on: false });
    expect(calls[2]).toEqual({ sessionId: 's', live: false });
    expect(handlers.size).toBe(0);
  });
});
