import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HeraldBrainBadge, HeraldUsageMeter, cacheHitRate, formatUsd, usageLine } from '../HeraldUsage';
import { heraldReducer, initialHeraldClientState } from '../../../services/heraldReducer';
import type { HeraldUsageBucket, HeraldUsageSummary } from '../../../types/herald';

function bucket(over: Partial<HeraldUsageBucket> = {}): HeraldUsageBucket {
  return { turns: 0, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, ...over };
}

function usage(over: Partial<HeraldUsageSummary> = {}): HeraldUsageSummary {
  return {
    model: 'claude-haiku-4-5',
    priced: true,
    today: bucket({ turns: 3, costUsd: 0.04 }),
    month: bucket({ turns: 120, requests: 140, costUsd: 1.1, inputTokens: 60_000, cacheReadTokens: 540_000, cacheWriteTokens: 0 }),
    monthKey: '2026-09',
    budgetUsd: null,
    overBudget: false,
    resetsAt: new Date(2026, 9, 1).getTime(),
    ...over,
  };
}

describe('Herald usage meter', () => {
  it('formats the menu line and the cache hit rate', () => {
    expect(usageLine(usage())).toBe('Today $0.04 · Month $1.10');
    expect(formatUsd(0.0042)).toBe('$0.004');
    expect(cacheHitRate(usage().month)).toBeCloseTo(0.9, 5);
    expect(cacheHitRate(bucket())).toBeNull();
    expect(usageLine(usage({ priced: false }))).toBe('This month: 120 turns');
  });

  it('opens details: turns, average per turn, cache hit rate', () => {
    render(<HeraldUsageMeter usage={usage()} onBudget={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Today \$0\.04/ }));
    expect(screen.getByText('120 (140 calls)')).toBeTruthy();
    expect(screen.getByText('$0.009')).toBeTruthy();
    expect(screen.getByText('90%')).toBeTruthy();
    expect(screen.getByText('No monthly budget.')).toBeTruthy();
  });

  it('sets, shows and removes a budget', async () => {
    const onBudget = vi.fn(async () => null);
    const { rerender } = render(<HeraldUsageMeter usage={usage()} onBudget={onBudget} />);
    fireEvent.click(screen.getByRole('button', { name: /Today/ }));
    fireEvent.change(screen.getByLabelText('Monthly budget in dollars'), { target: { value: '$5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    await waitFor(() => expect(onBudget).toHaveBeenCalledWith(5));
    rerender(<HeraldUsageMeter usage={usage({ budgetUsd: 1.25, budgetSource: 'app' })} onBudget={onBudget} />);
    expect(screen.getByText('88% of $1.25')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(onBudget).toHaveBeenCalledWith(null));
    fireEvent.click(screen.getByRole('button', { name: "Use the server's setting" }));
    await waitFor(() => expect(onBudget).toHaveBeenCalledWith(undefined));
  });

  it('rejects a bad amount without calling the hub', () => {
    const onBudget = vi.fn(async () => null);
    render(<HeraldUsageMeter usage={usage()} onBudget={onBudget} />);
    fireEvent.click(screen.getByRole('button', { name: /Today/ }));
    fireEvent.change(screen.getByLabelText('Monthly budget in dollars'), { target: { value: 'lots' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    expect(onBudget).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/dollar amount/);
  });

  it('over budget: says so', () => {
    render(<HeraldUsageMeter usage={usage({ budgetUsd: 1, overBudget: true })} onBudget={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Today/ }));
    expect(screen.getByText(/Budget of \$1\.00 reached: answering without the AI until/)).toBeTruthy();
  });

  it('degraded brain badge', () => {
    const { container, rerender } = render(<HeraldBrainBadge brain={{ state: 'ok' }} />);
    expect(container.textContent).toBe('');
    rerender(<HeraldBrainBadge brain={{ state: 'degraded', reason: 'credit', detail: 'out of API credit', retryAt: 1 }} />);
    expect(screen.getByRole('status').textContent).toBe('Offline: out of credit');
  });

  it('reducer applies usage and brain events', () => {
    let st = heraldReducer(initialHeraldClientState, {
      type: 'event',
      event: { kind: 'state', state: { displayName: 'Herald', enabled: true, model: 'm', busy: false, messages: [], inbox: [], actions: [] } },
      receivedAt: 1,
    });
    st = heraldReducer(st, { type: 'event', event: { kind: 'usage', usage: usage() }, receivedAt: 2 });
    st = heraldReducer(st, { type: 'event', event: { kind: 'brain', brain: { state: 'degraded', reason: 'budget' } }, receivedAt: 3 });
    expect(st.server?.usage?.month.turns).toBe(120);
    expect(st.server?.brain?.reason).toBe('budget');
  });
});
