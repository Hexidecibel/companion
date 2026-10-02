import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EditChip } from '../EditChip';
import { ReviewProvider } from '../ReviewContext';
import { ReviewEditCache, EDIT_BATCH_WINDOW_MS } from '../../../services/reviewEditCache';
import { reviewStore } from '../../../services/reviewStore';
import { fxEdits, fxSummary } from '../__fixtures__/reviewFixtures';
import type { ReviewRequestFn } from '../../../services/reviewApi';
import type { ReviewGetEditsRequest } from '../../../types/review';

function mockRequest() {
  const calls: ReviewGetEditsRequest[] = [];
  const request = vi.fn(async (type: string, payload: unknown) => {
    if (type !== 'review_get_edits') throw new Error(type);
    const p = payload as ReviewGetEditsRequest;
    calls.push(p);
    return { edits: fxEdits.filter((e) => p.editIds.includes(e.id)), missing: p.editIds.filter((id) => !fxEdits.some((e) => e.id === id)) };
  }) as unknown as ReviewRequestFn;
  return { calls, request };
}

describe('ReviewEditCache', () => {
  it('batches asks in one window into one request', async () => {
    vi.useFakeTimers();
    const { calls, request } = mockRequest();
    const cache = new ReviewEditCache('sess-1', request);
    cache.want('toolu_01');
    cache.want('toolu_02');
    cache.want('toolu_01');
    cache.want('nope');
    expect(calls).toHaveLength(0);
    await act(async () => { vi.advanceTimersByTime(EDIT_BATCH_WINDOW_MS + 1); });
    vi.useRealTimers();
    await vi.waitFor(() => expect(cache.peek('toolu_01')?.id).toBe('toolu_01'));
    expect(calls).toHaveLength(1);
    expect(calls[0].editIds).toEqual(['toolu_01', 'toolu_02', 'nope']);
    expect(cache.peek('nope')).toBeNull();
    cache.want('toolu_01');
    cache.want('nope');
    await new Promise((r) => setTimeout(r, EDIT_BATCH_WINDOW_MS + 10));
    expect(calls).toHaveLength(1);
  });

  it('splits batches at REVIEW_LIMITS.maxGetEdits', async () => {
    const { calls, request } = mockRequest();
    const cache = new ReviewEditCache('sess-1', request);
    for (let i = 0; i < 120; i++) cache.want(`id${i}`);
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls.map((c) => c.editIds.length)).toEqual([50, 50, 20]);
  });
});

describe('EditChip', () => {
  it('fetches lazily and renders name, stats and the unreviewed dot; tap expands hunks', async () => {
    reviewStore.replaceAll('srv-chip', [fxSummary()]);
    const { calls, request } = mockRequest();
    render(
      <ReviewProvider serverId="srv-chip" sessionId="sess-1" request={request}>
        <EditChip toolId="toolu_01" />
        <EditChip toolId="toolu_03" />
        <EditChip toolId="toolu_bash" />
      </ReviewProvider>,
    );
    await screen.findByText('echoGuard.ts');
    expect(calls).toHaveLength(1);
    expect(screen.getByText('deploy.yml')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Not reviewed')).toHaveLength(2);
    expect(screen.getByLabelText('High risk')).toBeInTheDocument();
    fireEvent.click(screen.getByText('echoGuard.ts'));
    expect(await screen.findByText(/@@ -40,8 \+40,10 @@/)).toBeInTheDocument();
  });
});
