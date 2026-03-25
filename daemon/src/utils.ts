import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Write a file atomically: write to a temp file in the same directory, then rename.
 * Prevents corruption if the process crashes mid-write.
 */
export function atomicWriteFileSync(filePath: string, data: string, options?: fs.WriteFileOptions): void {
  const dir = path.dirname(filePath);
  const tmpFile = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmpFile, data, options);
    fs.renameSync(tmpFile, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * A Map with a maximum size. When the limit is exceeded, the oldest half of entries
 * are removed (by insertion order, which JS Maps preserve).
 */
export class BoundedMap<K, V> extends Map<K, V> {
  private maxSize: number;

  constructor(maxSize: number) {
    super();
    this.maxSize = maxSize;
  }

  set(key: K, value: V): this {
    super.set(key, value);
    if (this.size > this.maxSize) {
      this.evict();
    }
    return this;
  }

  private evict(): void {
    const toDelete = Math.floor(this.size / 2);
    let count = 0;
    for (const key of this.keys()) {
      if (count >= toDelete) break;
      this.delete(key);
      count++;
    }
  }
}

/**
 * A Set with a maximum size. When the limit is exceeded, the set is cleared.
 * Suitable for dedup sets where old entries are safe to forget.
 */
export class BoundedSet<V> extends Set<V> {
  private maxSize: number;

  constructor(maxSize: number) {
    super();
    this.maxSize = maxSize;
  }

  add(value: V): this {
    super.add(value);
    if (this.size > this.maxSize) {
      this.clear();
      // Re-add the current value so it's tracked
      super.add(value);
    }
    return this;
  }
}

/**
 * Shutdown registry for cleanup functions (timer clearers, etc.).
 * Register cleanup functions, then call shutdownAll() on process exit.
 */
const shutdownCallbacks: Array<() => void> = [];

export function registerShutdownCallback(callback: () => void): void {
  shutdownCallbacks.push(callback);
}

export function runShutdownCallbacks(): void {
  for (const cb of shutdownCallbacks) {
    try {
      cb();
    } catch (err) {
      console.error('Shutdown callback error:', err);
    }
  }
}
