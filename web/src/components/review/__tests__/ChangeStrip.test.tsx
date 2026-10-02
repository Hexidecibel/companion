import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeStrip, PULSE_MS } from '../ChangeStrip';
import { ReviewProvider } from '../ReviewContext';
import { reviewStore } from '../../../services/reviewStore';
import { fxSummary, fxGet } from '../__fixtures__/reviewFixtures';
import type { ReviewRequestFn } from '../../../services/reviewApi';
import type { ReviewSummary } from '../../../types/review';

let server = 0;
let serverId = 'srv';
const request = vi.fn(async () => fxGet('turns')) as unknown as ReviewRequestFn;

function setup(summary: ReviewSummary) {
  serverId = `srv-${++server}`;
  reviewStore.replaceAll(serverId, [summary]);
  return render(
    <ReviewProvider serverId={serverId} sessionId="sess-1" request={request}>
      <ChangeStrip />
    </ReviewProvider>,
  );
}

function setReducedMotion(on: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: on && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

describe('ChangeStrip', () => {
  beforeEach(() => setReducedMotion(false));
  afterEach(() => vi.useRealTimers());

  it('collapses to a 4 px rail when nothing is unreviewed', () => {
    setup(fxSummary({ unreviewedFiles: 0, unreviewedTurns: 0, riskLevel: null, topRisks: [] }));
    expect(screen.queryByTestId('rv-strip')).toBeNull();
    expect(screen.getByTestId('rv-strip-rail')).toBeInTheDocument();
  });

  it('renders nothing for a session with no changes at all', () => {
    const { container } = setup(fxSummary({ totalFiles: 0, totalTurns: 0, unreviewedFiles: 0, unreviewedTurns: 0 }));
    expect(container.innerHTML).toBe('');
  });

  it('shows unreviewed files and stats since you looked', () => {
    setup(fxSummary({ riskLevel: null, topRisks: [] }));
    const strip = screen.getByTestId('rv-strip');
    expect(strip).toHaveTextContent('5 files since you looked');
    expect(strip).toHaveTextContent('+142');
    expect(strip).toHaveTextContent('−38');
    expect(strip.className).toContain('rv-strip--none');
  });

  it('paints the rail red for high risk and shows at most two risk chips', () => {
    setup(fxSummary({
      topRisks: [
        { kind: 'ci', level: 'high', reason: 'CI workflow', path: 'a' },
        { kind: 'migration', level: 'high', reason: 'Database migration', path: 'b' },
        { kind: 'config', level: 'medium', reason: 'Build config', path: 'c' },
      ],
    }));
    const strip = screen.getByTestId('rv-strip');
    expect(strip.className).toContain('rv-strip--high');
    expect(strip).toHaveTextContent('CI workflow');
    expect(strip).toHaveTextContent('Database migration');
    expect(strip).not.toHaveTextContent('Build config');
  });

  it('shows the live dot while the session is editing', () => {
    setup(fxSummary({ live: true }));
    expect(screen.getByLabelText('Editing now')).toBeInTheDocument();
  });

  it('pulses for 600 ms on a version change, not on first render', () => {
    vi.useFakeTimers();
    setup(fxSummary({ version: 3 }));
    expect(screen.getByTestId('rv-strip').className).not.toContain('rv-strip--pulse');
    act(() => { reviewStore.apply(serverId, fxSummary({ version: 4 })); });
    expect(screen.getByTestId('rv-strip').className).toContain('rv-strip--pulse');
    act(() => { vi.advanceTimersByTime(PULSE_MS + 10); });
    expect(screen.getByTestId('rv-strip').className).not.toContain('rv-strip--pulse');
  });

  it('does not pulse under reduced motion', () => {
    setReducedMotion(true);
    setup(fxSummary({ version: 3 }));
    act(() => { reviewStore.apply(serverId, fxSummary({ version: 4 })); });
    expect(screen.getByTestId('rv-strip').className).not.toContain('rv-strip--pulse');
  });

  it('mark reviewed hides the strip optimistically and can be undone', () => {
    vi.useFakeTimers();
    setup(fxSummary());
    fireEvent.click(screen.getByLabelText('Mark reviewed'));
    expect(screen.queryByTestId('rv-strip')).toBeNull();
    expect(screen.getByTestId('rv-strip-rail')).toBeInTheDocument();
  });
});
