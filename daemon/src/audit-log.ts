import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const AUDIT_DIR = path.join(os.homedir(), '.companion');
const AUDIT_FILE = path.join(AUDIT_DIR, 'audit.log');
const MAX_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_ROTATED_FILES = 5;

export interface AuditOrigin {
  addr: string;
  clientId: string;
  isLocal: boolean;
  tls: boolean;
  origin: string | null;
}

export interface AuditEntry {
  ts: number;
  origin: AuditOrigin;
  action: string;
  payload: Record<string, unknown>;
  result: { ok: boolean; [key: string]: unknown };
  durationMs: number;
}

export class AuditLog {
  private filePath: string;

  constructor(filePath: string = AUDIT_FILE) {
    this.filePath = filePath;
    try {
      if (!fs.existsSync(AUDIT_DIR)) {
        fs.mkdirSync(AUDIT_DIR, { recursive: true });
      }
    } catch (err) {
      console.error('AuditLog: Failed to create audit dir:', err);
    }
  }

  append(entry: AuditEntry): void {
    setImmediate(() => {
      try {
        this.rotateIfNeeded();
        fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
      } catch (err) {
        console.error('AuditLog: Failed to append entry:', err);
      }
    });
  }

  read(options: { limit: number; sinceTs?: number }): { entries: AuditEntry[]; hasMore: boolean } {
    const { limit, sinceTs } = options;
    if (!fs.existsSync(this.filePath)) {
      return { entries: [], hasMore: false };
    }
    const content = fs.readFileSync(this.filePath, 'utf-8');
    const lines = content.split('\n');
    const parsed: AuditEntry[] = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as AuditEntry;
        if (entry && typeof entry.ts === 'number') {
          parsed.push(entry);
        }
      } catch (err) {
        console.error('AuditLog: Skipping malformed line:', err);
      }
    }
    parsed.reverse();
    const filtered = typeof sinceTs === 'number'
      ? parsed.filter((e) => e.ts > sinceTs)
      : parsed;
    const sliced = filtered.slice(0, limit);
    const hasMore = filtered.length > sliced.length;
    return { entries: sliced, hasMore };
  }

  private rotateIfNeeded(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const stats = fs.statSync(this.filePath);
      if (stats.size < MAX_SIZE_BYTES) return;

      for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
        const src = `${this.filePath}.${i}`;
        const dst = `${this.filePath}.${i + 1}`;
        if (fs.existsSync(src)) {
          try {
            fs.renameSync(src, dst);
          } catch (err) {
            console.error(`AuditLog: Failed to rotate ${src} -> ${dst}:`, err);
          }
        }
      }
      const oldest = `${this.filePath}.${MAX_ROTATED_FILES + 1}`;
      if (fs.existsSync(oldest)) {
        try {
          fs.unlinkSync(oldest);
        } catch {
          /* ignore */
        }
      }
      fs.renameSync(this.filePath, `${this.filePath}.1`);
    } catch (err) {
      console.error('AuditLog: Rotation failed:', err);
    }
  }
}
