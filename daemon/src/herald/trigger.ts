/**
 * Herald remote triggers: a hotkey on another machine (or a Stream Deck, or a
 * phone shortcut) fires `brief` / `listen` / `stop` / `repeat` / `toggle`, and
 * the daemon hands it to the ACTIVE device (the voice service's announcer) as a
 * `trigger` herald_event sent to that one client.
 *
 * Credentials: per-device trigger tokens that can do nothing else.
 *  - The registry (`~/.companion/herald-trigger-tokens.json`, 0600, written by
 *    `bin/companion trigger-token create <name>`) holds each token's NAME and
 *    SHA-256, never the token. Revoked entries stay listed (and refused).
 *  - The original single token file (`~/.companion/herald-trigger.token`) keeps
 *    working as the token named "default" (deprecated; `trigger-token migrate`
 *    registers it so it can be listed and revoked by name).
 *  Both files are re-read when they change (no restart); comparison is constant
 *  time; every attempt is rate limited and audit-logged with the token NAME.
 *
 * Trust: actions that open the mic (`listen`, and `toggle` when it would listen)
 * are honoured only from this machine, the LAN (RFC 1918), the tailnet
 * (100.64.0.0/10) or the home's own public IP (hairpin NAT through the public
 * domain), unless herald.trigger_public_listen is set. Behind HAProxy the
 * client is the X-Forwarded-For address, believed only from a trusted proxy.
 *
 * Optional signed mode (scripts: `signed=true`): instead of the bearer token,
 * `X-Herald-Ts` (unix seconds) + `X-Herald-Sig` = hex HMAC-SHA256 keyed with
 * the token's SHA-256 (hex) over `<ts>.<action>.<device>`; refused when the
 * clock skew is over 60 s or the signature was already used.
 */

import * as crypto from 'crypto';
import * as dns from 'dns';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { AuditEntry, AuditOrigin } from '../audit-log';
import type {
  HeraldEvent,
  HeraldShowResult,
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
  'claim',
  'show',
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
  /** Signed mode: largest accepted clock skew. */
  maxSkewMs: 60_000,
};

/** The name the legacy single token file goes by. */
export const LEGACY_TOKEN_NAME = 'default';

export function defaultTriggerTokenPath(): string {
  return (
    process.env.COMPANION_HERALD_TRIGGER_TOKEN_FILE ||
    path.join(os.homedir(), '.companion', 'herald-trigger.token')
  );
}

