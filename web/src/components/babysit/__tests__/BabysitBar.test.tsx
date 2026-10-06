import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BabysitBar } from '../BabysitBar';
import { BabysitBadge } from '../BabysitBadge';
import { BabysitBriefDialog } from '../BabysitBriefDialog';
import { BabysitHeaderButton } from '../BabysitHeaderButton';
import {
  babysitForSession,
  babysitStatusLine,
  babysitStore,
  draftFor,
  endReasonText,
  formatTimeLeft,
  validateDraft,
  type BabysitApi,
  type BabysitSnapshot,
} from '../../../services/babysit';
import { HERALD_BABYSIT_LIMITS, type HeraldBabysit, type HeraldBabysitEndReason } from '../../../types/herald';

const NOW = 1_800_000_000_000;

const brief = (over: Partial<HeraldBabysit> = {}): HeraldBabysit => ({
  id: 'b1',
  serverId: 'local',
  sessionId: 'out4',
  sessionName: 'Out4',
  goal: 'Get this production ready',
  direction: 'Prefer the simplest fix',
  createdAt: NOW - 94 * 60_000,
  expiresAt: NOW + 26 * 60_000,
  maxAnswers: 20,
  answersUsed: 4,
  escalations: 1,
  status: 'active',
  log: [
    { at: NOW - 60 * 60_000, question: 'Tests pass. Continue with the docs?', answer: 'continue', kind: 'answered' },
    { at: NOW - 5 * 60_000, question: 'Drop the legacy endpoint?', answer: 'Keep it for now', kind: 'escalated', reason: 'The brief does not cover the legacy endpoint.' },
  ],
  ...over,
});

let api: { set: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };

function feed(over: Partial<BabysitSnapshot> = {}) {
  act(() => babysitStore.update(
    { hostId: 'hub', supported: true, connected: true, babysits: [brief()], skewMs: 0, ...over },
    api as unknown as BabysitApi,
  ));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  api = { set: vi.fn(async () => null), stop: vi.fn(async () => null) };
  feed();
});

afterEach(() => {
  act(() => babysitStore.reset());
  vi.useRealTimers();
});

describe('babysit helpers', () => {
  it('time left is corrected by the clock skew', () => {
    expect(babysitStatusLine(brief(), NOW, 0)).toBe('Babysitting: 4 answers, 26 min left');
    // This device runs 10 minutes ahead of the hub: the deadline is 10 minutes later here.
    expect(babysitStatusLine(brief(), NOW, 10 * 60_000)).toBe('Babysitting: 4 answers, 36 min left');
    expect(babysitStatusLine(brief({ answersUsed: 1 }), NOW, null)).toBe('Babysitting: 1 answer, 26 min left');
    expect(formatTimeLeft(125 * 60_000)).toBe('2 h 5 min left');
    expect(formatTimeLeft(120 * 60_000)).toBe('2 h left');
    expect(formatTimeLeft(20_000)).toBe('under a minute left');
    expect(formatTimeLeft(0)).toBe('under a minute left');
  });

  it('every end reason has plain words', () => {
    const want: Record<HeraldBabysitEndReason, string> = {
      stopped: 'stopped',
      expired: 'time limit reached',
      max_answers: 'answer limit reached',
      session_gone: 'session closed',
      done: 'goal finished',
      loop: 'stopped because the same question kept coming back',
    };
    for (const [reason, text] of Object.entries(want)) expect(endReasonText(reason as HeraldBabysitEndReason)).toBe(text);
    expect(endReasonText(undefined)).toBe('ended');
    expect(babysitStatusLine(brief({ status: 'ended', endReason: 'expired' }), NOW, 0)).toBe('Babysitting ended: time limit reached');
  });

  it('briefs only match sessions on the Herald hub; the active one wins over an ended one', () => {
    const ended = brief({ id: 'old', status: 'ended', endReason: 'done', endedAt: NOW - 1000 });
    const snap: BabysitSnapshot = { hostId: 'hub', supported: true, connected: true, babysits: [ended, brief()], skewMs: 0 };
    expect(babysitForSession(snap, 'hub', 'out4')?.id).toBe('b1');
    expect(babysitForSession({ ...snap, babysits: [ended] }, 'hub', 'out4')?.id).toBe('old');
    expect(babysitForSession(snap, 'other-server', 'out4')).toBeNull();
    expect(babysitForSession(snap, 'hub', 'elsewhere')).toBeNull();
    expect(babysitForSession({ ...snap, hostId: null }, 'hub', 'out4')).toBeNull();
    expect(babysitForSession({ ...snap, babysits: [brief({ serverId: 'remote-box' })] }, 'hub', 'out4')).toBeNull();
  });

  it('form defaults and bounds come from the shared limits', () => {
    const L = HERALD_BABYSIT_LIMITS;
    expect(draftFor(null)).toEqual({ goal: '', direction: '', never: '', minutes: L.defaultMinutes, maxAnswers: L.defaultMaxAnswers });
    expect(draftFor(brief())).toMatchObject({ goal: 'Get this production ready', direction: 'Prefer the simplest fix', never: '', minutes: 120, maxAnswers: 20 });
    // The configured limit wins over the span (an edit restarts the limit but keeps createdAt).
    expect(draftFor({ ...brief(), minutes: 45 }).minutes).toBe(45);
    expect(draftFor({ ...brief(), minutes: 45, expiresAt: brief().createdAt + 400 * 60_000 }).minutes).toBe(45);
    const ok = { goal: 'ship it', direction: '', never: '', minutes: 60, maxAnswers: 5 };
    expect(validateDraft(ok)).toBeNull();
    expect(validateDraft({ ...ok, goal: ' a ' })).toMatch(/get done/);
    expect(validateDraft({ ...ok, minutes: L.minMinutes - 1 })).toMatch(/Time limit/);
    expect(validateDraft({ ...ok, minutes: L.maxMinutes + 1 })).toMatch(/Time limit/);
    expect(validateDraft({ ...ok, minutes: NaN })).toMatch(/Time limit/);
    expect(validateDraft({ ...ok, maxAnswers: 0 })).toMatch(/Answer limit/);
    expect(validateDraft({ ...ok, maxAnswers: L.maxMaxAnswers + 1 })).toMatch(/Answer limit/);
    expect(validateDraft({ ...ok, never: 'x'.repeat(L.maxNeverChars + 1) })).toMatch(/never decide/);
  });
});

