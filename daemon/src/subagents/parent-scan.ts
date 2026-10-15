/**
 * Incremental scan of a PARENT transcript for task-notifications.
 *
 * Like review/jsonl-tail.ts (async byte offsets, carry across reads, reset on
 * shrink / inode change, oversized lines skipped) but it never decodes or parses
 * a line unless the raw bytes contain the needle: the parent costs a byte scan,
 * not a JSON parse. Only matching lines are returned.
 */

import * as fs from 'fs';

const CHUNK = 1024 * 1024;
export const MAX_SCAN_LINE = 8 * 1024 * 1024;

export interface ScanRead {
  lines: string[];
  bytes: number;
  reset: boolean;
  more: boolean;
}

export class NeedleScanner {
  offset = 0;
  private carry: Buffer[] = [];
  private carryBytes = 0;
  private skipping = false;
  private ino: number | null = null;
  private readonly needle: Buffer;
  /** Last size seen (stat backstop). */
  size = 0;
  /** The file was readable at least once. */
  seen = false;

  constructor(
    readonly filePath: string,
    needle: string
  ) {
    this.needle = Buffer.from(needle, 'utf8');
  }

  /** Start no earlier than `size - maxBack` on the first read (huge files). */
  startNear(size: number, maxBack: number): void {
    if (this.offset === 0 && size > maxBack) {
      this.offset = size - maxBack;
      // The first (partial) line is dropped.
      this.skipping = true;
    }
  }

  private push(piece: Buffer, lines: string[]): void {
    // Complete line = carry + piece.
    if (this.skipping) {
      this.skipping = false;
      this.carry = [];
      this.carryBytes = 0;
      return;
    }
    const total = this.carryBytes + piece.length;
    if (total > MAX_SCAN_LINE) {
      this.carry = [];
      this.carryBytes = 0;
      return;
    }
    const line = this.carry.length ? Buffer.concat([...this.carry, piece], total) : piece;
    this.carry = [];
    this.carryBytes = 0;
    if (line.indexOf(this.needle) >= 0) lines.push(line.toString('utf8'));
  }

  async read(budget: number): Promise<ScanRead> {
    let fh: fs.promises.FileHandle;
    try {
      fh = await fs.promises.open(this.filePath, 'r');
    } catch {
      return { lines: [], bytes: 0, reset: false, more: false };
    }
    const lines: string[] = [];
    let reset = false;
    let bytes = 0;
    let more = false;
    try {
      const st = await fh.stat();
      this.seen = true;
      this.size = st.size;
      if (st.size < this.offset || (this.ino !== null && st.ino !== this.ino)) {
        this.offset = 0;
        this.carry = [];
        this.carryBytes = 0;
        this.skipping = false;
        reset = true;
      }
      this.ino = st.ino;
      let remaining = Math.min(st.size - this.offset, budget);
      more = st.size - this.offset > budget;
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(remaining, 1)));
      while (remaining > 0) {
        const want = Math.min(buf.length, remaining);
        const { bytesRead } = await fh.read(buf, 0, want, this.offset);
        if (bytesRead <= 0) break;
        this.offset += bytesRead;
        remaining -= bytesRead;
        bytes += bytesRead;
        let start = 0;
        for (;;) {
          const nl = buf.indexOf(0x0a, start);
          if (nl < 0 || nl >= bytesRead) break;
          this.push(buf.subarray(start, nl), lines);
          start = nl + 1;
        }
        if (start < bytesRead) {
          const rest = buf.subarray(start, bytesRead);
          if (this.carryBytes + rest.length > MAX_SCAN_LINE) {
            // Oversized line: drop what we have and skip to its end.
            this.carry = [];
            this.carryBytes = 0;
            this.skipping = true;
          } else if (!this.skipping) {
            this.carry.push(Buffer.from(rest));
            this.carryBytes += rest.length;
          }
        }
      }
    } finally {
      await fh.close().catch(() => undefined);
    }
    return { lines, bytes, reset, more };
  }
}