/** The per-device token registry; next to the legacy file unless overridden. */
export function defaultTriggerRegistryPath(tokenFile: string = defaultTriggerTokenPath()): string {
  return (
    process.env.COMPANION_HERALD_TRIGGER_TOKENS_FILE ||
    path.join(path.dirname(tokenFile), 'herald-trigger-tokens.json')
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

export function sha256Hex(s: string): string {
  return digest(s).toString('hex');
}

/** Constant-time string comparison (hashing first hides the length too). */
export function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(digest(a), digest(b));
}

/** A recognised trigger credential (never the token itself). */
export interface TriggerCredential {
  name: string;
  /** SHA-256 (hex) of the token: its identity, and the HMAC key in signed mode. */
  sha256: string;
}

interface RegistryEntry {
  name: string;
  sha256: string;
  revoked: boolean;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Trigger tokens: the per-device registry plus the legacy single file. Cached
 * by each file's inode/size/mtime/mode, so the hot path is two stats. A file
 * readable by group or others is refused (and logged once), like ssh does with
 * private keys.
 */
export class TriggerTokenFile {
  private cachedKey = '';
  private entries: RegistryEntry[] = [];
  private warned = new Set<string>();
  readonly registryPath: string;

  constructor(
    private readonly filePath: string = defaultTriggerTokenPath(),
    registryPath?: string
  ) {
    this.registryPath = registryPath ?? defaultTriggerRegistryPath(filePath);
  }

  get path(): string {
    return this.filePath;
  }

  private statKey(p: string): { key: string; st: fs.Stats | null } {
    try {
      const st = fs.statSync(p);
      return { key: `${st.ino}:${st.size}:${st.mtimeMs}:${st.mode}`, st };
    } catch {
      return { key: 'none', st: null };
    }
  }

  private safeMode(p: string, st: fs.Stats, key: string): boolean {
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      this.warnOnce(
        `mode:${p}:${key}`,
        `Herald trigger: ignoring ${p}: permissions ${(st.mode & 0o777).toString(8)} (must be 600)`
      );
      return false;
    }
    return true;
  }

  /** All entries (valid and revoked), reloaded when either file changed. */
  private load(): RegistryEntry[] {
    const legacy = this.statKey(this.filePath);
    const reg = this.statKey(this.registryPath);
    const key = `${legacy.key}|${reg.key}`;
    if (key === this.cachedKey) return this.entries;
    const entries: RegistryEntry[] = [];
    if (reg.st && this.safeMode(this.registryPath, reg.st, reg.key)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.registryPath, 'utf8')) as {
          tokens?: unknown;
        };
        for (const t of Array.isArray(raw.tokens) ? raw.tokens : []) {
          const e = t as Record<string, unknown>;
          if (typeof e.name !== 'string' || !NAME_RE.test(e.name)) continue;
          if (typeof e.sha256 !== 'string' || !HEX64.test(e.sha256)) continue;
          entries.push({ name: e.name, sha256: e.sha256, revoked: !!e.revokedAt });
        }
      } catch {
        this.warnOnce(`reg:${reg.key}`, `Herald trigger: ignoring malformed ${this.registryPath}`);
      }
    }
    if (legacy.st && this.safeMode(this.filePath, legacy.st, legacy.key)) {
      try {
        const tok = fs.readFileSync(this.filePath, 'utf8').trim();
        if (tok.length >= TRIGGER_LIMITS.minTokenLength && !/\s/.test(tok)) {
          const h = sha256Hex(tok);
          // Registered (migrated): the registry entry decides its name and status.
          if (!entries.some((e) => e.sha256 === h))
            entries.push({ name: LEGACY_TOKEN_NAME, sha256: h, revoked: false });
        } else {
          this.warnOnce(`fmt:${legacy.key}`, `Herald trigger: ignoring malformed ${this.filePath}`);
        }
      } catch {
        /* unreadable: no legacy token */
      }
    }
    this.cachedKey = key;
    this.entries = entries;
    return entries;
  }

  /** Valid (non-revoked) credentials. */
  credentials(): TriggerCredential[] {
    return this.load()
      .filter((e) => !e.revoked)
      .map((e) => ({ name: e.name, sha256: e.sha256 }));
  }

  /** The legacy token, or null (kept for callers that want "is one configured"). */
  current(): string | null {
    const legacy = this.statKey(this.filePath);
    if (!legacy.st) return null;
    this.load();
    try {
      const tok = fs.readFileSync(this.filePath, 'utf8').trim();
      return this.identify(tok) ? tok : null;
    } catch {
      return null;
    }
  }

  /**
   * Which credential this token is, or null. Constant time over every entry
   * (no early exit); a revoked token never matches.
   */
  identify(candidate: unknown): TriggerCredential | null {
    if (typeof candidate !== 'string' || candidate.length === 0) return null;
    const entries = this.load();
    const h = digest(candidate);
    let found: RegistryEntry | null = null;
    for (const e of entries) {
      const eq = crypto.timingSafeEqual(h, Buffer.from(e.sha256, 'hex'));
      if (eq && !found) found = e;
    }
    // Still compare once when nothing is configured, so timing does not tell.
    if (entries.length === 0) crypto.timingSafeEqual(h, digest('\0unset'));
    return found && !found.revoked ? { name: found.name, sha256: found.sha256 } : null;
  }

  matches(candidate: unknown): boolean {
    return this.identify(candidate) !== null;
  }

  /** A WS session's credential is still valid (not revoked or rotated since login). */
  stillValid(cred: TriggerCredential): boolean {
    return this.credentials().some((c) => c.sha256 === cred.sha256);
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(message);
  }
}

// ---- origin trust -------------------------------------------------------------

export type TriggerNetwork = 'local' | 'lan' | 'tailnet' | 'home' | 'public';

