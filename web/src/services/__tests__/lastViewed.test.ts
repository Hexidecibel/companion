import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getLastViewed, markViewed, isUnseen, onLastViewedChange, resetLastViewedCache, LAST_VIEWED_KEY, LAST_VIEWED_MAX,
} from '../lastViewed';

describe('lastViewed', () => {
  beforeEach(() => {
    localStorage.clear();
    resetLastViewedCache();
  });

  it('a never-opened session counts as seen up to the first use (no dot storm on first launch)', () => {
    expect(getLastViewed('a', '1', 1000)).toBe(1000);
    expect(isUnseen('a', '1', 900, 5000)).toBe(false);
    expect(isUnseen('a', '1', 1500, 5000)).toBe(true);
  });

  it('marking viewed clears the dot until new activity', () => {
    getLastViewed('a', '1', 1000);
    markViewed('a', '1', 2000);
    expect(isUnseen('a', '1', 1800)).toBe(false);
    expect(isUnseen('a', '1', 2500)).toBe(true);
    expect(isUnseen('b', '1', 1800)).toBe(true); // other server, same id
  });

  it('persists, notifies, and caps entries', () => {
    const cb = vi.fn();
    const off = onLastViewedChange(cb);
    markViewed('a', '1', 2000);
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    resetLastViewedCache();
    expect(getLastViewed('a', '1')).toBe(2000);
    for (let i = 0; i < LAST_VIEWED_MAX + 5; i++) markViewed('s', String(i), 3000 + i);
    const stored = JSON.parse(localStorage.getItem(LAST_VIEWED_KEY)!);
    expect(Object.keys(stored.seen)).toHaveLength(LAST_VIEWED_MAX);
    expect(stored.seen[JSON.stringify(['s', String(LAST_VIEWED_MAX + 4)])]).toBe(3000 + LAST_VIEWED_MAX + 4);
  });

  it('survives corrupt and blocked storage', () => {
    localStorage.setItem(LAST_VIEWED_KEY, 'nope');
    expect(getLastViewed('a', '1', 42)).toBe(42);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => markViewed('a', '1', 50)).not.toThrow();
    expect(getLastViewed('a', '1')).toBe(50);
    spy.mockRestore();
  });
});
