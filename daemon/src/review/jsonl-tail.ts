/**
 * Async incremental JSONL reader: reads from a byte offset, carries a partial
 * last line to the next read, rescans from 0 when the file shrinks, and skips
 * (and counts) lines longer than MAX_LINE_BYTES without buffering them.
 */

import * as fs from 'fs';
import { StringDecoder } from 'string_decoder';

export const MAX_LINE_BYTES = 8 * 1024 * 1024;
const CHUNK = 1024 * 1024;

export interface TailRead {
  lines: string[];
  /** The file shrank or was replaced: callers must drop what they derived from it. */
  reset: boolean;
  /** Oversized lines skipped during this read. */
  skipped: number;
  /** More bytes remain beyond this read's budget. */
  more: boolean;
}

export class JsonlTail {
  offset = 0;
  private carry = '';
  private carryBytes = 0;
  private skipping = false;
  private decoder = new StringDecoder('utf8');
  private ino: number | null = null;
  skippedTotal = 0;

  constructor(readonly filePath: string) {}

  private resetState(): void {
    this.offset = 0;
    this.carry = '';
    this.carryBytes = 0;
    this.skipping = false;
    this.decoder = new StringDecoder('utf8');
  }

  /** Read complete new lines, at most `budget` bytes. */
  async read(budget = 64 * 1024 * 1024): Promise<TailRead> {
    let fh: fs.promises.FileHandle;
    try {
      fh = await fs.promises.open(this.filePath, 'r');
    } catch {
      return { lines: [], reset: false, skipped: 0, more: false };
    }
    const lines: string[] = [];
    let reset = false;
    let skipped = 0;
    let more = false;
    try {
      const st = await fh.stat();
      if (st.size < this.offset || (this.ino !== null && st.ino !== this.ino)) {
        this.resetState();
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
        let start = 0;
        for (let i = 0; i < bytesRead; i++) {
          if (buf[i] !== 0x0a) continue;
          const piece = buf.subarray(start, i);
          start = i + 1;
          if (this.skipping) {
            this.skipping = false;
            this.decoder = new StringDecoder('utf8');
            continue;
          }
          if (this.carryBytes + piece.length > MAX_LINE_BYTES) {
            skipped++;
            this.skippedTotal++;
            this.carry = '';
            this.carryBytes = 0;
            this.decoder = new StringDecoder('utf8');
            continue;
          }
          const line = this.carry + this.decoder.write(piece) + this.decoder.end();
          this.decoder = new StringDecoder('utf8');
          this.carry = '';
          this.carryBytes = 0;
          if (line.trim()) lines.push(line);
        }
        if (start < bytesRead) {
          const rest = buf.subarray(start, bytesRead);
          if (!this.skipping) {
            this.carryBytes += rest.length;
            if (this.carryBytes > MAX_LINE_BYTES) {
              this.skipping = true;
              skipped++;
              this.skippedTotal++;
              this.carry = '';
              this.carryBytes = 0;
              this.decoder = new StringDecoder('utf8');
            } else {
              this.carry += this.decoder.write(rest);
            }
          }
        }
      }
    } finally {
      await fh.close().catch(() => undefined);
    }
    return { lines, reset, skipped, more };
  }
}
