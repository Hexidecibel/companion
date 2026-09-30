import { describe, expect, it } from 'vitest';
import { RawRing } from '../rawTap';

describe('RawRing', () => {
  it('slices by absolute position, across wrap-around, clamped to what is still held', () => {
    const r = new RawRing(10);
    r.push(Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7]));
    r.push(Float32Array.from([8, 9, 10, 11]));
    expect(r.position()).toBe(12);
    expect(Array.from(r.slice(5, 9))).toEqual([5, 6, 7, 8]);
    expect(Array.from(r.slice(9, 12))).toEqual([9, 10, 11]);
    // 0 and 1 were overwritten: clamped to the oldest held sample.
    expect(Array.from(r.slice(0, 4))).toEqual([2, 3]);
    expect(r.slice(12, 20).length).toBe(0);
  });

  it('converts PCM16', () => {
    const r = new RawRing(8);
    r.pushInt16(Int16Array.from([16384, -32768]));
    expect(Array.from(r.slice(0, 2))).toEqual([0.5, -1]);
  });
});
