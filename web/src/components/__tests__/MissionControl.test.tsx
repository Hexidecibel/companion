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
      s('old', { status: 'working', lastActivity: NOW - 10 * 60_000 }),
      s('new', { status: 'working', lastActivity: NOW - 1000 }),
    ])]]);
    const { rerender } = render(<MissionControl summaries={sums} serverNames={new Map()} onOpenSession={() => {}} />);
    expect(names()).toEqual(['new', 'old']);
    // "old" becomes the most active: the order does not shuffle.
    const next = new Map([['a', summary('a', [
      s('old', { status: 'working', lastActivity: NOW }),
      s('new', { status: 'working', lastActivity: NOW - 1000 }),
    ])]]);
    rerender(<MissionControl summaries={next} serverNames={new Map()} onOpenSession={() => {}} />);
    expect(names()).toEqual(['new', 'old']);
    expect(JSON.parse(localStorage.getItem(MISSION_ORDER_KEY) || '[]')).toHaveLength(2);
  });

  it('move down from the tile menu reorders and persists', () => {
    const sums = new Map([['a', summary('a', [s('x', { status: 'working', lastActivity: NOW }), s('y', { status: 'working' })])]]);
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

describe('MissionControl sections', () => {
  beforeEach(() => {
    localStorage.clear();
    resetMissionOrderCache();
    resetLastViewedCache();
  });
  const quietNames = () =>
    screen.queryAllByTestId('mission-quiet').map((el) => el.querySelector('.mission-quiet__name')?.textContent);

  it('full tiles for needs you / working / unseen done; idle and seen done go to Quiet', () => {
    // lastViewed baseline = first use (now): activity after it is unseen.
    const later = Date.now() + 60_000;
    const sums = new Map([['a', summary('a', [
      s('ask', { status: 'waiting', attention: 'needs_you', lastActivity: later }),
      s('idle1'),
      s('busy', { status: 'working', lastActivity: later - 1 }),
      s('fresh', { status: 'waiting', attention: 'done', lastActivity: later - 2 }),
      s('seen', { status: 'waiting', attention: 'done', lastActivity: NOW - 120_000 }),
    ])]]);
    render(<MissionControl summaries={sums} serverNames={new Map()} onOpenSession={() => {}} />);
    expect(names()).toEqual(['ask', 'busy', 'fresh']);
    expect(quietNames()).toEqual(['idle1', 'seen']);
    // Only the one that needs the user counts in the strip.
    expect(screen.getByRole('button', { name: /1 need you/ })).toBeTruthy();
  });

  it('a session changes section only when its state changes; order inside a section holds', () => {
    const sums = (busy: boolean) => new Map([['a', summary('a', [
      s('x', { lastActivity: NOW - 1000 }),
      s('y', { status: busy ? 'working' : 'idle', lastActivity: NOW - 2000 }),
      s('z', { lastActivity: NOW - 3000 }),
    ])]]);
    const { rerender } = render(<MissionControl summaries={sums(false)} serverNames={new Map()} onOpenSession={() => {}} />);
    expect(quietNames()).toEqual(['x', 'y', 'z']);
    rerender(<MissionControl summaries={sums(true)} serverNames={new Map()} onOpenSession={() => {}} />);
    expect(names()).toEqual(['y']);
    expect(quietNames()).toEqual(['x', 'z']);
    rerender(<MissionControl summaries={sums(false)} serverNames={new Map()} onOpenSession={() => {}} />);
    expect(quietNames()).toEqual(['x', 'y', 'z']);
  });

  it('long-press move works inside Quiet (skips tiles in the other section)', () => {
    const sums = new Map([['a', summary('a', [
      s('q1', { lastActivity: NOW - 1000 }),
      s('w', { status: 'working', lastActivity: NOW - 2000 }),
      s('q2', { lastActivity: NOW - 3000 }),
    ])]]);
    render(<MissionControl summaries={sums} serverNames={new Map()} onOpenSession={() => {}} />);
    expect(quietNames()).toEqual(['q1', 'q2']);
    fireEvent.contextMenu(screen.getAllByTestId('mission-quiet')[0]);
    fireEvent.click(screen.getByText('Move down'));
    expect(quietNames()).toEqual(['q2', 'q1']);
    expect(names()).toEqual(['w']);
  });

  it('tapping a quiet row opens the session', () => {
    const onOpen = vi.fn();
    render(<MissionControl summaries={new Map([['a', summary('a', [s('x')])]])} serverNames={new Map()} onOpenSession={onOpen} />);
    fireEvent.click(screen.getByTestId('mission-quiet'));
    expect(onOpen).toHaveBeenCalledWith('a', 'x', false);
  });

  it('older daemon (no attention): waiting is a needs-you tile', () => {
    render(<MissionControl summaries={new Map([['a', summary('a', [s('w', { status: 'waiting' })])]])} serverNames={new Map()} onOpenSession={() => {}} />);
    expect(names()).toEqual(['w']);
    expect(screen.getByRole('button', { name: /1 need you/ })).toBeTruthy();
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

  it('does not count sessions that are just done', () => {
    const m = new Map([['a', summary('a', [s('d', { status: 'waiting', attention: 'done' })])]]);
    const { container } = render(<NeedsYouChip summaries={m} current={null} onJump={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

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
