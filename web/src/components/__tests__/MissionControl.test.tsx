import { render, screen, fireEvent, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerSummary, SessionSummary } from '../../types';

vi.mock('../../services/ConnectionManager', () => ({
  connectionManager: { getConnection: () => null },
}));
vi.mock('../babysit/BabysitBadge', () => ({ BabysitBadge: () => null }));
vi.mock('../../hooks/useStuck', () => ({ useStuckFindings: () => [] }));
vi.mock('../stuck/StuckBadge', () => ({ StuckBadge: () => null }));

import { MissionControl } from '../mission/MissionControl';
import { NeedsYouChip } from '../mission/NeedsYouChip';
import { MISSION_ORDER_KEY, resetMissionOrderCache } from '../../services/missionOrder';
import { resetLastViewedCache } from '../../services/lastViewed';

const NOW = Date.now();
const s = (id: string, p: Partial<SessionSummary> = {}): SessionSummary => ({
  id, name: id, projectPath: `/p/${id}`, status: 'idle', lastActivity: NOW - 60_000, ...p,
});
const summary = (serverId: string, sessions: SessionSummary[]): ServerSummary =>
  ({ serverId, sessions } as unknown as ServerSummary);

function names() {
  return screen.getAllByTestId('mission-tile').map((el) => el.querySelector('.mission-tile__name')?.textContent);
}

describe('MissionControl', () => {
  beforeEach(() => {
    localStorage.clear();
    resetMissionOrderCache();
    resetLastViewedCache();
  });

  it('orders new sessions by recent activity, then keeps that order', () => {
    const sums = new Map([['a', summary('a', [
      s('old', { lastActivity: NOW - 10 * 60_000 }),
      s('new', { lastActivity: NOW - 1000 }),
    ])]]);
    const { rerender } = render(<MissionControl summaries={sums} serverNames={new Map()} onOpenSession={() => {}} />);
    expect(names()).toEqual(['new', 'old']);
    // "old" becomes the most active: the order does not shuffle.
    const next = new Map([['a', summary('a', [
      s('old', { lastActivity: NOW }),
      s('new', { lastActivity: NOW - 1000 }),
    ])]]);
    rerender(<MissionControl summaries={next} serverNames={new Map()} onOpenSession={() => {}} />);
    expect(names()).toEqual(['new', 'old']);
    expect(JSON.parse(localStorage.getItem(MISSION_ORDER_KEY) || '[]')).toHaveLength(2);
  });

  it('move down from the tile menu reorders and persists', () => {
    const sums = new Map([['a', summary('a', [s('x', { lastActivity: NOW }), s('y')])]]);
    render(<MissionControl summaries={sums} serverNames={new Map()} onOpenSession={() => {}} />);
    fireEvent.contextMenu(screen.getAllByTestId('mission-tile')[0]);
    fireEvent.click(screen.getByText('Move down'));
    expect(names()).toEqual(['y', 'x']);
  });

  it('server labels only with two or more servers', () => {
    const one = new Map([['a', summary('a', [s('x')])]]);
    const { rerender } = render(<MissionControl summaries={one} serverNames={new Map([['a', 'hexi'], ['b', 'mac']])} onOpenSession={() => {}} />);
    expect(screen.queryByText('hexi')).toBeNull();
    const two = new Map([['a', summary('a', [s('x')])], ['b', summary('b', [s('y')])]]);
    rerender(<MissionControl summaries={two} serverNames={new Map([['a', 'hexi'], ['b', 'mac']])} onOpenSession={() => {}} />);
    expect(screen.getByText('hexi')).toBeTruthy();
    expect(screen.getByText('mac')).toBeTruthy();
  });

  it('"Needs you" strip counts waiting sessions and highlights the next one', () => {
    const sums = new Map([['a', summary('a', [
      s('w1', { status: 'waiting', waitingSince: NOW - 5000 }),
      s('busy', { status: 'working' }),
      s('w2', { status: 'waiting', waitingSince: NOW - 9000 }),
    ])]]);
    const { container } = render(<MissionControl summaries={sums} serverNames={new Map()} onOpenSession={() => {}} />);
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('w2, w1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /2 need you/ }));
    expect(container.querySelector('.mission-tile--highlight')?.getAttribute('data-session-key')).toBe('a:w2');
  });

  it('no strip when nothing waits; empty state when no sessions', () => {
    const { rerender } = render(<MissionControl summaries={new Map([['a', summary('a', [s('x')])]])} serverNames={new Map()} onOpenSession={() => {}} />);
    expect(screen.queryByRole('button', { name: /need/ })).toBeNull();
    rerender(<MissionControl summaries={new Map()} serverNames={new Map()} onOpenSession={() => {}} />);
    expect(screen.getByText(/No sessions yet/)).toBeTruthy();
  });

  it('tapping a tile opens it', () => {
    const onOpen = vi.fn();
    render(<MissionControl summaries={new Map([['a', summary('a', [s('x', { status: 'waiting' })])]])} serverNames={new Map()} onOpenSession={onOpen} />);
    fireEvent.click(screen.getByTestId('mission-tile'));
    expect(onOpen).toHaveBeenCalledWith('a', 'x', true);
  });
});

describe('NeedsYouChip', () => {
  const sums = new Map([
    ['a', summary('a', [
      s('cur', { status: 'waiting', waitingSince: NOW - 99_000 }),
      s('w1', { status: 'waiting', waitingSince: NOW - 3 * 60_000 }),
    ])],
    ['b', summary('b', [s('w2', { status: 'waiting', waitingSince: NOW - 10 * 60_000 })])],
  ]);

  it('hides when nothing else waits', () => {
    const only = new Map([['a', summary('a', [s('cur', { status: 'waiting' })])]]);
    const { container } = render(<NeedsYouChip summaries={only} current={{ serverId: 'a', sessionId: 'cur' }} onJump={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('counts across servers, skips the current one, tap jumps to the oldest', () => {
    const onJump = vi.fn();
    render(<NeedsYouChip summaries={sums} current={{ serverId: 'a', sessionId: 'cur' }} onJump={onJump} now={NOW} />);
    expect(screen.getByText('2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /2 need you/ }));
    expect(onJump).toHaveBeenCalledWith('b', 'w2');
  });

  it('long-press lists them; picking one jumps there', () => {
    vi.useFakeTimers();
    try {
      const onJump = vi.fn();
      render(<NeedsYouChip summaries={sums} current={{ serverId: 'a', sessionId: 'cur' }} onJump={onJump} now={NOW} />);
      const chip = screen.getByRole('button', { name: /2 need you/ });
      fireEvent.touchStart(chip);
      act(() => { vi.advanceTimersByTime(600); });
      fireEvent.touchEnd(chip);
      fireEvent.click(chip); // the click after a long press does not jump
      expect(onJump).not.toHaveBeenCalled();
      const items = screen.getAllByRole('menuitem');
      expect(items.map((i) => i.textContent)).toEqual(['w210m', 'w13m']);
      fireEvent.click(items[1]);
      expect(onJump).toHaveBeenCalledWith('a', 'w1');
      expect(screen.queryByRole('menu')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
