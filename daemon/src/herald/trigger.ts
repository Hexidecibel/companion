/**
 * Herald remote triggers: a hotkey on another machine (or a Stream Deck, or a
 * phone shortcut) fires `brief` / `listen` / `stop` / `repeat` / `toggle`, and
 * the daemon hands it to the ACTIVE device (the voice service's announcer) as a
 * `trigger` herald_event sent to that one client.
 *
 * Credential: a separate trigger token that can do nothing else. It lives in a
 * 0600 file outside the repo (`bin/companion trigger-token create`), stored the
 * same way as the main token (plain), and is re-read whenever the file changes,
 * so a rotation takes effect without a daemon restart. Comparison is constant
 * time. Every attempt is rate limited and audit-logged (never the token).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AuditEntry, AuditOrigin } from '../audit-log';
import type {
  HeraldEvent,
  HeraldTriggerAction,
  HeraldTriggerErrorCode,
  HeraldTriggerResult,
} from './protocol';

export const TRIGGER_ACTIONS: readonly HeraldTriggerAction[] = [
  'brief',
  'listen',
  'stop',
  'repeat',
  'toggle',
];

export const TRIGGER_LIMITS = {
  /** Accepted triggers: 10 per 10 s across every caller (one user, one button). */
  maxTriggers: 10,
  windowMs: 10_000,
  /** Bad-token attempts per remote address before we stop auditing / answering them. */
  maxFailures: 20,
  failureWindowMs: 60_000,
  maxBodyBytes: 1024,
  /** Shortest token we accept from the file (the CLI writes 64 hex chars). */
  minTokenLength: 32,
};

export function defaultTriggerTokenPath(): string {
  return (
    process.env.COMPANION_HERALD_TRIGGER_TOKEN_FILE ||
    path.join(os.homedir(), '.companion', 'herald-trigger.token')
  );
}

export function parseTriggerAction(raw: unknown): HeraldTriggerAction | null {
  return typeof raw === 'string' && (TRIGGER_ACTIONS as readonly string[]).includes(raw)
    ? (raw as HeraldTriggerAction)
    : null;
}

function digest(s: string): Buffer {
  return crypto.createHash('sha256').update(s, 'utf8').digest();
}

/** Constant-time string comparison (hashing first hides the length too). */
export function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(digest(a), digest(b));
}

/**
 * The trigger token file. Cached by mtime/size/inode, so the hot path is one
 * stat. A file readable by group or others is refused (and logged once), like
 * ssh does with private keys.
 */
export class TriggerTokenFile {
  private cached: { key: string; token: string | null } | null = null;
  private warned = new Set<string>();

  constructor(private readonly filePath: string = defaultTriggerTokenPath()) {}

  get path(): string {
    return this.filePath;
  }

  /** The current token, or null when none is configured / the file is unsafe. */
  current(): string | null {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.filePath);
    } catch {
      this.cached = null;
      return null;
    }
    const key = `${st.ino}:${st.size}:${st.mtimeMs}:${st.mode}`;
    if (this.cached?.key === key) return this.cached.token;
    let token: string | null = null;
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      this.warnOnce(
        `mode:${key}`,
        `Herald trigger: ignoring ${this.filePath}: permissions ${(st.mode & 0o777).toString(8)} (must be 600)`
      );
    } else {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf8').trim();
        if (raw.length >= TRIGGER_LIMITS.minTokenLength && !/\s/.test(raw)) token = raw;
        else this.warnOnce(`fmt:${key}`, `Herald trigger: ignoring malformed ${this.filePath}`);
      } catch {
        token = null;
      }
    }
    this.cached = { key, token };
    return token;
  }

  matches(candidate: unknown): boolean {
    if (typeof candidate !== 'string' || candidate.length === 0) return false;
    const token = this.current();
    // Still hash + compare when unconfigured so the timing is the same.
    return safeEqual(candidate, token ?? '\0unset') && token !== null;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(message);
  }
}