export interface TriggerOriginInfo {
  /** The client as best known (X-Forwarded-For behind a trusted proxy). */
  client: string;
  network: TriggerNetwork;
  /** Arrived through a reverse proxy (e.g. HAProxy for the public domain). */
  proxied: boolean;
}

function v4(addr: string): number[] | null {
  const m = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(addr);
  if (!m) return null;
  const o = m.slice(1, 5).map(Number);
  return o.every((n) => n >= 0 && n <= 255) ? o : null;
}

/** Strip an IPv4-mapped prefix / brackets / zone id, lower-case. */
export function normalizeIp(addr: string): string {
  let a = addr
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
    .toLowerCase();
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/.test(a)) a = a.slice(7);
  return a;
}

/** Which network an address is on, ignoring the home-IP (hairpin) case. */
export function ipNetwork(addr: string): Exclude<TriggerNetwork, 'home'> {
  const a = normalizeIp(addr);
  const o = v4(a);
  if (o) {
    if (o[0] === 127) return 'local';
    if (o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168))
      return 'lan';
    if (o[0] === 169 && o[1] === 254) return 'lan'; // link-local
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return 'tailnet';
    return 'public';
  }
  if (net.isIPv6(a)) {
    if (a === '::1') return 'local';
    if (a.startsWith('fd7a:115c:a1e0:')) return 'tailnet'; // Tailscale ULA
    if (/^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a)) return 'lan';
  }
  return 'public';
}

/**
 * Who really sent a request. X-Forwarded-For is believed only when the TCP peer
 * is a trusted proxy (HAProxy on this host sets it, overwriting anything the
 * client sent); its LAST entry is the address the proxy saw. A forwarded
 * request from an untrusted peer counts as the internet.
 */
export function classifyTriggerOrigin(opts: {
  peer: string;
  forwardedFor?: string;
  trustedProxies: string[];
  homeIps?: string[];
}): TriggerOriginInfo {
  const peer = normalizeIp(opts.peer || '');
  const xff = (opts.forwardedFor || '').trim();
  const trusted = new Set(opts.trustedProxies.map(normalizeIp));
  let client = peer;
  let proxied = false;
  if (xff) {
    proxied = true;
    if (!trusted.has(peer)) return { client: peer, network: 'public', proxied };
    const last = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .pop();
    if (!last || !net.isIP(normalizeIp(last))) return { client: peer, network: 'public', proxied };
    client = normalizeIp(last);
  }
  let network: TriggerNetwork = ipNetwork(client);
  if (network === 'public' && (opts.homeIps || []).map(normalizeIp).includes(client))
    network = 'home';
  return { client, network, proxied };
}

export function isTrustedNetwork(n: TriggerNetwork): boolean {
  return n !== 'public';
}

/**
 * The home's own public IPs, from DNS names that point at it (e.g. the public
 * domain). Cached; refreshed in the background so a request never waits long.
 */
export class HomeIpResolver {
  private ips: string[] = [];
  private fetchedAt = -Infinity;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly hosts: string[],
    private readonly ttlMs = 5 * 60_000,
    private readonly lookup: (host: string) => Promise<string[]> = async (h) =>
      (await dns.promises.lookup(h, { all: true })).map((r) => r.address),
    private readonly now: () => number = Date.now
  ) {}

  /** Current home IPs; refreshes when stale (waits at most `waitMs`). */
  async get(waitMs = 1500): Promise<string[]> {
    if (this.hosts.length === 0) return [];
    if (this.now() - this.fetchedAt > this.ttlMs) {
      if (!this.inFlight) {
        this.inFlight = Promise.all(this.hosts.map((h) => this.lookup(h).catch(() => [])))
          .then((lists) => {
            const all = Array.from(new Set(lists.flat().map(normalizeIp)));
            if (all.length) this.ips = all;
            this.fetchedAt = this.now();
          })
          .finally(() => {
            this.inFlight = null;
          });
      }
      await Promise.race([this.inFlight, new Promise((r) => setTimeout(r, waitMs).unref?.())]);
    }
    return this.ips;
  }
}

