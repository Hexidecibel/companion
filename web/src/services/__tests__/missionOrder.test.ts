import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  missionKey, parseMissionKey, reconcileOrder, moveInOrder,
  loadMissionOrder, saveMissionOrder, onMissionOrderChange, resetMissionOrderCache, MISSION_ORDER_KEY,
} from '../missionOrder';

const k = missionKey;

describe('missionOrder', () => {
  beforeEach(() => {
    localStorage.clear();
    resetMissionOrderCache();
  });

  it('keys round-trip, even with odd characters', () => {
    expect(parseMissionKey(k('srv:1|x', 'abc'))).toEqual({ serverId: 'srv:1|x', sessionId: 'abc' });
    expect(parseMissionKey('junk')).toBeNull();
  });

  it('keeps saved order, appends new sessions at the end, drops removed ones', () => {
    const saved = [k('a', '2'), k('a', '1'), k('a', 'gone')];
    const live = [k('a', '1'), k('a', '2'), k('a', '3')];
    expect(reconcileOrder(saved, live, new Set(['a']))).toEqual([k('a', '2'), k('a', '1'), k('a', '3')]);
  });

  it('keeps the slots of a server that is not in the summaries (offline)', () => {
    const saved = [k('b', 'x'), k('a', '1')];
    expect(reconcileOrder(saved, [k('a', '1')], new Set(['a']))).toEqual([k('b', 'x'), k('a', '1')]);
  });

  it('dedupes and ignores junk in saved order', () => {
    expect(reconcileOrder([k('a', '1'), k('a', '1'), 'junk'], [k('a', '1')], new Set(['a']))).toEqual([k('a', '1')]);
  });

  it('moves up / down one visible step, skipping hidden keys', () => {
    const order = [k('a', '1'), k('b', 'hidden'), k('a', '2')];
    const visible = new Set([k('a', '1'), k('a', '2')]);
    expect(moveInOrder(order, k('a', '2'), -1, visible)).toEqual([k('a', '2'), k('b', 'hidden'), k('a', '1')]);
    expect(moveInOrder(order, k('a', '1'), -1, visible)).toBe(order);
    expect(moveInOrder(order, k('a', '2'), 1, visible)).toBe(order);
    expect(moveInOrder(order, k('a', '1'), 1)).toEqual([k('b', 'hidden'), k('a', '1'), k('a', '2')]);
  });

  it('persists to localStorage and notifies subscribers', () => {
    const cb = vi.fn();
    const off = onMissionOrderChange(cb);
    saveMissionOrder([k('a', '1')]);
    expect(cb).toHaveBeenCalledTimes(1);
    saveMissionOrder([k('a', '1')]); // unchanged: no write, no event
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    resetMissionOrderCache();
    expect(loadMissionOrder()).toEqual([k('a', '1')]);
  });

  it('survives corrupt or blocked storage', () => {
    localStorage.setItem(MISSION_ORDER_KEY, '{not json');
    expect(loadMissionOrder()).toEqual([]);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => saveMissionOrder([k('a', '1')])).not.toThrow();
    expect(loadMissionOrder()).toEqual([k('a', '1')]);
    spy.mockRestore();
  });
});
