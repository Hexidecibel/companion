/**
 * Incremental transcript reading. Claude Code only ever APPENDS to a
 * conversation JSONL, so after the first full read we keep a byte offset (up to
 * the last complete line) and, on every change, read and parse only the bytes
 * after it, feeding them to a ConversationAccumulator (parser.ts) whose result
 * equals a full parseConversationFile.
 *
 * Falls back to a full re-read when the file is not a plain append any more:
 *   - another inode/device (file replaced, e.g. an atomic rename)
 *   - smaller than our offset (truncated / rewritten)
 *   - the bytes just before our offset changed (rewritten in place)
 *   - the size is unknown (exotic fs / mocked fs in tests)
 * A trailing line without its '\n' yet (a write in progress) is not consumed
 * unless it already parses as a complete JSON object.
 *
 * Bounded (LRU). Sync and async readers share the state; an async TAIL read
 * that lost a race (offset moved meanwhile) is redone, a full read just wins.
 */
import * as fs from 'fs';
import { ConversationAccumulator, parseJsonlLines } from './parser';
import { CompactionEvent, ConversationMessage, TaskItem } from './types';
import { impact } from './impact/state';

/** Bytes before the offset re-checked on every read (detects in-place rewrites). */
const TAIL_CHECK = 64;
const MAX_FILES = 32;

interface FileState {
  acc: ConversationAccumulator;
  offset: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  /** Bytes [offset - tail.length, offset) as last read. */
  tail: Buffer;
  /** Bumped on every successful read; an async read checks it before applying. */
  gen: number;
}

export interface TranscriptSnapshot {
  messages(): ConversationMessage[];
  tasks(): TaskItem[];
  compactionSince(
    lastCheckedLine: number,
    sessionId: string,
    sessionName: string,
    projectPath: string
  ): { event: CompactionEvent | null; lastLine: number };
  readonly lineCount: number;
  /** Bytes consumed so far. */
  readonly size: number;
}

interface StatLike {
  size?: number;
  dev?: number;
  ino?: number;
  mtimeMs?: number;
}

function snapshotOf(st: FileState): TranscriptSnapshot {
  return {
    messages: () => st.acc.messages().slice(),
    tasks: () => st.acc.tasks(),
    compactionSince: (l, a, b, c) => st.acc.compactionSince(l, a, b, c),
    get lineCount() {
      return st.acc.lineCount;
    },
    get size() {
      return st.offset;
    },
  };
}

/**
 * Split `buf` into complete lines; returns the entries and how many bytes were
 * consumed (through the last '\n', or the whole buffer when the unterminated
 * remainder is already a complete JSON object).
 */
export function consumeLines(buf: Buffer): {
  entries: ReturnType<typeof parseJsonlLines>;
  used: number;
} {
  const lastNl = buf.lastIndexOf(0x0a);
  let used = lastNl + 1;
  let text = used > 0 ? buf.toString('utf8', 0, used) : '';
  if (used < buf.length) {
    const rest = buf.toString('utf8', used);
    if (rest.trim()) {
      try {
        const v = JSON.parse(rest);
        if (v && typeof v === 'object') {
          text += rest;
          used = buf.length;
        }
      } catch {
        /* a line still being written: read it next time */
      }
    }
  }
  return { entries: text ? parseJsonlLines(text) : [], used };
}

export class TranscriptCache {
  private files = new Map<string, FileState>();
  private max: number;
  /** Whole-file reads vs tail reads (tests + diagnostics). */
  readonly stats = { full: 0, incremental: 0 };

  constructor(max = MAX_FILES) {
    this.max = max;
  }

  private touch(file: string, st: FileState): void {
    this.files.delete(file);
    this.files.set(file, st);
    while (this.files.size > this.max) {
      const oldest = this.files.keys().next().value as string;
      this.files.delete(oldest);
    }
  }

  forget(file: string): void {
    this.files.delete(file);
  }

  has(file: string): boolean {
    return this.files.has(file);
  }

  private canAppend(prev: FileState | undefined, s: StatLike): prev is FileState {
    return (
      !!prev &&
      typeof s.size === 'number' &&
      s.dev === prev.dev &&
      s.ino === prev.ino &&
      s.size >= prev.offset
    );
  }

  private fresh(s: StatLike, data: Buffer, t0: number): FileState {
    this.stats.full++;
    const acc = new ConversationAccumulator();
    const { entries, used } = consumeLines(data);
    acc.append(entries);
    impact.recordTranscriptParse(data.length, performance.now() - t0, true);
    // Unknown size (mocked / exotic fs): never trust an offset, re-read next time.
    const offset = typeof s.size === 'number' ? used : -1;
    return {
      acc,
      offset,
      dev: s.dev ?? -1,
      ino: s.ino ?? -1,
      mtimeMs: s.mtimeMs ?? 0,
      tail: data.subarray(Math.max(0, used - TAIL_CHECK), used),
      gen: 0,
    };
  }

