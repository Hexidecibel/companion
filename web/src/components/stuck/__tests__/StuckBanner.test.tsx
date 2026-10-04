import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StuckBanner } from '../StuckBanner';
import { StuckBadge } from '../StuckBadge';
import { ensureStuckStore, stuckStore, type StuckStoreConnection } from '../../../services/stuckStore';
import type { WebSocketResponse } from '../../../types';
import type { StuckFinding } from '../../../types/stuck';

const finding = (over: Partial<StuckFinding> = {}): StuckFinding => ({
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

let calls: Array<{ type: string; payload: unknown }>;

function attach() {
  calls = [];
  const conn: StuckStoreConnection = {
    isConnected: () => true,
    sendRequest: vi.fn(async (type: string, payload?: unknown): Promise<WebSocketResponse> => {
      calls.push({ type, payload });
      if (type === 'stuck_ask') return { type, success: true, payload: { via: 'herald', askId: 'a1', sentText: 'x' } };
      if (type === 'stuck_interrupt') return { type, success: true, payload: { actionId: 'act', autoSendAt: Date.now() + 5000 } };
      if (type === 'stuck_list') return { type, success: true, payload: { findings: [finding()] } };
      return { type, success: true, payload: { findings: [] } };
    }),
    onMessage: () => () => {},
    onStateChange: (h) => { h({ status: 'disconnected' }); return () => {}; },
  };
  ensureStuckStore();
  stuckStore.attach('srv', conn);
  stuckStore.unhide(['out4|repeated_failure|abc', 'out4|loop|x']);
  act(() => stuckStore.replace('srv', [finding(), finding({ id: 'out4|loop|x', kind: 'loop', summary: 'Read the same file 6 times in 3 min with no edits: watcher.ts' })]));
}

describe('StuckBanner', () => {
  beforeEach(() => attach());

  it('shows the summary, the evidence on demand, and the badge', () => {
    render(<><StuckBanner serverId="srv" sessionId="out4" /><StuckBadge serverId="srv" sessionId="out4" /></>);
    expect(screen.getByText('Same test failing 6 times in 18 min: api.test.ts › retries')).toBeTruthy();
    expect(screen.getByText('Stuck?')).toBeTruthy();
    expect(screen.queryByText('$ npm test 2>&1 | tail -40')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Evidence and 1 more/ }));
    expect(screen.getByText('$ npm test 2>&1 | tail -40')).toBeTruthy();
    expect(screen.getByText(/Read the same file 6 times/)).toBeTruthy();
  });

  it('"Not stuck" tells the daemon and hides the finding at once', async () => {
    render(<StuckBanner serverId="srv" sessionId="out4" />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Not stuck' })); });
    expect(calls).toContainEqual({ type: 'stuck_dismiss', payload: { findingId: 'out4|repeated_failure|abc' } });
    // The next finding takes its place.
    expect(screen.getByText(/Read the same file 6 times/)).toBeTruthy();
  });

  it('snooze 30m quiets the session; ask and interrupt go to the daemon', async () => {
    const { unmount } = render(<StuckBanner serverId="srv" sessionId="out4" />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: "Ask what's wrong" })); });
    expect(calls).toContainEqual({ type: 'stuck_ask', payload: { findingId: 'out4|repeated_failure|abc' } });
    expect(screen.getByText(/Herald will tell you what it says/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Interrupt' })); });
    expect(calls).toContainEqual({ type: 'stuck_interrupt', payload: { sessionId: 'out4' } });
    expect(screen.getByRole('button', { name: /Interrupting in \ds · Cancel/ })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Cancel/ })); });
    expect(calls).toContainEqual({ type: 'herald_confirm', payload: { actionId: 'act', decision: 'cancel' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Snooze 30m' })); });
    expect(calls).toContainEqual({ type: 'stuck_snooze', payload: { sessionId: 'out4', minutes: 30 } });
    expect(screen.queryByRole('status')).toBeNull();
    unmount();
  });

  it('closing hides it on this device until a different finding shows up', () => {
    render(<StuckBanner serverId="srv" sessionId="out4" />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide this notice' }));
    expect(screen.queryByRole('status')).toBeNull();
    act(() => stuckStore.replace('srv', [finding({ id: 'out4|stalled_tool|z', kind: 'stalled_tool', summary: 'Bash has been running 25 min with no screen change' })]));
    expect(screen.getByText(/Bash has been running 25 min/)).toBeTruthy();
  });
});
