/**
 * Info-level logging that cannot flood the journal: at most `max` lines per
 * `windowMs` for each kind; the rest are counted and reported once ("N more
 * suppressed") when the next window opens. Never logs audio or transcripts:
 * callers pass short, content-free lines (ids, scores, decisions).
 */
export class RateLimitedLog {
  private windows = new Map<string, { start: number; count: number; dropped: number }>();

  constructor(
    private readonly sink: (line: string) => void = (line) => console.log(line),
    private readonly now: () => number = Date.now,
    private readonly max = 20,
    private readonly windowMs = 60_000
  ) {}

  log(kind: string, line: string): void {
    const t = this.now();
    let w = this.windows.get(kind);
    if (!w || t - w.start >= this.windowMs) {
      if (w && w.dropped > 0) {
        this.sink(`Herald voice: ${w.dropped} more "${kind}" log lines suppressed`);
      }
      w = { start: t, count: 0, dropped: 0 };
      this.windows.set(kind, w);
    }
    if (w.count >= this.max) {
      w.dropped++;
      return;
    }
    w.count++;
    this.sink(line);
  }
}

/** Short client id for logs (the first 8 characters of the connection id). */
export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : '-';
}
