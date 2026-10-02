import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RevertDialog } from '../RevertDialog';
import { HOLD_MS } from '../../common/HoldToConfirm';
import type { ReviewRequestFn } from '../../../services/reviewApi';
import type { ReviewRevertPreviewResponse, ReviewRevertTarget } from '../../../types/review';

const target: ReviewRevertTarget = { kind: 'hunk', absPath: '/p/a.ts', hunkId: 'h1', scope: 'since_checkpoint' };

function preview(over: Partial<ReviewRevertPreviewResponse> = {}): ReviewRevertPreviewResponse {
  return {
    token: 'tok', tier: 'echo', reasons: [], blocked: null, effect: 'patch',
    patch: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-new\n+old\n', additions: 1, deletions: 1,
    expiresAt: Date.now() + 120_000, ...over,
  };
}

function setup(p: ReviewRevertPreviewResponse) {
  const sent: Array<{ type: string; payload: unknown }> = [];
  const request = vi.fn(async (type: string, payload: unknown) => {
    sent.push({ type, payload });
    if (type === 'review_revert_preview') return p;
    if (type === 'review_revert') return { backupId: 'b1', absPath: '/p/a.ts', effect: 'patch', undoUntil: Date.now() + 600_000, summary: {} };
    throw new Error(type);
  }) as unknown as ReviewRequestFn;
  const onDone = vi.fn();
  render(<RevertDialog sessionId="s" target={target} path="a.ts" request={request} device="Desktop" onClose={() => {}} onDone={onDone} />);
  return { sent, onDone };
}

describe('RevertDialog', () => {
  afterEach(() => vi.useRealTimers());

  it('echo tier: one tap reverts with confirm "tap" and Tell Claude on by default', async () => {
    const { sent, onDone } = setup(preview());
    const btn = await screen.findByRole('button', { name: /^Revert$/ });
    expect(screen.queryByText('Hold to revert')).toBeNull();
    await act(async () => { fireEvent.click(btn); });
    const rev = sent.find((s) => s.type === 'review_revert')!;
    expect(rev.payload).toEqual({ token: 'tok', confirm: 'tap', notifySession: true, device: 'Desktop' });
    expect(onDone).toHaveBeenCalled();
  });

  it('hard_confirm tier: needs a press-and-hold, sends confirm "hold"', async () => {
    const { sent, onDone } = setup(preview({ tier: 'hard_confirm', reasons: ['Deletes the file'], effect: 'delete' }));
    const hold = await screen.findByLabelText(/Press and hold to revert/);
    expect(screen.queryByRole('button', { name: /^Revert$/ })).toBeNull();
    expect(screen.getByText('Deletes the file')).toBeInTheDocument();
    vi.useFakeTimers();
    fireEvent.click(hold);
    expect(sent.some((s) => s.type === 'review_revert')).toBe(false);
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
    await act(async () => { vi.advanceTimersByTime(HOLD_MS + 20); });
    vi.useRealTimers();
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(sent.find((s) => s.type === 'review_revert')!.payload).toMatchObject({ confirm: 'hold' });
  });

  it('blocked previews explain and offer no confirm', async () => {
    setup(preview({ token: null, blocked: { code: 'conflict', message: 'The file changed after this edit.' } }));
    expect(await screen.findByText('The file changed after this edit.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Revert$/ })).toBeNull();
    expect(screen.queryByLabelText(/Press and hold/)).toBeNull();
  });

  it('unticking Tell Claude sends notifySession false', async () => {
    const { sent } = setup(preview());
    const box = await screen.findByRole('checkbox');
    fireEvent.click(box);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Revert$/ })); });
    expect(sent.find((s) => s.type === 'review_revert')!.payload).toMatchObject({ notifySession: false });
  });
});
