/**
 * Pairing state machine: a new device asks to pair, the user lets it in by
 * typing the 6-digit code shown on the server or by approving it from a device
 * that is already signed in; or the device scans a one-time QR.
 *
 * Pure logic over an injected clock: no sockets. websocket.ts wires the
 * unauthenticated `pair_*` messages to it and delivers results to the waiting
 * requester's socket (`deliver`).
 *
 * Limits (PAIRING_LIMITS): 6-digit code, 2-minute expiry, 5 wrong codes per
 * request then locked; 10 pending requests daemon-wide, 3 per IP, 10 new
 * requests per IP per 10 min; per-IP exponential backoff after wrong codes / bad
 * OTPs (2^n s, cap 5 min, forgotten after 15 quiet minutes); 50 wrong codes
 * daemon-wide within 10 min suspends code pairing for 10 min. QR one-time
 * secrets: 256 bits, 10 minutes, single use, at most 5 outstanding (stored as
 * SHA-256 only). Code pairing is refused from public networks unless allowed.
 */
import * as crypto from 'crypto';
import { safeEqual, sha256Hex, WindowLimiter } from '../herald/trigger';
import {
  cleanDeviceName,
  DeviceInfo,
  DevicePlatform,
  DeviceRegistry,
  normalizePlatform,
} from './registry';

export const PAIRING_LIMITS = {
  codeTtlMs: 2 * 60_000,
  maxAttemptsPerRequest: 5,
  maxPending: 10,
  maxPendingPerIp: 3,
  requestsPerIp: 10,
  requestsWindowMs: 10 * 60_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 5 * 60_000,
  backoffForgetMs: 15 * 60_000,
  globalFailures: 50,
  globalWindowMs: 10 * 60_000,
  globalSuspendMs: 10 * 60_000,
  qrTtlMs: 10 * 60_000,
  maxQr: 5,
  maxNonceLength: 64,
};

export type PairingNetwork = 'local' | 'lan' | 'tailnet' | 'home' | 'public';

export type PairErrorCode =
  | 'pairing_disabled'
  | 'untrusted_network'
  | 'too_many_pending'
  | 'rate_limited'
  | 'suspended'
  | 'bad_request'
  | 'unknown_request'
  | 'not_pending'
  | 'expired'
  | 'bad_code'
  | 'locked'
  | 'bad_otp'
  | 'registry_error';

export type PairResult =
  | {
      status: 'approved';
      pairingId?: string;
      token: string;
      deviceId: string;
      deviceName: string;
      daemonId: string;
      daemonName: string;
      publicNonce?: string;
      via: 'code' | 'approval' | 'qr' | 'upgrade';
    }
  | { status: 'denied' | 'expired' | 'locked' | 'cancelled'; pairingId: string };

export type PairFailure = {
  ok: false;
  code: PairErrorCode;
  error: string;
  retryAfterMs?: number;
  attemptsLeft?: number;
};

/** What signed-in clients and the CLI see about a waiting request. */
export interface PendingPairing {
  pairingId: string;
  deviceName: string;
  platform: DevicePlatform;
  code: string;
  addr: string;
  network: PairingNetwork;
  createdAt: number;
  expiresAt: number;
}

interface PendingRecord extends PendingPairing {
  clientId: string;
  publicNonce: string;
  attempts: number;
}

interface IpState {
  failures: number;
  nextAllowedAt: number;
  lastFailureAt: number;
}

export type PairAuditAction =
  | 'pair_request'
  | 'pair_confirm'
  | 'pair_approve'
  | 'pair_deny'
  | 'pair_expire'
  | 'pair_qr_create'
  | 'pair_qr_redeem'
  | 'device_upgrade';

export interface PairingManagerOptions {
  registry: DeviceRegistry;
  daemon: () => { id: string; name: string };
  enabled: () => boolean;
  allowPublic: () => boolean;
  /** Send a result to the requester's socket. */
  deliver: (clientId: string, result: PairResult) => void;
  /** The pending list changed (broadcast it). */
  onChange: (pending: PendingPairing[]) => void;
  audit: (
    action: PairAuditAction,
    info: { addr?: string; clientId?: string; by?: string; [k: string]: unknown },
    ok: boolean
  ) => void;
  now?: () => number;
  randomCode?: () => string;
  log?: (msg: string) => void;
}