describe('BabysitBar', () => {
  it('shows answers used, time left and the goal; the log opens on demand', () => {
    render(<BabysitBar serverId="hub" sessionId="out4" onEdit={() => {}} />);
    expect(screen.getByText('Babysitting: 4 answers, 26 min left')).toBeTruthy();
    expect(screen.getByText('Get this production ready')).toBeTruthy();
    expect(screen.getByText(/up to 20, 1 brought to you/)).toBeTruthy();
    expect(screen.queryByText('Herald answered')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Log (2)' }));
    expect(screen.getByText('Herald answered')).toBeTruthy();
    expect(screen.getByText('Suggested answer')).toBeTruthy();
    expect(screen.getByText('Tests pass. Continue with the docs?')).toBeTruthy();
    expect(screen.getByText('Keep it for now')).toBeTruthy();
    expect(screen.getByText('The brief does not cover the legacy endpoint.')).toBeTruthy();
  });

  it('the time left counts down by itself and follows the skew', () => {
    feed({ skewMs: 4 * 60_000 });
    render(<BabysitBar serverId="hub" sessionId="out4" onEdit={() => {}} />);
    expect(screen.getByText('Babysitting: 4 answers, 30 min left')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(10 * 60_000); });
    expect(screen.getByText('Babysitting: 4 answers, 20 min left')).toBeTruthy();
  });

  it('renders nothing for a session on another server, another session, or an older hub', () => {
    const { container, rerender } = render(<BabysitBar serverId="other" sessionId="out4" onEdit={() => {}} />);
    expect(container.firstChild).toBeNull();
    rerender(<BabysitBar serverId="hub" sessionId="nope" onEdit={() => {}} />);
    expect(container.firstChild).toBeNull();
    feed({ supported: false });
    rerender(<BabysitBar serverId="hub" sessionId="out4" onEdit={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('Stop stops this brief by id; Edit opens the dialog', async () => {
    const onEdit = vi.fn();
    render(<BabysitBar serverId="hub" sessionId="out4" onEdit={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(api.stop).toHaveBeenCalledWith({ babysitId: 'b1' }));
    // The hub's event ends it: the bar now says why.
    feed({ babysits: [brief({ status: 'ended', endReason: 'stopped', endedAt: NOW })] });
    expect(screen.getByText('Babysitting ended: stopped')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('a failed stop says why and keeps the bar', async () => {
    api.stop.mockResolvedValueOnce('This device is not allowed to do that (it needs the dispatch permission)');
    render(<BabysitBar serverId="hub" sessionId="out4" onEdit={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/dispatch permission/);
    expect(screen.getByText('Babysitting: 4 answers, 26 min left')).toBeTruthy();
  });

  it('says so when this server only suggests', () => {
    feed({ babysits: [brief({ autoSend: false })] });
    render(<BabysitBar serverId="hub" sessionId="out4" onEdit={() => {}} />);
    expect(screen.getByText(/Suggesting only/)).toBeTruthy();
  });

  it('an ended brief shows its reason, can be hidden, and a new brief shows again', () => {
    feed({ babysits: [brief({ status: 'ended', endReason: 'loop', endedAt: NOW })] });
    const onEdit = vi.fn();
    const { container } = render(<BabysitBar serverId="hub" sessionId="out4" onEdit={onEdit} />);
    expect(screen.getByText('Babysitting ended: stopped because the same question kept coming back')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Babysit again' }));
    expect(onEdit).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Hide this notice' }));
    expect(container.firstChild).toBeNull();
    feed({ babysits: [brief({ id: 'b2', answersUsed: 0, log: [] })] });
    expect(screen.getByText('Babysitting: 0 answers, 26 min left')).toBeTruthy();
  });

  it('the open log does not carry over to another session', () => {
    feed({ babysits: [brief(), brief({ id: 'b9', sessionId: 'web', sessionName: 'Web' })] });
    const { rerender } = render(<BabysitBar serverId="hub" sessionId="out4" onEdit={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Log (2)' }));
    expect(screen.getByText('Herald answered')).toBeTruthy();
    rerender(<BabysitBar serverId="hub" sessionId="web" onEdit={() => {}} />);
    expect(screen.queryByText('Herald answered')).toBeNull();
    expect(screen.getByRole('button', { name: 'Log (2)' })).toBeTruthy();
  });
});

describe('BabysitBadge and header button', () => {
  it('the badge shows only while a brief is active, only on the hub', () => {
    const { container, rerender } = render(<BabysitBadge serverId="hub" sessionId="out4" />);
    expect(screen.getByText('Babysit')).toBeTruthy();
    rerender(<BabysitBadge serverId="other" sessionId="out4" />);
    expect(container.firstChild).toBeNull();
    feed({ babysits: [brief({ status: 'ended', endReason: 'done' })] });
    rerender(<BabysitBadge serverId="hub" sessionId="out4" />);
    expect(container.firstChild).toBeNull();
  });

  it('the header button offers Babysit, shows the count while active, and hides off the hub', () => {
    const onClick = vi.fn();
    const { container, rerender } = render(<BabysitHeaderButton serverId="hub" sessionId="idle" onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Babysit' }));
    expect(onClick).toHaveBeenCalled();
    rerender(<BabysitHeaderButton serverId="hub" sessionId="out4" onClick={onClick} />);
    expect(screen.getByRole('button').textContent).toBe('Babysitting4');
    rerender(<BabysitHeaderButton serverId="other" sessionId="out4" onClick={onClick} />);
    expect(container.firstChild).toBeNull();
    feed({ supported: false });
    rerender(<BabysitHeaderButton serverId="hub" sessionId="out4" onClick={onClick} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('BabysitBriefDialog', () => {
  it('starts a brief with the defaults and closes', async () => {
    feed({ babysits: [] });
    const onClose = vi.fn();
    render(<BabysitBriefDialog serverId="hub" sessionId="out4" sessionName="Out4" onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Babysit Out4' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start babysitting' }));
    expect(screen.getByRole('alert').textContent).toMatch(/get done/);
    expect(api.set).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Goal'), { target: { value: '  Get this production ready ' } });
    fireEvent.change(screen.getByLabelText(/Never decide/), { target: { value: 'deploys' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start babysitting' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.set).toHaveBeenCalledWith({
      sessionId: 'out4',
      serverId: 'local',
      goal: 'Get this production ready',
      never: 'deploys',
      minutes: HERALD_BABYSIT_LIMITS.defaultMinutes,
      maxAnswers: HERALD_BABYSIT_LIMITS.defaultMaxAnswers,
    });
  });

  it('editing is prefilled, a cleared field is dropped, and a hub error stays on screen', async () => {
    api.set.mockResolvedValueOnce('Already babysitting 8 sessions; stop one first.');
    const onClose = vi.fn();
    render(<BabysitBriefDialog serverId="hub" sessionId="out4" onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Babysitting Out4' })).toBeTruthy();
    expect((screen.getByLabelText('Goal') as HTMLTextAreaElement).value).toBe('Get this production ready');
    expect(screen.getByText(/Saving restarts the time limit/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Which way to lean/), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Answer limit'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Already babysitting 8/);
    expect(onClose).not.toHaveBeenCalled();
    expect(api.set).toHaveBeenCalledWith({ sessionId: 'out4', serverId: 'local', goal: 'Get this production ready', minutes: 120, maxAnswers: 8 });
  });

  it('Escape closes it', () => {
    const onClose = vi.fn();
    render(<BabysitBriefDialog serverId="hub" sessionId="out4" onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