/**
 * Signed mode: HMAC-SHA256 hex over `<ts>.<action>.<device>`, keyed with the
 * token's SHA-256 hex. A `show` that names a session signs
 * `<ts>.<action>.<device>.<session>` (so the session cannot be swapped).
 */
export function triggerSignature(
  keySha256Hex: string,
  ts: string,
  action: string,
  device = '',
  session = ''
): string {
  const msg = session ? `${ts}.${action}.${device}.${session}` : `${ts}.${action}.${device}`;
  return crypto.createHmac('sha256', keySha256Hex).update(msg, 'utf8').digest('hex');
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
      status: 400 | 401 | 403 | 404 | 405 | 409 | 413 | 429 | 503;
      code: HeraldTriggerErrorCode;
      error: string;
      retryAfterMs?: number;
    };

export interface TriggerSource {
  via: 'http' | 'ws';
  origin: AuditOrigin;
  /** HTTP behind a reverse proxy: the X-Forwarded-For chain (audit only). */
  forwardedFor?: string;
  /**
   * Where the caller is (see classifyTriggerOrigin). Absent = a full-scope
   * Companion client, which is trusted like the local machine.
   */
  network?: TriggerNetwork;
  /** The client address behind a proxy (audit). */
  client?: string;
  /** Which trigger token (by name) authorized this, and how. */
  credential?: string;
  auth?: 'bearer' | 'signed' | 'session';
}

export interface HeraldTriggerServiceOptions {
  /** False when Herald or its voice layer is off on this daemon. */
  available: () => boolean;
  /** The client that should act (the voice announcer), or null. */
  activeClient: () => string | null;
  /** `claim`: make the device with this label / id active; its client id, or null if unknown. */
  claimDevice?: (device: string, pin: boolean) => string | null;
  /** Push an event to one client; false if it is gone. */
  deliver: (clientId: string, event: HeraldEvent) => boolean;
  /**
   * `show`: resolve `session` (absent = Herald's latest session) and send a
   * `navigate` event (ack=true) to `clientId`. Absent = `show` is unavailable.
   */
  show?: (session: string | undefined, clientId: string) => HeraldShowResult;
  audit: (entry: AuditEntry) => void;
  tokenFile?: TriggerTokenFile;
  now?: () => number;
  limits?: Partial<typeof TRIGGER_LIMITS>;
  /** Trust rules (defaults: loopback proxy only, no home hosts, no public listen). */
  trust?: { publicListen?: boolean; trustedProxies?: string[]; homeHosts?: string[] };
  /** Injectable home-IP resolver (tests). */
  homeResolver?: HomeIpResolver;
}

const MESSAGES: Record<HeraldTriggerErrorCode, string> = {
  bad_request: `action must be one of ${TRIGGER_ACTIONS.join(', ')}`,
  unauthorized: 'Invalid or missing trigger token',
  forbidden: 'This credential can only fire Herald triggers',
  rate_limited: 'Too many triggers; slow down',
  no_active_device:
    'No active device: open Companion (Herald) in a browser or the app on the device that should respond',
  unavailable: 'Herald voice is not enabled on this daemon',
  unknown_device: 'No connected device has that name or id',
  unknown_session: 'No session has that name',
  ambiguous_session: 'That name matches several sessions',
  nothing_to_show: 'Nothing to show: Herald has not talked about a session lately',
  untrusted_origin:
    'Opening the mic remotely is only allowed from your home network, tailnet or this machine (set herald.trigger_public_listen=true to allow it from anywhere)',
};

/** What a caller asks for: the action, plus the target device for `claim`. */
export interface TriggerRequest {
  action?: unknown;
  device?: unknown;
  pin?: unknown;
  /** `show` only. */
  session?: unknown;
}

function asRequest(raw: unknown): TriggerRequest {
  if (typeof raw === 'string') return { action: raw };
  return raw && typeof raw === 'object' ? (raw as TriggerRequest) : {};
}

