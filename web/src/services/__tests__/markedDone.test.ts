import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingPrompt, SessionSummary } from '../../types';
import {
  MARKED_DONE_KEY, getDoneMark, getMarkedDoneVersion, isMarkedDone, markApplies, markDone,
  onMarkedDoneChange, pruneMarkedDone, resetMarkedDoneCache, unmarkDone,
} from '../markedDone';
import { missionKey } from '../missionOrder';

const s = (p: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 'x', name: 'x', projectPath: '/p/x', status: 'waiting', lastActivity: 1000, ...p,
});
const prompt = (signature: string): PendingPrompt => ({
  kind: 'choice', question: 'Go?', options: [{ label: 'Yes' }, { label: 'No' }], signature,
});

describe('markedDone', () => {
  beforeEach(() => {
    localStorage.clear();
    resetMarkedDoneCache();
  });
  afterEach(() => vi.restoreAllMocks());

  it('marks, persists, reloads, and unmarks per server + session', () => {
    markDone('a', s(), 5000);
    expect(getDoneMark('a', 'x')).toEqual({ at: 5000, lastActivity: 1000 });
    expect(isMarkedDone('a', s())).toBe(true);
    expect(isMarkedDone('b', s())).toBe(false); // same id, other server
    resetMarkedDoneCache();
    expect(JSON.parse(localStorage.getItem(MARKED_DONE_KEY)!)[missionKey('a', 'x')]).toBeTruthy();
    expect(isMarkedDone('a', s())).toBe(true);
    unmarkDone('a', 'x');
    expect(isMarkedDone('a', s())).toBe(false);
    resetMarkedDoneCache();
    expect(getDoneMark('a', 'x')).toBeUndefined();
  });

  it('stores the live prompt signature', () => {
    markDone('a', s({ pendingPrompt: prompt('p1') }), 1);
    expect(getDoneMark('a', 'x')?.signature).toBe('p1');
  });

  it('auto-clears on newer activity, and removes the mark', () => {
    markDone('a', s());
    expect(isMarkedDone('a', s({ lastActivity: 1000 }))).toBe(true);
    expect(isMarkedDone('a', s({ lastActivity: 1001 }))).toBe(false);
    expect(getDoneMark('a', 'x')).toBeUndefined();
    // stays cleared even when activity looks old again
    expect(isMarkedDone('a', s({ lastActivity: 1000 }))).toBe(false);
  });

  it('auto-clears when the session works again', () => {
    markDone('a', s());
    expect(isMarkedDone('a', s({ status: 'working' }))).toBe(false);
    expect(getDoneMark('a', 'x')).toBeUndefined();
  });

  it('a NEW prompt resurfaces: no prompt when marked, then one appears', () => {
    markDone('a', s());
    expect(isMarkedDone('a', s({ pendingPrompt: prompt('p1') }))).toBe(false);
    expect(getDoneMark('a', 'x')).toBeUndefined();
  });

  it('the same prompt stays hidden; a different one resurfaces', () => {
    markDone('a', s({ pendingPrompt: prompt('p1') }));
    expect(isMarkedDone('a', s({ pendingPrompt: prompt('p1') }))).toBe(true);
    expect(isMarkedDone('a', s())).toBe(true); // prompt gone, nothing new
    expect(isMarkedDone('a', s({ pendingPrompt: prompt('p2') }))).toBe(false);
  });

  it('markApplies is pure', () => {
    const m = { at: 1, lastActivity: 1000, signature: 'p1' };
    expect(markApplies(m, s({ status: 'idle' }))).toBe(true);
    expect(markApplies(m, s({ status: 'error' }))).toBe(true);
    expect(markApplies(m, s({ status: 'working' }))).toBe(false);
    expect(markApplies(m, s({ lastActivity: 2000 }))).toBe(false);
    expect(markApplies(m, s({ pendingPrompt: prompt('p9') }))).toBe(false);
  });

  it('prunes gone sessions only on servers that are known', () => {
    markDone('a', s({ id: 'live' }));
    markDone('a', s({ id: 'gone' }));
    markDone('offline', s({ id: 'kept' }));
    pruneMarkedDone(new Set([missionKey('a', 'live')]), new Set(['a']));
    expect(getDoneMark('a', 'live')).toBeTruthy();
    expect(getDoneMark('a', 'gone')).toBeUndefined();
    expect(getDoneMark('offline', 'kept')).toBeTruthy();
  });

  it('notifies and bumps the version on changes', () => {
    const cb = vi.fn();
    const off = onMarkedDoneChange(cb);
    const v0 = getMarkedDoneVersion();
    markDone('a', s());
    unmarkDone('a', 'x');
    unmarkDone('a', 'x'); // nothing to do
    expect(cb).toHaveBeenCalledTimes(2);
    expect(getMarkedDoneVersion()).toBe(v0 + 2);
    off();
  });

  it('works in memory when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(isMarkedDone('a', s())).toBe(false);
    markDone('a', s());
    expect(isMarkedDone('a', s())).toBe(true);
    unmarkDone('a', 'x');
    expect(isMarkedDone('a', s())).toBe(false);
  });

  it('ignores corrupt storage', () => {
    localStorage.setItem(MARKED_DONE_KEY, '{not json');
    expect(isMarkedDone('a', s())).toBe(false);
    resetMarkedDoneCache();
    localStorage.setItem(MARKED_DONE_KEY, JSON.stringify({ [missionKey('a', 'x')]: { at: 'bad' } }));
    expect(getDoneMark('a', 'x')).toBeUndefined();
  });
});
