import { beforeEach, describe, expect, it } from 'vitest';
import { markNudgeShown, nudgeShownThisSession, shouldNudgeTakeControl } from '../heraldTakeControlNudge';

describe('take-control nudge', () => {
  beforeEach(() => sessionStorage.clear());

  it('only when Herald is used on a device that is not active, once per session', () => {
    const base = { supported: true, selfId: 'win', isActive: false, shownThisSession: false };
    expect(shouldNudgeTakeControl(base)).toBe(true);
    expect(shouldNudgeTakeControl({ ...base, isActive: true })).toBe(false);
    expect(shouldNudgeTakeControl({ ...base, supported: false })).toBe(false);
    expect(shouldNudgeTakeControl({ ...base, selfId: null })).toBe(false);
    expect(nudgeShownThisSession()).toBe(false);
    markNudgeShown();
    expect(nudgeShownThisSession()).toBe(true);
    expect(shouldNudgeTakeControl({ ...base, shownThisSession: nudgeShownThisSession() })).toBe(false);
  });
});