export class HeraldTriggerService {
  readonly tokenFile: TriggerTokenFile;
  private readonly limits: typeof TRIGGER_LIMITS;
  private readonly now: () => number;
  private readonly accepted: WindowLimiter;
  private readonly failures: WindowLimiter;
  private seq = 0;
  private readonly publicListen: boolean;
  private readonly trustedProxies: string[];
  private readonly homeResolver: HomeIpResolver;
  /** Signed mode: signatures seen recently (replay guard), value = expiry. */
  private readonly usedSigs = new Map<string, number>();

  constructor(private readonly opts: HeraldTriggerServiceOptions) {
    this.limits = { ...TRIGGER_LIMITS, ...(opts.limits || {}) };
    this.now = opts.now || Date.now;
    this.tokenFile = opts.tokenFile || new TriggerTokenFile();
    this.publicListen = opts.trust?.publicListen === true;
    this.trustedProxies = opts.trust?.trustedProxies ?? ['127.0.0.1', '::1'];
    this.homeResolver = opts.homeResolver || new HomeIpResolver(opts.trust?.homeHosts ?? []);
    this.accepted = new WindowLimiter(this.limits.maxTriggers, this.limits.windowMs, this.now);
    this.failures = new WindowLimiter(
      this.limits.maxFailures,
      this.limits.failureWindowMs,
      this.now
    );
  }

  /** Is this a trigger token? (WS authenticate uses this for a trigger-only session.) */
  tokenMatches(candidate: unknown): boolean {
    return this.tokenFile.matches(candidate);
  }

  /** Which trigger token this is (name + digest), or null. */
  identify(candidate: unknown): TriggerCredential | null {
    return this.tokenFile.identify(candidate);
  }

  /** A trigger-token WS session's credential has not been revoked since login. */
  credentialValid(cred: TriggerCredential): boolean {
    return this.tokenFile.stillValid(cred);
  }

  /** Classify a caller by its TCP peer and X-Forwarded-For (see classifyTriggerOrigin). */
  async classify(peer: string, forwardedFor?: string): Promise<TriggerOriginInfo> {
    const first = classifyTriggerOrigin({
      peer,
      forwardedFor,
      trustedProxies: this.trustedProxies,
    });
    if (first.network !== 'public') return first;
    const homeIps = await this.homeResolver.get();
    return homeIps.length
      ? classifyTriggerOrigin({ peer, forwardedFor, trustedProxies: this.trustedProxies, homeIps })
      : first;
  }

  /** An HTTP caller presented a bad / missing token. Audited until it floods. */
  rejectUnauthorized(source: TriggerSource, raw: unknown): TriggerOutcome {
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
    this.record(source, asRequest(raw), out, started);
    return out;
  }

  /**
   * Fire an action from an authorized caller (trigger token, or a full WS
   * client). `raw`: an action name, or `{action, device?, pin?}`.
   */
  fire(raw: unknown, source: TriggerSource): TriggerOutcome {
    const started = this.now();
    const req = asRequest(raw);
    const out = this.route(req, source);
    this.record(source, req, out, started);
    const who = `${source.credential ? ` token=${source.credential}` : ''}${source.network ? ` from ${source.network}` : ''}`;
    if (out.ok) {
      console.log(`Herald trigger: ${out.result.action} via ${source.via}${who} -> ${out.target}`);
    } else {
      console.log(`Herald trigger: rejected via ${source.via}${who}: ${out.code}`);
    }
    return out;
  }

  /** May this caller open the mic on the active device? */
  private mayListen(source: TriggerSource): boolean {
    return !source.network || isTrustedNetwork(source.network) || this.publicListen;
  }