/** Sliding-window counter per key. */
export class WindowLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}

  /** Records a hit; returns null when allowed, else ms until the next slot. */
  take(key: string): number | null {
    const now = this.now();
    const cutoff = now - this.windowMs;
    let list = this.hits.get(key);
    if (!list) {
      list = [];
      this.hits.set(key, list);
    }
    while (list.length > 0 && list[0] <= cutoff) list.shift();
    if (list.length < this.limit) {
      list.push(now);
      return null;
    }
    return Math.max(1, list[0] + this.windowMs - now);
  }

  /** Drop idle keys (bounded memory under a scan). */
  prune(): void {
    const cutoff = this.now() - this.windowMs;
    for (const [k, list] of this.hits) {
      if (list.length === 0 || list[list.length - 1] <= cutoff) this.hits.delete(k);
    }
  }
}

export type TriggerOutcome =
  | { ok: true; status: 200; result: HeraldTriggerResult; target: string }
  | {
      ok: false;
      status: 400 | 401 | 403 | 405 | 409 | 413 | 429 | 503;
      code: HeraldTriggerErrorCode;
      error: string;
      retryAfterMs?: number;
    };

export interface TriggerSource {
  via: 'http' | 'ws';
  origin: AuditOrigin;
  /** HTTP behind a reverse proxy: the X-Forwarded-For chain (audit only). */
  forwardedFor?: string;
}

export interface HeraldTriggerServiceOptions {
  /** False when Herald or its voice layer is off on this daemon. */
  available: () => boolean;
  /** The client that should act (the voice announcer), or null. */
  activeClient: () => string | null;
  /** Push an event to one client; false if it is gone. */
  deliver: (clientId: string, event: HeraldEvent) => boolean;
  audit: (entry: AuditEntry) => void;
  tokenFile?: TriggerTokenFile;
  now?: () => number;
  limits?: Partial<typeof TRIGGER_LIMITS>;
}

const MESSAGES: Record<HeraldTriggerErrorCode, string> = {
  bad_request: `action must be one of ${TRIGGER_ACTIONS.join(', ')}`,
  unauthorized: 'Invalid or missing trigger token',
  forbidden: 'This credential can only fire Herald triggers',
  rate_limited: 'Too many triggers; slow down',
  no_active_device:
    'No active device: open Companion (Herald) in a browser or the app on the device that should respond',
  unavailable: 'Herald voice is not enabled on this daemon',
};

export class HeraldTriggerService {
  readonly tokenFile: TriggerTokenFile;
  private readonly limits: typeof TRIGGER_LIMITS;
  private readonly now: () => number;
  private readonly accepted: WindowLimiter;
  private readonly failures: WindowLimiter;
  private seq = 0;

  constructor(private readonly opts: HeraldTriggerServiceOptions) {
    this.limits = { ...TRIGGER_LIMITS, ...(opts.limits || {}) };
    this.now = opts.now || Date.now;
    this.tokenFile = opts.tokenFile || new TriggerTokenFile();
    this.accepted = new WindowLimiter(this.limits.maxTriggers, this.limits.windowMs, this.now);
    this.failures = new WindowLimiter(
      this.limits.maxFailures,
      this.limits.failureWindowMs,
      this.now
    );
  }

  /** Is this the trigger token? (WS authenticate uses this for a trigger-only session.) */
  tokenMatches(candidate: unknown): boolean {
    return this.tokenFile.matches(candidate);
  }

  /** An HTTP caller presented a bad / missing token. Audited until it floods. */
  rejectUnauthorized(source: TriggerSource, rawAction: unknown): TriggerOutcome {
    const started = this.now();
    const wait = this.failures.take(source.origin.addr || 'unknown');
    this.failures.prune();
    if (wait !== null) {
      return {
        ok: false,
        status: 429,
        code: 'rate_limited',
        error: MESSAGES.rate_limited,
        retryAfterMs: wait,
      };
    }
    const out: TriggerOutcome = {
      ok: false,
      status: 401,
      code: 'unauthorized',
      error: MESSAGES.unauthorized,
    };
    this.record(source, rawAction, out, started);
    return out;
  }

  /** Fire an action from an authorized caller (trigger token, or a full WS client). */
  fire(rawAction: unknown, source: TriggerSource): TriggerOutcome {
    const started = this.now();
    const out = this.route(rawAction);
    this.record(source, rawAction, out, started);
    if (out.ok) {
      console.log(`Herald trigger: ${out.result.action} via ${source.via} -> ${out.target}`);
    } else {
      console.log(`Herald trigger: rejected via ${source.via}: ${out.code}`);
    }
    return out;
  }