  /** Apply `chunk` = bytes [offset - tail.length, size). False = not an append, re-read. */
  private applyChunk(st: FileState, s: StatLike, chunk: Buffer, t0: number): boolean {
    const tl = st.tail.length;
    if (chunk.length < tl || !chunk.subarray(0, tl).equals(st.tail)) return false;
    const fresh = chunk.subarray(tl);
    this.stats.incremental++;
    const { entries, used } = consumeLines(fresh);
    st.acc.append(entries);
    if (used > 0) {
      const end = tl + used;
      st.tail = Buffer.from(chunk.subarray(Math.max(0, end - TAIL_CHECK), end));
      st.offset += used;
    }
    st.mtimeMs = s.mtimeMs ?? 0;
    st.gen++;
    if (fresh.length > 0) impact.recordTranscriptParse(fresh.length, performance.now() - t0, false);
    return true;
  }

  /** Synchronous read (on-demand paths). Null when the file cannot be read. */
  getSync(file: string): TranscriptSnapshot | null {
    const t0 = performance.now();
    let s: StatLike;
    try {
      s = fs.statSync(file) as StatLike;
      if (!s) return null;
    } catch {
      this.files.delete(file);
      return null;
    }
    const prev = this.files.get(file);
    if (this.canAppend(prev, s)) {
      if (s.size === prev.offset && s.mtimeMs === prev.mtimeMs) {
        this.touch(file, prev);
        return snapshotOf(prev);
      }
      const start = prev.offset - prev.tail.length;
      const len = (s.size as number) - start;
      let fd: number | undefined;
      try {
        fd = fs.openSync(file, 'r');
        if (typeof fd === 'number') {
          const chunk = Buffer.alloc(len);
          const n = fs.readSync(fd, chunk, 0, len, start);
          if (typeof n === 'number' && this.applyChunk(prev, s, chunk.subarray(0, n), t0)) {
            this.touch(file, prev);
            return snapshotOf(prev);
          }
        }
      } catch {
        /* fall through to a full read */
      } finally {
        if (typeof fd === 'number') {
          try {
            fs.closeSync(fd);
          } catch {
            /* ignore */
          }
        }
      }
    }
    let data: Buffer;
    try {
      const raw = fs.readFileSync(file) as Buffer | string | undefined;
      if (raw === undefined || raw === null) return null;
      data = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    } catch {
      this.files.delete(file);
      return null;
    }
    const st = this.fresh(s, data, t0);
    this.touch(file, st);
    return snapshotOf(st);
  }

  /** Non-blocking read (watcher hot path). Null when the file cannot be read. */
  async get(file: string): Promise<TranscriptSnapshot | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const t0 = performance.now();
      let s: StatLike;
      try {
        s = (await fs.promises.stat(file)) as StatLike;
        if (!s) return null;
      } catch {
        this.files.delete(file);
        return null;
      }
      const prev = this.files.get(file);
      if (this.canAppend(prev, s)) {
        if (s.size === prev.offset && s.mtimeMs === prev.mtimeMs) {
          this.touch(file, prev);
          return snapshotOf(prev);
        }
        const gen = prev.gen;
        const start = prev.offset - prev.tail.length;
        const len = (s.size as number) - start;
        let chunk: Buffer | null = null;
        let handle: fs.promises.FileHandle | undefined;
        try {
          handle = await fs.promises.open(file, 'r');
          if (handle && typeof handle.read === 'function') {
            const b = Buffer.alloc(len);
            const { bytesRead } = await handle.read(b, 0, len, start);
            chunk = b.subarray(0, bytesRead);
          }
        } catch {
          chunk = null;
        } finally {
          try {
            await handle?.close();
          } catch {
            /* ignore */
          }
        }
        if (chunk) {
          if (this.files.get(file) !== prev || prev.gen !== gen) continue; // raced: redo
          if (this.applyChunk(prev, s, chunk, t0)) {
            this.touch(file, prev);
            return snapshotOf(prev);
          }
        }
      }
      let data: Buffer;
      try {
        const raw = (await fs.promises.readFile(file)) as Buffer | string | undefined;
        if (raw === undefined || raw === null) return null;
        data = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
      } catch {
        this.files.delete(file);
        return null;
      }
      // A concurrent reader may have stored a state meanwhile; a full read is
      // complete and correct on its own, so last writer wins (a slightly older
      // one just catches up from its offset next time: the prefix is the same).
      const st = this.fresh(s, data, t0);
      this.touch(file, st);
      return snapshotOf(st);
    }
    // Lost the race three times (constant writes + sync readers): read synchronously.
    return this.getSync(file);
  }
}

/** Process-wide cache shared by the watcher and request handlers. */
export const transcriptCache = new TranscriptCache();
