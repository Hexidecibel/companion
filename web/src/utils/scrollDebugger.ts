// Telemetry-only diagnostic logging for the SessionView scroll-jump bug.
// Zero behavior change — observation only. Disabled by default.
//
// Enable via: localStorage.setItem('scroll-debug-enabled', 'true') OR via the
// ScrollDebugPanel toggle button (Cmd/Ctrl+Alt+Shift+D).
//
// Privacy: NO message content, NO user-typed input. Only structural numbers
// (positions, counts, timestamps, source strings).

export type ScrollEventType =
  | 'effect-fired'
  | 'user-scroll'
  | 'resize-observer'
  | 'jump-detected';

export interface ScrollEvent {
  timestamp: number;
  type: ScrollEventType;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  messageCount: number;
  prevMessageCount?: number;
  nearBottom: boolean;
  source: string;
  rAFCount?: number;
  layoutShiftDelta?: number;
}

const MAX_EVENTS = 500;
const STORAGE_KEY = 'scroll-debug-enabled';

class ScrollDebugger {
  enabled: boolean;
  private buffer: ScrollEvent[] = [];
  private currentSessionId: string | null = null;

  constructor() {
    // Read flag once at construction; setEnabled() updates it later.
    let initial = false;
    try {
      initial = typeof localStorage !== 'undefined'
        && localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
      initial = false;
    }
    this.enabled = initial;
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
    try {
      if (value) localStorage.setItem(STORAGE_KEY, 'true');
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore storage errors
    }
  }

  init(sessionId: string): void {
    if (this.currentSessionId === sessionId) return;
    this.currentSessionId = sessionId;
    this.buffer = [];
  }

  getSessionId(): string | null {
    return this.currentSessionId;
  }

  record(event: ScrollEvent): void {
    // Cheap no-op when disabled — single boolean check.
    if (!this.enabled) return;
    this.buffer.push(event);
    if (this.buffer.length > MAX_EVENTS) {
      this.buffer.shift(); // FIFO eviction
    }
  }

  getEvents(): ScrollEvent[] {
    return this.buffer.slice();
  }

  clear(): void {
    this.buffer = [];
  }

  export(): string {
    const cols: (keyof ScrollEvent)[] = [
      'timestamp',
      'type',
      'source',
      'scrollTop',
      'scrollHeight',
      'clientHeight',
      'messageCount',
      'prevMessageCount',
      'nearBottom',
      'rAFCount',
      'layoutShiftDelta',
    ];
    const escape = (v: unknown): string => {
      if (v === undefined || v === null) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };
    const header = cols.join(',');
    const rows = this.buffer.map(ev =>
      cols.map(c => escape((ev as unknown as Record<string, unknown>)[c])).join(',')
    );
    return [header, ...rows].join('\n');
  }
}

const scrollDebugger = new ScrollDebugger();
export default scrollDebugger;