  private route(rawAction: unknown): TriggerOutcome {
    const action = parseTriggerAction(rawAction);
    if (!action) {
      return { ok: false, status: 400, code: 'bad_request', error: MESSAGES.bad_request };
    }
    const wait = this.accepted.take('trigger');
    if (wait !== null) {
      return {
        ok: false,
        status: 429,
        code: 'rate_limited',
        error: MESSAGES.rate_limited,
        retryAfterMs: wait,
      };
    }
    if (!this.opts.available()) {
      return { ok: false, status: 503, code: 'unavailable', error: MESSAGES.unavailable };
    }
    const target = this.opts.activeClient();
    const id = `trg-${this.now().toString(36)}-${++this.seq}`;
    if (!target || !this.opts.deliver(target, { kind: 'trigger', action, id })) {
      return {
        ok: false,
        status: 409,
        code: 'no_active_device',
        error: MESSAGES.no_active_device,
      };
    }
    return { ok: true, status: 200, result: { action, delivered: true }, target };
  }

  private record(
    source: TriggerSource,
    rawAction: unknown,
    out: TriggerOutcome,
    started: number
  ): void {
    const action = parseTriggerAction(rawAction) ?? (rawAction === undefined ? null : 'invalid');
    const payload: Record<string, unknown> = { via: source.via, action };
    if (source.forwardedFor) payload.forwardedFor = source.forwardedFor.slice(0, 200);
    const result: AuditEntry['result'] = out.ok
      ? { ok: true, target: out.target }
      : { ok: false, code: out.code, status: out.status };
    try {
      this.opts.audit({
        ts: started,
        origin: source.origin,
        action: 'herald_trigger',
        payload,
        result,
        durationMs: Math.max(0, this.now() - started),
      });
    } catch (err) {
      console.error('Herald trigger: audit failed:', err);
    }
  }

  // ---- HTTP -----------------------------------------------------------------

  /**
   * POST /herald/trigger. Body `{"action": "..."}` (or `?action=`); an empty
   * body means `toggle`. Authorization: Bearer <trigger token>.
   */
  handleHttp(req: http.IncomingMessage, res: http.ServerResponse, tls: boolean): void {
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      if (res.headersSent) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...headers,
      });
      res.end(JSON.stringify(body));
    };
    const fail = (out: Extract<TriggerOutcome, { ok: false }>) => {
      const headers: Record<string, string> = {};
      if (out.retryAfterMs) headers['Retry-After'] = String(Math.ceil(out.retryAfterMs / 1000));
      if (out.status === 401) headers['WWW-Authenticate'] = 'Bearer realm="herald-trigger"';
      if (out.status === 405) headers['Allow'] = 'POST';
      send(out.status, { success: false, error: out.error, code: out.code }, headers);
    };

    if (req.method !== 'POST') {
      fail({ ok: false, status: 405, code: 'bad_request', error: 'Use POST' });
      return;
    }

    const addr = req.socket.remoteAddress || '';
    const isLocal = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    const xff = req.headers['x-forwarded-for'];
    const source: TriggerSource = {
      via: 'http',
      origin: { addr, clientId: 'http', isLocal, tls, origin: null },
      forwardedFor: Array.isArray(xff) ? xff.join(', ') : xff,
    };

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > this.limits.maxBodyBytes) {
        aborted = true;
        fail({ ok: false, status: 413, code: 'bad_request', error: 'Body too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => {
      aborted = true;
    });
    req.on('end', () => {
      if (aborted) return;
      let action: unknown;
      const query = new URL(req.url || '/', 'http://x').searchParams.get('action');
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text) {
        try {
          action = (JSON.parse(text) as { action?: unknown } | null)?.action;
        } catch {
          action = 'invalid-json';
        }
      } else {
        action = query ?? 'toggle';
      }

      const auth = req.headers['authorization'];
      const m = typeof auth === 'string' ? /^Bearer\s+(\S+)\s*$/i.exec(auth) : null;
      if (!m || !this.tokenMatches(m[1])) {
        fail(this.rejectUnauthorized(source, action) as Extract<TriggerOutcome, { ok: false }>);
        return;
      }
      const out = this.fire(action, source);
      if (out.ok) send(200, { success: true, ...out.result });
      else fail(out);
    });
  }
}
