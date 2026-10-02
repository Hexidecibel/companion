import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EditSummaryRow, summarizeEdits } from '../EditSummaryRow';
import { hiddenEditRows } from '../editRows';
import { ReviewProvider } from '../ReviewContext';
import { reviewStore } from '../../../services/reviewStore';
import { fxEdits, fxSummary } from '../__fixtures__/reviewFixtures';
import type { ReviewRequestFn } from '../../../services/reviewApi';
import type { ReviewGetEditsRequest } from '../../../types/review';
import type { ConversationHighlight } from '../../../types';

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

const tool = (id: string, name: string, status: 'completed' | 'pending' = 'completed') =>
  ({ id, name, input: {}, status }) as unknown as NonNullable<ConversationHighlight['toolCalls']>[number];
const msg = (id: string, type: 'user' | 'assistant', content: string, tools?: ReturnType<typeof tool>[]) =>
  ({ id, type, content, timestamp: 0, toolCalls: tools }) as unknown as ConversationHighlight;

describe('hiddenEditRows', () => {
  it('groups edit tools under the assistant message that made them', () => {
    const rows = hiddenEditRows([
      msg('u1', 'user', 'go'),
      msg('a1', 'assistant', 'Fixing it.', [tool('e1', 'Edit'), tool('b1', 'Bash')]),
      msg('a2', 'assistant', '', [tool('e2', 'Write'), tool('e3', 'MultiEdit'), tool('e4', 'Edit', 'pending')]),
      msg('u2', 'user', 'more'),
      msg('a3', 'assistant', '', [tool('e5', 'NotebookEdit')]),
    ]);
    expect(rows.get('a1')).toEqual(['e1', 'e2', 'e3']);
    expect(rows.has('a2')).toBe(false);
    expect(rows.get('a3')).toEqual(['e5']);
  });
});

describe('summarizeEdits', () => {
  it('counts distinct files, totals, unreviewed and max risk', () => {
    const s = summarizeEdits(fxEdits, 0)!;
    expect(s.files).toBe(new Set(fxEdits.map((e) => e.absPath)).size);
    expect(s.additions).toBe(fxEdits.reduce((n, e) => n + e.additions, 0));
    expect(s.unreviewed).toBe(true);
    expect(s.level).toBe('high');
    expect(summarizeEdits([], 0)).toBeNull();
    expect(summarizeEdits(fxEdits.slice(0, 1), Number.MAX_SAFE_INTEGER)!.unreviewed).toBe(false);
  });
});

describe('EditSummaryRow', () => {
  it('fetches all ids in one batch, shows "N files changed", expands to per-file chips', async () => {
    reviewStore.replaceAll('srv-sum', [fxSummary()]);
    const { calls, request } = mockRequest();
    render(
      <ReviewProvider serverId="srv-sum" sessionId="sess-1" request={request}>
        <EditSummaryRow toolIds={['toolu_01', 'toolu_02', 'toolu_bogus']} />
      </ReviewProvider>,
    );
    await screen.findByText('2 files changed');
    expect(calls).toHaveLength(1);
    expect(calls[0].editIds).toEqual(['toolu_01', 'toolu_02', 'toolu_bogus']);
    expect(screen.getByText('+13')).toBeInTheDocument();
    expect(screen.queryByText('echoGuard.ts')).toBeNull();
    fireEvent.click(screen.getByText('2 files changed'));
    expect(screen.getByText('echoGuard.ts')).toBeInTheDocument();
    expect(screen.getByText('echoGuard.test.ts')).toBeInTheDocument();
    fireEvent.click(screen.getByText('echoGuard.ts'));
    expect(await screen.findByText(/@@ -40,8 \+40,10 @@/)).toBeInTheDocument();
  });

  it('renders nothing when none of the ids are reviewable edits', async () => {
    reviewStore.replaceAll('srv-sum2', [fxSummary()]);
    const { calls, request } = mockRequest();
    const { container } = render(
      <ReviewProvider serverId="srv-sum2" sessionId="sess-1" request={request}>
        <EditSummaryRow toolIds={['nope']} />
      </ReviewProvider>,
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await vi.waitFor(() => expect(container.querySelector('.rv-chip-slot')).toBeNull());
    expect(container.textContent).toBe('');
  });
});
