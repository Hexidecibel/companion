import { describe, it, expect } from 'vitest';
import {
  formatBubbleTime,
  formatAgo,
  formatFullTime,
  formatDividerTime,
  isValidMessageTime,
  layoutMessageTimes,
  TimedMessage,
} from '../messageTime';

// Local-time dates so the tests hold in any timezone.
const NOW = new Date(2026, 9, 14, 15, 54, 10).getTime(); // Wed Oct 14 2026 3:54:10 PM
const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0) => new Date(y, mo, d, h, mi, s).getTime();

describe('formatBubbleTime', () => {
  it('shows only the clock for today', () => {
    expect(formatBubbleTime(at(2026, 9, 14, 15, 42), NOW)).toBe('3:42 PM');
    expect(formatBubbleTime(at(2026, 9, 14, 0, 5), NOW)).toBe('12:05 AM');
    expect(formatBubbleTime(at(2026, 9, 14, 12, 0), NOW)).toBe('12:00 PM');
  });
  it('adds month and day for an earlier day this year', () => {
    expect(formatBubbleTime(at(2026, 9, 12, 9, 7), NOW)).toBe('Oct 12, 9:07 AM');
  });
  it('adds the year for an earlier year', () => {
    expect(formatBubbleTime(at(2025, 11, 31, 23, 59), NOW)).toBe('Dec 31 2025, 11:59 PM');
  });
});

describe('formatAgo', () => {
  it('covers the ranges', () => {
    expect(formatAgo(NOW - 10_000, NOW)).toBe('just now');
    expect(formatAgo(NOW - 12 * 60_000, NOW)).toBe('12 min ago');
    expect(formatAgo(NOW - 125 * 60_000, NOW)).toBe('2 hr 5 min ago');
    expect(formatAgo(NOW - 8 * 3600_000, NOW)).toBe('8 hr ago');
    expect(formatAgo(NOW - 26 * 3600_000, NOW)).toBe('1 day ago');
    expect(formatAgo(NOW - 4 * 86400_000, NOW)).toBe('4 days ago');
    expect(formatAgo(NOW - 400 * 86400_000, NOW)).toBe('1 year ago');
  });
});

describe('formatFullTime', () => {
  it('gives weekday, date, seconds and ago', () => {
    expect(formatFullTime(at(2026, 9, 14, 15, 42, 10), NOW)).toBe('Wed, Oct 14 2026, 3:42:10 PM (12 min ago)');
  });
});

describe('formatDividerTime', () => {
  it('uses Today / Yesterday / weekday / year', () => {
    expect(formatDividerTime(at(2026, 9, 14, 9, 0), NOW)).toBe('Today 9:00 AM');
    expect(formatDividerTime(at(2026, 9, 13, 22, 30), NOW)).toBe('Yesterday 10:30 PM');
    expect(formatDividerTime(at(2026, 9, 10, 8, 15), NOW)).toBe('Sat, Oct 10, 8:15 AM');
    expect(formatDividerTime(at(2024, 1, 3, 8, 15), NOW)).toBe('Feb 3 2024, 8:15 AM');
  });
});

describe('isValidMessageTime', () => {
  it('rejects missing, zero and seconds-based values', () => {
    expect(isValidMessageTime(NOW)).toBe(true);
    expect(isValidMessageTime(0)).toBe(false);
    expect(isValidMessageTime(undefined)).toBe(false);
    expect(isValidMessageTime(NaN)).toBe(false);
    expect(isValidMessageTime(1_760_000_000)).toBe(false);
  });
});

describe('layoutMessageTimes', () => {
  const t0 = at(2026, 9, 14, 10, 0);
  const msg = (id: string, type: TimedMessage['type'], min: number, content = 'hi', extra: Partial<TimedMessage> = {}): TimedMessage =>
    ({ id, type, timestamp: t0 + min * 60_000, content, ...extra });

  it('shows the time only on the last bubble of a same-sender run', () => {
    const { shown } = layoutMessageTimes([
      msg('u1', 'user', 0),
      msg('u2', 'user', 1),
      msg('a1', 'assistant', 2),
      msg('a2', 'assistant', 2, ''), // tool-only: continues the run
      msg('a3', 'assistant', 3),
      msg('u3', 'user', 4),
    ], NOW);
    expect([...shown]).toEqual(['u2', 'a3', 'u3']);
  });

  it('breaks a run on a long gap and on system messages', () => {
    const { shown } = layoutMessageTimes([
      msg('a1', 'assistant', 0),
      msg('a2', 'assistant', 10), // > 5 min later
      msg('s1', 'system', 11),
      msg('a3', 'assistant', 12),
    ], NOW);
    expect([...shown]).toEqual(['a1', 'a2', 'a3']);
  });

  it('adds a divider for gaps over an hour and skips messages without a time', () => {
    const { shown, dividers } = layoutMessageTimes([
      msg('u1', 'user', 0),
      msg('a1', 'assistant', 1),
      msg('x', 'assistant', 0, 'live', { timestamp: 0 }),
      msg('u2', 'user', 90),
      msg('q', 'assistant', 91, 'question', { liveSourced: true }),
    ], NOW);
    expect([...dividers.entries()]).toEqual([['u2', 'Today 11:30 AM']]);
    expect(shown.has('x')).toBe(false);
    expect(shown.has('q')).toBe(false);
    expect(shown.has('a1')).toBe(true);
    expect(shown.has('u2')).toBe(true);
  });
});