function sixDigits(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export class PairingManager {
  private pending = new Map<string, PendingRecord>();
  private qr = new Map<string, { expiresAt: number; createdAt: number }>();
  private ips = new Map<string, IpState>();
  private globalFailures: number[] = [];
  private suspendedUntil = 0;
  private readonly requestLimiter: WindowLimiter;
  private readonly now: () => number;
  private readonly code: () => string;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: PairingManagerOptions) {
    this.now = opts.now ?? Date.now;
    this.code = opts.randomCode ?? sixDigits;
    this.log = opts.log ?? ((m) => console.log(m));
    this.requestLimiter = new WindowLimiter(
      PAIRING_LIMITS.requestsPerIp,
      PAIRING_LIMITS.requestsWindowMs,
      this.now
    );
  }

  // ------------------------------------------------------------ helpers

  private fail(code: PairErrorCode, error: string, extra: Partial<PairFailure> = {}): PairFailure {
    return { ok: false, code, error, ...extra };
  }

  private view(r: PendingRecord): PendingPairing {
    return {
      pairingId: r.pairingId,
      deviceName: r.deviceName,
      platform: r.platform,
      code: r.code,
      addr: r.addr,
      network: r.network,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
    };
  }

  private changed(): void {
    this.opts.onChange(this.list());
  }

  /** ms the IP must still wait after earlier failures (0 = go). */
  private backoff(addr: string): number {
    const st = this.ips.get(addr);
    if (!st) return 0;
    const now = this.now();
    if (now - st.lastFailureAt > PAIRING_LIMITS.backoffForgetMs) {
      this.ips.delete(addr);
      return 0;
    }
    return Math.max(0, st.nextAllowedAt - now);
  }

  private recordFailure(addr: string, countGlobal: boolean): void {
    const now = this.now();
    const st = this.ips.get(addr) ?? { failures: 0, nextAllowedAt: 0, lastFailureAt: 0 };
    st.failures += 1;
    st.lastFailureAt = now;
    st.nextAllowedAt =
      now +
      Math.min(PAIRING_LIMITS.backoffBaseMs * 2 ** (st.failures - 1), PAIRING_LIMITS.backoffMaxMs);
    this.ips.set(addr, st);
    if (this.ips.size > 1000) {
      const oldest = this.ips.keys().next().value;
      if (oldest !== undefined) this.ips.delete(oldest);
    }
    if (!countGlobal) return;
    this.globalFailures.push(now);
    const cutoff = now - PAIRING_LIMITS.globalWindowMs;
    while (this.globalFailures.length && this.globalFailures[0] <= cutoff)
      this.globalFailures.shift();
    if (this.globalFailures.length >= PAIRING_LIMITS.globalFailures) {
      this.suspendedUntil = now + PAIRING_LIMITS.globalSuspendMs;
      this.globalFailures = [];
      this.log(
        `Pairing: ${PAIRING_LIMITS.globalFailures} wrong codes in 10 min - code pairing suspended for 10 min`
      );
      for (const r of Array.from(this.pending.values())) this.finish(r, 'locked');
    }
  }

  private finish(r: PendingRecord, status: 'denied' | 'expired' | 'locked' | 'cancelled'): void {
    if (!this.pending.delete(r.pairingId)) return;
    if (status !== 'cancelled') this.opts.deliver(r.clientId, { status, pairingId: r.pairingId });
    this.changed();
  }

  private issue(
    r: { deviceName: string; platform: DevicePlatform; publicNonce?: string; pairingId?: string },
    via: 'code' | 'approval' | 'qr' | 'upgrade'
  ): PairResult | null {
    let created: { device: DeviceInfo; token: string };
    try {
      created = this.opts.registry.create({ name: r.deviceName, platform: r.platform, via });
    } catch (err) {
      this.log(`Pairing: could not register device: ${(err as Error).message}`);
      return null;
    }
    const d = this.opts.daemon();
    return {
      status: 'approved',
      ...(r.pairingId ? { pairingId: r.pairingId } : {}),
      token: created.token,
      deviceId: created.device.id,
      deviceName: created.device.name,
      daemonId: d.id,
      daemonName: d.name,
      ...(r.publicNonce ? { publicNonce: r.publicNonce } : {}),
      via,
    };
  }

  // ------------------------------------------------------------ public API

  /** Drop expired requests and QR secrets. */
  sweep(): void {
    const now = this.now();
    for (const r of Array.from(this.pending.values())) {
      if (r.expiresAt <= now) {
        this.opts.audit(
          'pair_expire',
          { addr: r.addr, pairingId: r.pairingId, deviceName: r.deviceName },
          true
        );
        this.finish(r, 'expired');
      }
    }
    for (const [h, q] of this.qr) if (q.expiresAt <= now) this.qr.delete(h);
    this.requestLimiter.prune();
  }

  list(): PendingPairing[] {
    return Array.from(this.pending.values())
      .filter((r) => r.expiresAt > this.now())
      .map((r) => this.view(r));
  }

  /** The requester's socket closed: its requests go away silently. */
  clientGone(clientId: string): void {
    for (const r of Array.from(this.pending.values())) {
      if (r.clientId === clientId) this.finish(r, 'cancelled');
    }
  }

  request(input: {
    clientId: string;
    addr: string;
    network: PairingNetwork;
    deviceName: unknown;
    platform: unknown;
    publicNonce: unknown;
  }): { ok: true; pairingId: string; expiresAt: number } | PairFailure {
    this.sweep();
    const audit = (ok: boolean, extra: Record<string, unknown> = {}) =>
      this.opts.audit(
        'pair_request',
        { addr: input.addr, clientId: input.clientId, network: input.network, ...extra },
        ok
      );
    if (!this.opts.enabled()) {
      audit(false, { reason: 'pairing_disabled' });
      return this.fail('pairing_disabled', 'Pairing is turned off on this server');
    }
    if ((input.network === 'public' || input.network === 'home') && !this.opts.allowPublic()) {
      audit(false, { reason: 'untrusted_network' });
      return this.fail(
        'untrusted_network',
        'Pairing by code only works on your local network or tailnet. Use a pairing QR instead.'
      );
    }
    const now = this.now();
    if (this.suspendedUntil > now) {
      return this.fail('suspended', 'Pairing is paused after too many wrong codes', {
        retryAfterMs: this.suspendedUntil - now,
      });
    }
    const name = cleanDeviceName(input.deviceName);
    const nonce = typeof input.publicNonce === 'string' ? input.publicNonce : '';
    if (
      !name ||
      !nonce ||
      nonce.length > PAIRING_LIMITS.maxNonceLength ||
      !/^[\w-]+$/.test(nonce)
    ) {
      return this.fail('bad_request', 'deviceName and publicNonce are required');
    }
    const wait = this.backoff(input.addr);
    if (wait > 0) {
      return this.fail('rate_limited', 'Too many attempts, wait a moment', { retryAfterMs: wait });
    }
    const perIp = Array.from(this.pending.values()).filter((r) => r.addr === input.addr).length;
    if (this.pending.size >= PAIRING_LIMITS.maxPending || perIp >= PAIRING_LIMITS.maxPendingPerIp) {
      audit(false, { reason: 'too_many_pending' });
      return this.fail('too_many_pending', 'Too many pairing requests are waiting');
    }
    const retry = this.requestLimiter.take(input.addr);
    if (retry !== null) {
      audit(false, { reason: 'rate_limited' });
      return this.fail('rate_limited', 'Too many pairing requests', { retryAfterMs: retry });
    }
    // One live request per socket: a new one replaces the old.
    for (const r of Array.from(this.pending.values())) {
      if (r.clientId === input.clientId) this.finish(r, 'cancelled');
    }
    const rec: PendingRecord = {
      pairingId: crypto.randomBytes(12).toString('base64url'),
      deviceName: name,
      platform: normalizePlatform(input.platform),
      code: this.code(),
      addr: input.addr,
      network: input.network,
      createdAt: now,
      expiresAt: now + PAIRING_LIMITS.codeTtlMs,
      clientId: input.clientId,
      publicNonce: nonce,
      attempts: 0,
    };
    this.pending.set(rec.pairingId, rec);
    this.log(
      `Pairing: "${rec.deviceName}" (${rec.platform}, ${rec.addr}) wants to pair - code ${rec.code} (expires in 2 min; approve in the app or with: companion pair)`
    );
    audit(true, { pairingId: rec.pairingId, deviceName: rec.deviceName, platform: rec.platform });
    this.changed();
    return { ok: true, pairingId: rec.pairingId, expiresAt: rec.expiresAt };
  }

  confirm(input: {
    clientId: string;
    addr: string;
    pairingId: unknown;
    code: unknown;
  }): { ok: true; result: PairResult } | PairFailure {
    this.sweep();
    const audit = (ok: boolean, extra: Record<string, unknown>) =>
      this.opts.audit('pair_confirm', { addr: input.addr, clientId: input.clientId, ...extra }, ok);
    const wait = this.backoff(input.addr);
    if (wait > 0) {
      return this.fail('rate_limited', 'Too many wrong codes, wait a moment', {
        retryAfterMs: wait,
      });
    }
    const r = typeof input.pairingId === 'string' ? this.pending.get(input.pairingId) : undefined;
    // Only the socket that asked may answer: a pairingId alone is not enough.
    if (!r || r.clientId !== input.clientId) {
      audit(false, { reason: 'unknown_request' });
      return this.fail('unknown_request', 'No such pairing request (it may have expired)');
    }
    const code = typeof input.code === 'string' ? input.code.replace(/\s+/g, '') : '';
    if (/^\d{6}$/.test(code) && safeEqual(code, r.code)) {
      const result = this.issue(r, 'code');
      if (!result) return this.fail('registry_error', 'Could not save the device');
      this.pending.delete(r.pairingId);
      audit(true, {
        pairingId: r.pairingId,
        deviceName: r.deviceName,
        deviceId: result.status === 'approved' ? result.deviceId : undefined,
      });
      this.log(`Pairing: "${r.deviceName}" paired with the code`);
      this.changed();
      return { ok: true, result };
    }
    r.attempts += 1;
    this.recordFailure(input.addr, true);
    const left = PAIRING_LIMITS.maxAttemptsPerRequest - r.attempts;
    audit(false, { reason: 'bad_code', pairingId: r.pairingId, attemptsLeft: Math.max(0, left) });
    if (left <= 0 || !this.pending.has(r.pairingId)) {
      this.log(`Pairing: "${r.deviceName}" locked out after ${r.attempts} wrong codes`);
      this.finish(r, 'locked');
      return this.fail('locked', 'Too many wrong codes. Start pairing again.');
    }
    return this.fail('bad_code', 'Wrong code', { attemptsLeft: left });
  }

  /** A signed-in user lets the request in. */
  approve(
    pairingId: unknown,
    by: { clientId?: string; addr?: string; label: string }
  ): { ok: true; deviceId: string } | PairFailure {
    this.sweep();
    const r = typeof pairingId === 'string' ? this.pending.get(pairingId) : undefined;
    if (!r) {
      this.opts.audit('pair_approve', { ...by, by: by.label, reason: 'not_pending' }, false);
      return this.fail('not_pending', 'That request is no longer waiting');
    }
    const result = this.issue(r, 'approval');
    if (!result || result.status !== 'approved') {
      return this.fail('registry_error', 'Could not save the device');
    }
    this.pending.delete(r.pairingId);
    this.opts.deliver(r.clientId, result);
    this.opts.audit(
      'pair_approve',
      {
        ...by,
        by: by.label,
        pairingId: r.pairingId,
        deviceName: r.deviceName,
        deviceId: result.deviceId,
      },
      true
    );
    this.log(`Pairing: "${r.deviceName}" approved by ${by.label}`);
    this.changed();
    return { ok: true, deviceId: result.deviceId };
  }

  deny(
    pairingId: unknown,
    by: { clientId?: string; addr?: string; label: string }
  ): { ok: true } | PairFailure {
    this.sweep();
    const r = typeof pairingId === 'string' ? this.pending.get(pairingId) : undefined;
    if (!r) {
      this.opts.audit('pair_deny', { ...by, by: by.label, reason: 'not_pending' }, false);
      return this.fail('not_pending', 'That request is no longer waiting');
    }
    this.opts.audit(
      'pair_deny',
      { ...by, by: by.label, pairingId: r.pairingId, deviceName: r.deviceName },
      true
    );
    this.log(`Pairing: "${r.deviceName}" denied by ${by.label}`);
    this.finish(r, 'denied');
    return { ok: true };
  }

  /** A one-time QR secret (returned once; only its hash is kept). */
  createQr(by: {
    clientId?: string;
    addr?: string;
    label: string;
  }): { ok: true; otp: string; expiresAt: number } | PairFailure {
    this.sweep();
    if (!this.opts.enabled())
      return this.fail('pairing_disabled', 'Pairing is turned off on this server');
    while (this.qr.size >= PAIRING_LIMITS.maxQr) {
      // Oldest first (Map keeps insertion order): a new QR retires the oldest.
      const oldest = this.qr.keys().next().value;
      if (oldest === undefined) break;
      this.qr.delete(oldest);
    }
    const otp = crypto.randomBytes(32).toString('base64url');
    const now = this.now();
    const expiresAt = now + PAIRING_LIMITS.qrTtlMs;
    this.qr.set(sha256Hex(otp), { createdAt: now, expiresAt });
    this.opts.audit('pair_qr_create', { ...by, by: by.label, expiresAt }, true);
    return { ok: true, otp, expiresAt };
  }

  redeemQr(input: {
    clientId: string;
    addr: string;
    otp: unknown;
    deviceName: unknown;
    platform: unknown;
  }): { ok: true; result: PairResult } | PairFailure {
    this.sweep();
    const audit = (ok: boolean, extra: Record<string, unknown>) =>
      this.opts.audit(
        'pair_qr_redeem',
        { addr: input.addr, clientId: input.clientId, ...extra },
        ok
      );
    if (!this.opts.enabled())
      return this.fail('pairing_disabled', 'Pairing is turned off on this server');
    const wait = this.backoff(input.addr);
    if (wait > 0)
      return this.fail('rate_limited', 'Too many attempts, wait a moment', { retryAfterMs: wait });
    const otp = typeof input.otp === 'string' && input.otp.length <= 100 ? input.otp : '';
    const key = otp ? sha256Hex(otp) : '';
    const entry = key ? this.qr.get(key) : undefined;
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) this.qr.delete(key);
      this.recordFailure(input.addr, false);
      audit(false, { reason: 'bad_otp' });
      return this.fail('bad_otp', 'This pairing QR has expired or was already used');
    }
    this.qr.delete(key); // single use, even if the registry write fails below
    const name = cleanDeviceName(input.deviceName) || 'Unnamed device';
    const result = this.issue(
      { deviceName: name, platform: normalizePlatform(input.platform) },
      'qr'
    );
    if (!result || result.status !== 'approved')
      return this.fail('registry_error', 'Could not save the device');
    audit(true, { deviceName: name, deviceId: result.deviceId });
    this.log(`Pairing: "${name}" paired with a QR code`);
    return { ok: true, result };
  }

  /** A legacy-token client trades up to its own device token. */
  upgrade(input: {
    clientId: string;
    addr: string;
    deviceName: unknown;
    platform: unknown;
  }): { ok: true; result: PairResult } | PairFailure {
    const name = cleanDeviceName(input.deviceName) || 'Unnamed device';
    const result = this.issue(
      { deviceName: name, platform: normalizePlatform(input.platform) },
      'upgrade'
    );
    if (!result || result.status !== 'approved')
      return this.fail('registry_error', 'Could not save the device');
    this.opts.audit(
      'device_upgrade',
      { addr: input.addr, clientId: input.clientId, deviceName: name, deviceId: result.deviceId },
      true
    );
    return { ok: true, result };
  }
}
