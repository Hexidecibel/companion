/**
 * Paired-device registry: one revocable token per device.
 *
 * File: `~/.companion/devices.json` (COMPANION_DEVICES_FILE overrides), mode
 * 0600 in a 0700 dir, written atomically (temp file + rename). It holds each
 * device's id, name, platform, timestamps and `sha256(salt || secret)` with a
 * per-token random salt - never the token. Tokens look like
 * `cdt1.<deviceId>.<secret>` (256 random bits, base64url), so a lookup hashes
 * once; unknown ids still run a dummy constant-time compare.
 *
 * The file is read lazily (first use) and re-read when its inode/size/mtime
 * changes, so the CLI can edit it while the daemon is down. `lastSeenAt`
 * updates are coalesced: at most one disk write per LAST_SEEN_FLUSH_MS.
 *
 * Trigger tokens (herald/trigger.ts) are a separate registry on purpose: a
 * trigger credential can never become a full one.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicWriteFileSync } from '../utils';

export const DEVICE_TOKEN_PREFIX = 'cdt1';
export const LAST_SEEN_FLUSH_MS = 60_000;
export const MAX_DEVICES = 200;
export const MAX_NAME_LENGTH = 60;

export const DEVICE_PLATFORMS = ['android', 'ios', 'desktop', 'web', 'cli', 'other'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export interface DeviceCapabilities {
  exec?: boolean;
  dispatch?: boolean;
  write?: boolean;
}

export interface DeviceRecord {
  id: string;
  name: string;
  platform: DevicePlatform;
  createdAt: number;
  lastSeenAt: number | null;
  /** How it was paired: 'code' | 'approval' | 'qr' | 'upgrade' | 'cli'. */
  via: string;
  salt: string;
  tokenHash: string;
  capabilities?: DeviceCapabilities;
}

/** What clients see: never the salt or hash. */
export type DeviceInfo = Omit<DeviceRecord, 'salt' | 'tokenHash'>;

export function defaultDevicesPath(): string {
  return (
    process.env.COMPANION_DEVICES_FILE || path.join(os.homedir(), '.companion', 'devices.json')
  );
}

export function normalizePlatform(raw: unknown): DevicePlatform {
  return typeof raw === 'string' && (DEVICE_PLATFORMS as readonly string[]).includes(raw)
    ? (raw as DevicePlatform)
    : 'other';
}

/** Printable, single-line, bounded device name ('' when nothing usable is left). */
export function cleanDeviceName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return (
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_NAME_LENGTH)
  );
}

function hashSecret(salt: string, secret: string): Buffer {
  return crypto
    .createHash('sha256')
    .update(Buffer.from(salt, 'hex'))
    .update(secret, 'utf8')
    .digest();
}

const ID_RE = /^[0-9a-f]{16}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

/** Split a device token; null when it is not one. */
export function parseDeviceToken(token: unknown): { id: string; secret: string } | null {
  if (typeof token !== 'string' || token.length > 100) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== DEVICE_TOKEN_PREFIX) return null;
  if (!ID_RE.test(parts[1]) || !SECRET_RE.test(parts[2])) return null;
  return { id: parts[1], secret: parts[2] };
}

export function isDeviceToken(token: unknown): boolean {
  return typeof token === 'string' && token.startsWith(`${DEVICE_TOKEN_PREFIX}.`);
}

function publicInfo(d: DeviceRecord): DeviceInfo {
  const out: DeviceInfo = {
    id: d.id,
    name: d.name,
    platform: d.platform,
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt ?? null,
    via: d.via,
  };
  if (d.capabilities) out.capabilities = d.capabilities;
  return out;
}

