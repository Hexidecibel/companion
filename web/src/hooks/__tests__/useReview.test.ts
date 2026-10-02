import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReview, REVIEW_REFETCH_DEBOUNCE_MS, type UseReviewOptions } from '../useReview';
import { fxGet } from '../../components/review/__fixtures__/reviewFixtures';
import type { ReviewRequestFn } from '../../services/reviewApi';

function deferredRequest() {
  const calls: Array<{ type: string; payload: unknown; resolve: (v: unknown) => void }> = [];
  const request = (<T,>(type: string, payload: unknown) =>
    new Promise<T>((resolve) => { calls.push({ type, payload, resolve: resolve as (v: unknown) => void }); })) as ReviewRequestFn;
  return { calls, request };
}

const base = (request: ReviewRequestFn, over: Partial<UseReviewOptions> = {}): UseReviewOptions => ({
  serverId: 'srv', sessionId: 'sess-1', scope: 'since_checkpoint', view: 'turns', open: true, version: 1, request, ...over,
});

describe('useReview', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does nothing while closed', () => {
    const { calls, request } = deferredRequest();
    renderHook((p: UseReviewOptions) => useReview(p), { initialProps: base(request, { open: false }) });
    expect(calls).toHaveLength(0);
  });

  it('debounces version bumps to one request after 500 ms', async () => {
    const { calls, request } = deferredRequest();
    const { rerender, result } = renderHook((p: UseReviewOptions) => useReview(p), { initialProps: base(request) });
    expect(calls).toHaveLength(1);
    await act(async () => { calls[0].resolve(fxGet('turns')); });
    expect(result.current.data?.turns).toHaveLength(2);

    for (let v = 2; v <= 6; v++) {
      rerender(base(request, { version: v }));
      act(() => { vi.advanceTimersByTime(100); });
    }
    expect(calls).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(REVIEW_REFETCH_DEBOUNCE_MS); });
    expect(calls).toHaveLength(2);
  });

  it('keeps a single request in flight and collapses the rest into one trailing request', async () => {
    const { calls, request } = deferredRequest();
    const { rerender } = renderHook((p: UseReviewOptions) => useReview(p), { initialProps: base(request) });
    expect(calls).toHaveLength(1);
    // Three bumps, each past the debounce, while the first request hangs.
    for (let v = 2; v <= 4; v++) {
      rerender(base(request, { version: v }));
      act(() => { vi.advanceTimersByTime(REVIEW_REFETCH_DEBOUNCE_MS + 10); });
    }
    expect(calls).toHaveLength(1);
    await act(async () => { calls[0].resolve(fxGet('turns')); });
    expect(calls).toHaveLength(2);
    await act(async () => { calls[1].resolve(fxGet('turns')); });
    expect(calls).toHaveLength(2);
  });

  it('refetches immediately on a view switch and ignores the stale answer', async () => {
    const { calls, request } = deferredRequest();
    const { rerender, result } = renderHook((p: UseReviewOptions) => useReview(p), { initialProps: base(request) });
    rerender(base(request, { view: 'files' }));
    // First (turns) still in flight: the files request trails it.
    await act(async () => { calls[0].resolve(fxGet('turns')); });
    expect(result.current.data).toBeNull();
    expect(calls).toHaveLength(2);
    expect((calls[1].payload as { view: string }).view).toBe('files');
    await act(async () => { calls[1].resolve(fxGet('files')); });
    expect(result.current.data?.view).toBe('files');
  });
});
