// Time labels for chat messages (text-message-app style).
// All functions take `now` explicitly so they are pure and testable.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Gap between two messages that earns a time divider. */
export const TIME_DIVIDER_GAP_MS = 60 * 60 * 1000;

/** A real epoch-ms timestamp (rejects 0, NaN, seconds-based values). */
export function isValidMessageTime(ts: unknown): ts is number {
  return typeof ts === 'number' && Number.isFinite(ts) && ts > 946684800000; // after 2000-01-01
}

function clock(d: Date, seconds = false): string {
  const h = d.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = seconds ? `:${String(d.getSeconds()).padStart(2, '0')}` : '';
  return `${h12}:${mm}${ss} ${h < 12 ? 'AM' : 'PM'}`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "3:42 PM" today, "Oct 12, 3:42 PM" this year, "Oct 12 2025, 3:42 PM" otherwise. */
export function formatBubbleTime(ts: number, now: number): string {
  const d = new Date(ts);
  const n = new Date(now);
  if (sameDay(d, n)) return clock(d);
  const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  if (d.getFullYear() === n.getFullYear()) return `${md}, ${clock(d)}`;
  return `${md} ${d.getFullYear()}, ${clock(d)}`;
}

/** "just now", "12 min ago", "3 hr ago", "2 hr 5 min ago", "4 days ago". */
export function formatAgo(ts: number, now: number): string {
  const diff = now - ts;
  if (diff < 45 * 1000) return diff < -60 * 1000 ? 'in the future' : 'just now';
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    const rem = min % 60;
    return rem && hr < 6 ? `${hr} hr ${rem} min ago` : `${hr} hr ago`;
  }
  const days = Math.floor(hr / 24);
  if (days < 60) return days === 1 ? '1 day ago' : `${days} days ago`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months} months ago`;
  const years = Math.floor(days / 365.25);
  return years === 1 ? '1 year ago' : `${years} years ago`;
}

/** "Tue, Oct 14 2026, 3:42:10 PM (12 min ago)" — for tooltips / long-press. */
export function formatFullTime(ts: number, now: number): string {
  const d = new Date(ts);
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}, ${clock(d, true)} (${formatAgo(ts, now)})`;
}

/** Divider label: "Today 3:42 PM", "Yesterday 3:42 PM", "Mon, Oct 12, 3:42 PM", "Oct 12 2025, 3:42 PM". */
export function formatDividerTime(ts: number, now: number): string {
  const d = new Date(ts);
  const n = new Date(now);
  if (sameDay(d, n)) return `Today ${clock(d)}`;
  const y = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1);
  if (sameDay(d, y)) return `Yesterday ${clock(d)}`;
  if (d.getFullYear() === n.getFullYear()) {
    return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${clock(d)}`;
  }
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}, ${clock(d)}`;
}

/** Minimal shape needed to lay out times over a list. */
export interface TimedMessage {
  id: string;
  type: 'user' | 'assistant' | 'system';
  timestamp: number;
  content?: string;
  toolCalls?: unknown[];
  isCompaction?: boolean;
  liveSourced?: boolean;
}

/** Whether a message renders a text bubble that can carry a time. */
export function hasTimeBubble(m: TimedMessage): boolean {
  if (m.type === 'system' || m.liveSourced || m.id.startsWith('boundary-')) return false;
  const c = m.content?.trim();
  return !!c && c !== '(no content)' && isValidMessageTime(m.timestamp);
}

/** Within a run, a message followed by one from the same sender this soon hides its time. */
const RUN_GAP_MS = 5 * 60 * 1000;

export interface MessageTimeLayout {
  /** Message ids whose time is shown in the bubble (last of a run). Others reveal on hover / long-press. */
  shown: Set<string>;
  /** Message id -> divider label rendered above it (gap > TIME_DIVIDER_GAP_MS). */
  dividers: Map<string, string>;
}

/**
 * One pass over the list: which bubbles show their time, and where time dividers go.
 * Tool-only assistant messages continue an assistant run; system messages break runs.
 */
export function layoutMessageTimes(messages: TimedMessage[], now: number): MessageTimeLayout {
  const shown = new Set<string>();
  const dividers = new Map<string, string>();
  let prevTs: number | null = null;
  let pending: TimedMessage | null = null; // last bubble whose "shown" status is undecided

  for (const m of messages) {
    const valid = isValidMessageTime(m.timestamp);
    if (valid) {
      if (prevTs !== null && m.timestamp - prevTs > TIME_DIVIDER_GAP_MS) {
        dividers.set(m.id, formatDividerTime(m.timestamp, now));
      }
      if (prevTs === null || m.timestamp > prevTs) prevTs = m.timestamp;
    }

    if (pending) {
      const breaks =
        m.type !== pending.type ||
        dividers.has(m.id) ||
        (valid && hasTimeBubble(m) && m.timestamp - pending.timestamp > RUN_GAP_MS);
      if (breaks) {
        shown.add(pending.id);
        pending = null;
      } else if (hasTimeBubble(m)) {
        pending = null; // a later same-sender bubble takes over
      }
    }
    if (hasTimeBubble(m)) pending = m;
  }
  if (pending) shown.add(pending.id);
  return { shown, dividers };
}