  private route(req: TriggerRequest, source: TriggerSource): TriggerOutcome {
    const action = parseTriggerAction(req.action);
    if (!action) {
      return { ok: false, status: 400, code: 'bad_request', error: MESSAGES.bad_request };
    }
    const mayListen = this.mayListen(source);
    if (action === 'listen' && !mayListen) {
      return { ok: false, status: 403, code: 'untrusted_origin', error: MESSAGES.untrusted_origin };
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
    // `device` names the machine the hotkey was pressed on: make it active
    // (pinned unless pin=false), then act there. Required for `claim`.
    const device = typeof req.device === 'string' ? req.device.trim() : '';
    if (device.length > 200 || (action === 'claim' && !device)) {
      return {
        ok: false,
        status: 400,
        code: 'bad_request',
        error: 'claim needs "device": a device label or id',
      };
    }
    let target: string | null;
    if (device) {
      target = this.opts.claimDevice?.(device, req.pin !== false) ?? null;
      if (!target) {
        return {
          ok: false,
          status: 404,
          code: 'unknown_device',
          error: `${MESSAGES.unknown_device} ("${device.slice(0, 60)}")`,
        };
      }
    } else {
      target = this.opts.activeClient();
    }
    if (action === 'show') return this.routeShow(req, target);
    const id = `trg-${this.now().toString(36)}-${++this.seq}`;
    // From outside: toggle may stop or cancel, never open the mic.
    const event: HeraldEvent =
      action === 'toggle' && !mayListen
        ? { kind: 'trigger', action, id, allowListen: false }
        : { kind: 'trigger', action, id };
    if (!target || !this.opts.deliver(target, event)) {
      return {
        ok: false,
        status: 409,
        code: 'no_active_device',
        error: MESSAGES.no_active_device,
      };
    }
    return { ok: true, status: 200, result: { action, delivered: true }, target };
  }

  /** `show`: resolve the session and hand a `navigate` event to `target`. */
  private routeShow(req: TriggerRequest, target: string | null): TriggerOutcome {
    const session = typeof req.session === 'string' ? req.session.trim() : '';
    if (session.length > 200) {
      return { ok: false, status: 400, code: 'bad_request', error: 'session is too long' };
    }
    if (!this.opts.show) {
      return { ok: false, status: 503, code: 'unavailable', error: MESSAGES.unavailable };
    }
    if (!target) {
      return { ok: false, status: 409, code: 'no_active_device', error: MESSAGES.no_active_device };
    }
    const r = this.opts.show(session || undefined, target);
    switch (r.status) {
      case 'shown':
        return { ok: true, status: 200, result: { action: 'show', delivered: true }, target };
      case 'ambiguous':
        return {
          ok: false,
          status: 409,
          code: 'ambiguous_session',
          error: `${MESSAGES.ambiguous_session}: ${(r.candidates || []).join(', ')}`,
        };
      case 'not_found':
        return {
          ok: false,
          status: 404,
          code: 'unknown_session',
          error: `${MESSAGES.unknown_session} ("${session.slice(0, 60)}")`,
        };
      case 'nothing':
        return { ok: false, status: 404, code: 'nothing_to_show', error: MESSAGES.nothing_to_show };
      default:
        return {
          ok: false,
          status: 409,
          code: 'no_active_device',
          error: MESSAGES.no_active_device,
        };
    }
  }

  private record(
    source: TriggerSource,
    req: TriggerRequest,
    out: TriggerOutcome,
    started: number
  ): void {
    const action = parseTriggerAction(req.action) ?? (req.action === undefined ? null : 'invalid');
    const payload: Record<string, unknown> = { via: source.via, action };
    if (typeof req.device === 'string' && req.device) {
      payload.device = req.device.slice(0, 80);
      payload.pin = req.pin !== false;
    }
    if (typeof req.session === 'string' && req.session) payload.session = req.session.slice(0, 80);
    if (source.forwardedFor) payload.forwardedFor = source.forwardedFor.slice(0, 200);
    if (source.network) payload.network = source.network;
    if (source.client && source.client !== source.origin.addr) payload.client = source.client;
    if (source.credential) payload.token = source.credential;
    if (source.auth) payload.auth = source.auth;
    if (out.ok && parseTriggerAction(req.action) === 'toggle' && !this.mayListen(source))
      payload.listenBlocked = true;
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
   * POST /herald/trigger. Body `{"action": "...", "device"?: "...", "pin"?: bool}`
   * (or `?action=&device=`); an empty body means `toggle`.
   * Authorization: Bearer <trigger token>.
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
    const xffRaw = req.headers['x-forwarded-for'];
    const xff = Array.isArray(xffRaw) ? xffRaw.join(', ') : xffRaw;
    // Provisional: the peer decides isLocal until the origin is classified.
    const source: TriggerSource = {
      via: 'http',
      origin: { addr, clientId: 'http', isLocal: false, tls, origin: null },
      forwardedFor: xff,
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
      void this.finishHttp(req, chunks, source, send, fail);
    });
  }