export class DeviceRegistry {
  private devices: DeviceRecord[] = [];
  private loadedKey: string | null = null;
  private dirtySeen = false;
  private lastFlush = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly filePath: string = defaultDevicesPath(),
    private readonly now: () => number = Date.now
  ) {}

  private statKey(): string {
    try {
      const st = fs.statSync(this.filePath);
      return `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      return 'none';
    }
  }

  /** (Re)load when the file changed on disk. */
  private load(): void {
    const key = this.statKey();
    if (key === this.loadedKey) return;
    this.loadedKey = key;
    if (key === 'none') {
      this.devices = [];
      return;
    }
    try {
      const st = fs.statSync(this.filePath);
      if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
        // Tighten instead of refusing: we are the only writer of this file.
        fs.chmodSync(this.filePath, 0o600);
      }
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as { devices?: unknown };
      const list = Array.isArray(raw.devices) ? raw.devices : [];
      this.devices = list.filter(isRecord).slice(0, MAX_DEVICES);
    } catch (err) {
      console.error(`Devices: ignoring unreadable ${this.filePath}:`, (err as Error).message);
      this.devices = [];
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(
      this.filePath,
      JSON.stringify({ version: 1, devices: this.devices }, null, 2) + '\n',
      { mode: 0o600 }
    );
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      /* best effort */
    }
    this.loadedKey = this.statKey();
    this.dirtySeen = false;
    this.lastFlush = this.now();
  }

  list(): DeviceInfo[] {
    this.load();
    return this.devices.map(publicInfo);
  }

  get(id: string): DeviceInfo | null {
    this.load();
    const d = this.devices.find((x) => x.id === id);
    return d ? publicInfo(d) : null;
  }

  /** Create a device and return its token (the only time it exists in clear). */
  create(opts: {
    name: string;
    platform: DevicePlatform;
    via: string;
    capabilities?: DeviceCapabilities;
  }): { device: DeviceInfo; token: string } {
    this.load();
    if (this.devices.length >= MAX_DEVICES) throw new Error('too_many_devices');
    let id: string;
    do id = crypto.randomBytes(8).toString('hex');
    while (this.devices.some((d) => d.id === id));
    const secret = crypto.randomBytes(32).toString('base64url');
    const salt = crypto.randomBytes(16).toString('hex');
    const rec: DeviceRecord = {
      id,
      name: cleanDeviceName(opts.name) || 'Unnamed device',
      platform: opts.platform,
      createdAt: this.now(),
      lastSeenAt: null,
      via: opts.via,
      salt,
      tokenHash: hashSecret(salt, secret).toString('hex'),
      ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
    };
    this.devices.push(rec);
    this.save();
    return { device: publicInfo(rec), token: `${DEVICE_TOKEN_PREFIX}.${id}.${secret}` };
  }

  /** The device a token belongs to; null for unknown, malformed or revoked. Constant time per candidate. */
  verify(token: unknown): DeviceInfo | null {
    const parsed = parseDeviceToken(token);
    this.load();
    const rec = parsed ? this.devices.find((d) => d.id === parsed.id) : undefined;
    const salt = rec?.salt ?? '00'.repeat(16);
    const expected = rec ? Buffer.from(rec.tokenHash, 'hex') : crypto.randomBytes(32);
    const given = hashSecret(salt, parsed?.secret ?? 'invalid');
    const eq = expected.length === given.length && crypto.timingSafeEqual(expected, given);
    return rec && eq ? publicInfo(rec) : null;
  }

  /** Still paired (not revoked since a socket authenticated). */
  exists(id: string): boolean {
    this.load();
    return this.devices.some((d) => d.id === id);
  }

  rename(id: string, name: string): DeviceInfo | null {
    this.load();
    const rec = this.devices.find((d) => d.id === id);
    const clean = cleanDeviceName(name);
    if (!rec || !clean) return null;
    rec.name = clean;
    this.save();
    return publicInfo(rec);
  }

  revoke(id: string): DeviceInfo | null {
    this.load();
    const idx = this.devices.findIndex((d) => d.id === id);
    if (idx === -1) return null;
    const [rec] = this.devices.splice(idx, 1);
    this.save();
    return publicInfo(rec);
  }

  /** Record activity; written at most once per LAST_SEEN_FLUSH_MS. */
  touch(id: string): void {
    this.load();
    const rec = this.devices.find((d) => d.id === id);
    if (!rec) return;
    rec.lastSeenAt = this.now();
    this.dirtySeen = true;
    const wait = this.lastFlush + LAST_SEEN_FLUSH_MS - this.now();
    if (wait <= 0) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, wait);
      this.flushTimer.unref?.();
    }
  }

  flush(): void {
    if (!this.dirtySeen) return;
    // Merge into the current file so a concurrent CLI revoke is never undone.
    const seen = new Map(this.devices.map((d) => [d.id, d.lastSeenAt]));
    this.loadedKey = null;
    this.load();
    for (const d of this.devices) {
      const ts = seen.get(d.id);
      if (ts && (!d.lastSeenAt || ts > d.lastSeenAt)) d.lastSeenAt = ts;
    }
    try {
      this.save();
    } catch (err) {
      console.error('Devices: failed to save last-seen:', (err as Error).message);
    }
  }

  shutdown(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.flush();
  }
}

function isRecord(x: unknown): x is DeviceRecord {
  const d = x as Record<string, unknown>;
  return (
    !!d &&
    typeof d.id === 'string' &&
    ID_RE.test(d.id) &&
    typeof d.name === 'string' &&
    typeof d.salt === 'string' &&
    /^[0-9a-f]{32}$/.test(d.salt) &&
    typeof d.tokenHash === 'string' &&
    /^[0-9a-f]{64}$/.test(d.tokenHash) &&
    typeof d.createdAt === 'number'
  );
}
