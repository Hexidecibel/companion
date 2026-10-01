import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOLLOW_UP_AWAIT_MAX_MS, FOLLOW_UP_SETTLE_MS, FollowUpTracker } from '../followUp';

describe('FollowUpTracker', () => {
  let now = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    now = 1000;
  });
  afterEach(() => vi.useRealTimers());

  function make() {
    const arm = vi.fn();
    const t = new FollowUpTracker({ arm, now: () => now });
    return { t, arm };
  }

  it('arms once the spoken reply to a voice turn is over and the turn has ended', () => {
    const { t, arm } = make();
    t.voiceTurn();
    t.update({ speaking: false, busy: true }); // thinking
    t.update({ speaking: true, busy: true });  // first sentence
    t.update({ speaking: false, busy: true }); // gap between sentences: not yet
    vi.advanceTimersByTime(FOLLOW_UP_SETTLE_MS * 2);
    expect(arm).not.toHaveBeenCalled();
    t.update({ speaking: true, busy: true });
    t.update({ speaking: true, busy: false }); // turn over, last sentence still playing
    t.update({ speaking: false, busy: false });
    vi.advanceTimersByTime(FOLLOW_UP_SETTLE_MS - 1);
    expect(arm).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(arm).toHaveBeenCalledTimes(1);
    expect(t.state).toBe('idle');
  });

  it('speech resuming during the settle restarts it (one arm, after the real end)', () => {
    const { t, arm } = make();
    t.voiceTurn();
    t.update({ speaking: true, busy: false });
    t.update({ speaking: false, busy: false });
    vi.advanceTimersByTime(FOLLOW_UP_SETTLE_MS - 100);
    t.update({ speaking: true, busy: false }); // "There's more on screen, say go on."
    vi.advanceTimersByTime(FOLLOW_UP_SETTLE_MS);
    expect(arm).not.toHaveBeenCalled();
    t.update({ speaking: false, busy: false });
    vi.advanceTimersByTime(FOLLOW_UP_SETTLE_MS);
    expect(arm).toHaveBeenCalledTimes(1);
  });

  it('never arms for a reply that was not spoken (voice off, text-only answer)', () => {
    const { t, arm } = make();
    t.voiceTurn();
    t.update({ speaking: false, busy: true });
    t.update({ speaking: false, busy: false });
    vi.advanceTimersByTime(10_000);
    expect(arm).not.toHaveBeenCalled();
  });

  it('never arms without a voice turn (typed questions, unasked speech)', () => {
    const { t, arm } = make();
    t.update({ speaking: true, busy: false });
    t.update({ speaking: false, busy: false });
    vi.advanceTimersByTime(10_000);
    expect(arm).not.toHaveBeenCalled();
  });

  it('cancel (STOP, a typed turn, host switch) drops it, even mid-settle', () => {
    const { t, arm } = make();
    t.voiceTurn();
    t.update({ speaking: true, busy: false });
    t.update({ speaking: false, busy: false });
    t.cancel();
    vi.advanceTimersByTime(FOLLOW_UP_SETTLE_MS * 2);
    expect(arm).not.toHaveBeenCalled();
  });

  it('a voice turn waits at most FOLLOW_UP_AWAIT_MAX_MS for its reply to be spoken', () => {
    const { t, arm } = make();
    t.voiceTurn();
    now += FOLLOW_UP_AWAIT_MAX_MS + 1;
    t.update({ speaking: true, busy: false });
    t.update({ speaking: false, busy: false });
    vi.advanceTimersByTime(FOLLOW_UP_SETTLE_MS);
    expect(arm).not.toHaveBeenCalled();
  });

  it('a local voice command already speaking (repeat) counts as the reply', () => {
    const { t, arm } = make();
    t.update({ speaking: true, busy: false });
    t.voiceTurn();
    expect(t.state).toBe('replying');
    t.update({ speaking: false, busy: false });
    vi.advanceTimersByTime(FOLLOW_UP_SETTLE_MS);
    expect(arm).toHaveBeenCalledTimes(1);
  });

  it('a follow-up turn starts the cycle again (a conversation)', () => {
    const { t, arm } = make();
    for (let i = 0; i < 3; i++) {
      t.voiceTurn();
      t.update({ speaking: true, busy: false });
      t.update({ speaking: false, busy: false });
      vi.advanceTimersByTime(FOLLOW_UP_SETTLE_MS);
    }
    expect(arm).toHaveBeenCalledTimes(3);
  });
});

describe('autoFollowUp (no explicit choice)', () => {
  it('on with headphones; never by itself in Gaming or Desk speakers', async () => {
    const { autoFollowUp } = await import('../../../hooks/useHeraldVoiceInput');
    expect(autoFollowUp(true, null)).toBe(true);
    expect(autoFollowUp(true, 'headphones')).toBe(true);
    expect(autoFollowUp(true, 'phone')).toBe(true);
    expect(autoFollowUp(true, 'gaming')).toBe(false);
    expect(autoFollowUp(true, 'desk')).toBe(false);
    expect(autoFollowUp(false, null)).toBe(false);
    expect(autoFollowUp(null, 'headphones')).toBe(false);
  });
});