  private async finishHttp(
    req: http.IncomingMessage,
    chunks: Buffer[],
    source: TriggerSource,
    send: (status: number, body: unknown, headers?: Record<string, string>) => void,
    fail: (out: Extract<TriggerOutcome, { ok: false }>) => void
  ): Promise<void> {
    const info = await this.classify(source.origin.addr, source.forwardedFor);
    source.network = info.network;
    source.client = info.client;
    source.origin.isLocal = info.network === 'local';
    let request: TriggerRequest;
    const query = new URL(req.url || '/', 'http://x').searchParams;
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (text) {
      try {
        request = asRequest(JSON.parse(text));
      } catch {
        request = { action: 'invalid-json' };
      }
    } else {
      const pin = query.get('pin');
      request = {
        action: query.get('action') ?? 'toggle',
        device: query.get('device') ?? undefined,
        session: query.get('session') ?? undefined,
        pin: pin === null ? undefined : pin !== 'false' && pin !== '0',
      };
    }

    const sigHeader = req.headers['x-herald-sig'];
    let cred: TriggerCredential | null;
    let why: string | undefined;
    if (typeof sigHeader === 'string' && sigHeader) {
      const tsHeader = req.headers['x-herald-ts'];
      const checked = this.verifySignature(
        typeof tsHeader === 'string' ? tsHeader : '',
        sigHeader,
        request
      );
      cred = checked.cred;
      why = checked.error;
      source.auth = 'signed';
    } else {
      const auth = req.headers['authorization'];
      const m = typeof auth === 'string' ? /^Bearer\s+(\S+)\s*$/i.exec(auth) : null;
      cred = m ? this.identify(m[1]) : null;
      source.auth = 'bearer';
    }
    if (!cred) {
      const out = this.rejectUnauthorized(source, request) as Extract<
        TriggerOutcome,
        { ok: false }
      >;
      fail(why && out.status === 401 ? { ...out, error: why } : out);
      return;
    }
    source.credential = cred.name;
    const out = this.fire(request, source);
    if (out.ok) send(200, { success: true, ...out.result });
    else fail(out);
  }

  /**
   * Signed mode: `ts` (unix seconds) within the skew window, an HMAC by one of
   * the valid tokens over `<ts>.<action>.<device>` (plus `.<session>` when a
   * `show` names one), and never seen before.
   */
  verifySignature(
    ts: string,
    sig: string,
    request: TriggerRequest
  ): { cred: TriggerCredential | null; error?: string } {
    const now = this.now();
    for (const [k, exp] of this.usedSigs) if (exp <= now) this.usedSigs.delete(k);
    if (!/^\d{9,12}$/.test(ts))
      return { cred: null, error: 'Signed trigger needs X-Herald-Ts (unix seconds)' };
    if (Math.abs(now - Number(ts) * 1000) > this.limits.maxSkewMs)
      return {
        cred: null,
        error: `Signed trigger rejected: timestamp is more than ${Math.round(this.limits.maxSkewMs / 1000)} s off (check this machine's clock)`,
      };
    const s = sig.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(s)) return { cred: null, error: 'Malformed X-Herald-Sig' };
    const action = typeof request.action === 'string' ? request.action : '';
    const device = typeof request.device === 'string' ? request.device : '';
    const session = typeof request.session === 'string' ? request.session : '';
    const given = Buffer.from(s, 'hex');
    let found: TriggerCredential | null = null;
    for (const c of this.tokenFile.credentials()) {
      const expected = Buffer.from(triggerSignature(c.sha256, ts, action, device, session), 'hex');
      if (crypto.timingSafeEqual(expected, given) && !found) found = c;
    }
    if (!found) return { cred: null };
    if (this.usedSigs.has(s))
      return { cred: null, error: 'Signed trigger rejected: already used (replay)' };
    this.usedSigs.set(s, now + 2 * this.limits.maxSkewMs);
    return { cred: found };
  }
}
