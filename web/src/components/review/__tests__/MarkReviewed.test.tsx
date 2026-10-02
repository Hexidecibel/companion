/**
 * "I keep marking as reviewed but they just show on all of my sessions":
 * a mark must reach the daemon for the session it was made in, with a
 * `through` that covers what the device showed, even when the user moves on
 * inside the 5 s undo window.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeStrip } from '../ChangeStrip';
import { ReviewToasts } from '../ReviewToasts';
import { MARK_UNDO_MS, ReviewProvider } from '../ReviewContext';
import { shownThroughOf } from '../ReviewDrawer';
import { reviewStore } from '../../../services/reviewStore';
import { ReviewRequestError, type ReviewRequestFn } from '../../../services/reviewApi';
import { fxEdits, fxGet, fxSummary, T0 } from '../__fixtures__/reviewFixtures';
import type { ReviewSummary } from '../../../types/review';

let n = 0;
let calls: Array<{ type: string; payload: any }>;
let fail = false;
const request = (async (type: string, payload: unknown) => {
  calls.push({ type, payload });
  if (type === 'review_mark_reviewed') {
    if (fail) throw new ReviewRequestError('nope', 'unknown_session');
    return { checkpoint: {}, summary: null };
  }
  return fxGet('turns');
}) as unknown as ReviewRequestFn;

const marks = () => calls.filter((c) => c.type === 'review_mark_reviewed').map((c) => c.payload);

function tree(serverId: string, sessionId: string) {
  return (
    <ReviewProvider serverId={serverId} sessionId={sessionId} request={request}>
      <ChangeStrip />
      <ReviewToasts />
    </ReviewProvider>
  );
}

function setup(summaries: ReviewSummary[]) {
  const serverId = `mark-srv-${++n}`;
  reviewStore.replaceAll(serverId, summaries);
  const r = render(tree(serverId, summaries[0].sessionId));
  return { serverId, ...r };
}

describe('mark reviewed', () => {
  beforeEach(() => {
    calls = [];
    fail = false;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('switching sessions inside the undo window marks the ORIGINAL session', () => {
    const out4 = fxSummary({ sessionId: 'out4', lastChangeAt: T0 - 100_000, computedAt: T0 });
    const comp = fxSummary({ sessionId: 'companion', lastChangeAt: T0 - 5_000, computedAt: T0 + 50 });
    const { serverId, rerender } = setup([out4, comp]);
    fireEvent.click(screen.getByLabelText('Mark reviewed'));
    expect(marks()).toEqual([]);
    // Same provider instance, new session (the dashboard does not remount it).
    rerender(tree(serverId, 'companion'));
    expect(marks()).toEqual([{ sessionId: 'out4', through: T0, device: expect.any(String) }]);
    // The companion strip is not hidden by out4's pending mark.
    expect(screen.getByTestId('rv-strip')).toBeInTheDocument();
  });

  it('unmount commits the pending mark', () => {
    const { unmount } = setup([fxSummary({ computedAt: T0 })]);
    fireEvent.click(screen.getByLabelText('Mark reviewed'));
    unmount();
    expect(marks()).toEqual([expect.objectContaining({ sessionId: 'sess-1', through: T0 })]);
  });

  it('the page going to the background commits it', () => {
    setup([fxSummary({ computedAt: T0 })]);
    fireEvent.click(screen.getByLabelText('Mark reviewed'));
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(marks()).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(MARK_UNDO_MS + 10); });
    expect(marks()).toHaveLength(1);
  });

  it('undo inside the window sends nothing', () => {
    setup([fxSummary({ computedAt: T0 })]);
    fireEvent.click(screen.getByLabelText('Mark reviewed'));
    fireEvent.click(screen.getByText('Undo'));
    act(() => { vi.advanceTimersByTime(MARK_UNDO_MS + 10); });
    expect(marks()).toEqual([]);
    expect(screen.getByTestId('rv-strip')).toBeInTheDocument();
  });

  it('strip marks through the server computedAt, never short of lastChangeAt', () => {
    setup([fxSummary({ lastChangeAt: T0 - 60_000, computedAt: T0 })]);
    fireEvent.click(screen.getByLabelText('Mark reviewed'));
    act(() => { vi.advanceTimersByTime(MARK_UNDO_MS + 10); });
    expect(marks()[0].through).toBe(T0);
  });

  it('only unattributed changes: quiet strip, and the mark is still sent', () => {
    setup([fxSummary({
      unreviewedFiles: 0, unreviewedTurns: 0, unreviewedAdditions: 0, unreviewedDeletions: 0,
      unattributedFiles: 3, lastChangeAt: null, computedAt: T0,
    })]);
    const strip = screen.getByTestId('rv-strip');
    expect(strip).toHaveTextContent('3 other changes in the repo');
    expect(strip.className).toContain('rv-strip--none');
    fireEvent.click(screen.getByLabelText('Mark reviewed'));
    act(() => { vi.advanceTimersByTime(MARK_UNDO_MS + 10); });
    expect(marks()).toEqual([expect.objectContaining({ through: T0 })]);
  });

  it('a failed mark is reported, not swallowed', async () => {
    fail = true;
    setup([fxSummary({ computedAt: T0 })]);
    fireEvent.click(screen.getByLabelText('Mark reviewed'));
    await act(async () => { vi.advanceTimersByTime(MARK_UNDO_MS + 10); });
    expect(screen.getByText(/Could not mark reviewed/)).toBeInTheDocument();
  });
});

describe('shownThroughOf (drawer "Mark all reviewed")', () => {
  it('covers computedAt even when the newest shown edit is older', () => {
    const done = fxEdits.filter((e) => !e.pending);
    expect(shownThroughOf({ edits: done, computedAt: T0 + 5_000, summary: fxSummary({ lastChangeAt: T0 - 1 }) })).toBe(T0 + 5_000);
    // Files view (no edits) / nothing claimed: still computedAt.
    expect(shownThroughOf({ edits: [], computedAt: T0, summary: fxSummary({ lastChangeAt: null }) })).toBe(T0);
  });

  it('stops short of an edit still in flight', () => {
    const pending = { ...fxEdits[0], id: 'p', pending: true, at: T0 - 10 };
    expect(shownThroughOf({ edits: [pending], computedAt: T0, summary: fxSummary({ lastChangeAt: T0 - 20 }) })).toBe(T0 - 11);
  });
});
