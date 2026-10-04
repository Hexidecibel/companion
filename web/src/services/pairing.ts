/**
 * Pairing a new device with a daemon (the daemon side is daemon/src/pairing/).
 *
 *   Code:     pair_request -> the user types the 6-digit code shown on the
 *             server (pair_confirm), or approves this device from another one
 *             (the daemon pushes pair_result).
 *   QR/link:  companion://pair?host&port&tls&id&name&otp -> pair_redeem_qr.
 *   Upgrade:  a client signed in with the old server token asks for its own
 *             device token (device_upgrade, see DevicesSettings).
 *
 * The device token arrives once and is stored on the Server entry like the old
 * token was.
 */
import type { Server } from '../types';
import { nativePlatform } from '../utils/platform';

export type PairPlatform = 'android' | 'ios' | 'desktop' | 'web';

export interface PairTarget {
  host: string;
  port: number;
  tls: boolean;
}

export interface PairLink extends PairTarget {
  otp: string;
  daemonId?: string;
  name?: string;
}

export interface DaemonHello {
  daemonId: string;
  name: string;
  version: string;
  pairing: boolean;
  codePairing: boolean;
  /** Present only on a fresh daemon (first-run setup), to trusted networks. */
  setupMode?: boolean;
  /** This connection may pair without a code (a browser on the server itself, first device). */
  localAutoPair?: boolean;
  /** Setup mode only: the daemon runs in Docker (the code is in `docker compose logs`). */
  container?: boolean;
}

export interface PairOutcome {
  token: string;
  deviceId: string;
  deviceName: string;
  daemonId: string;
  daemonName: string;
}

export type PairPhase =
  | 'idle'
  | 'connecting'
  | 'waiting'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'locked'
  | 'error';

export interface PairState {
  phase: PairPhase;
  error?: string;
  attemptsLeft?: number;
  expiresAt?: number;
  outcome?: PairOutcome;
}

/** A pending request as signed-in clients see it (pair_pending). */
export interface PendingPairing {
  pairingId: string;
  deviceName: string;
  platform: string;
  code: string;
  addr: string;
  network: string;
  createdAt: number;
  expiresAt: number;
}

const HOST_RE = /^[A-Za-z0-9.\-:[\]_]{1,253}$/;
const OTP_RE = /^[A-Za-z0-9_-]{20,100}$/;
const ID_RE = /^[0-9a-f]{32}$/;

/** Parse a `companion://pair?...` link; null when it is not a valid one. */
export function parsePairLink(input: string): PairLink | null {
  const raw = (input || '').trim();
  if (!/^companion:\/\/pair\b/i.test(raw)) return null;
  let url: URL;
  try {
    // URL() handles custom schemes inconsistently across engines: parse the query ourselves.
    url = new URL(raw.replace(/^companion:\/\/pair\/?/i, 'https://pair.invalid/'));
  } catch {
    return null;
  }
  const q = url.searchParams;
  const host = (q.get('host') || '').trim();
  const port = Number(q.get('port'));
  const otp = q.get('otp') || '';
  const tlsRaw = q.get('tls');
  if (!HOST_RE.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!OTP_RE.test(otp)) return null;
  const id = q.get('id') || '';
  const name = (q.get('name') || '').trim().slice(0, 60);
  return {
    host,
    port,
    tls: tlsRaw === '1' || tlsRaw === 'true',
    otp,
    ...(ID_RE.test(id) ? { daemonId: id } : {}),
    ...(name ? { name } : {}),
  };
}

export function pairingPlatform(): PairPlatform {
  const p = nativePlatform();
  return p === 'browser' ? 'web' : p;
}

/** A sensible default name for this device (the user can edit it). */
export function guessDeviceName(platform: PairPlatform = pairingPlatform()): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const os = /Android/i.test(ua)
    ? 'Android'
    : /iPad/i.test(ua)
      ? 'iPad'
      : /iPhone/i.test(ua)
        ? 'iPhone'
        : /Mac/i.test(ua)
          ? 'Mac'
          : /Windows/i.test(ua)
            ? 'Windows'
            : /Linux/i.test(ua)
              ? 'Linux'
              : '';
  switch (platform) {
    case 'android':
      return 'Android phone';
    case 'ios':
      return os === 'iPad' ? 'iPad' : 'iPhone';
    case 'desktop':
      return os ? `${os} desktop` : 'Desktop app';
    default: {
      const browser = /Firefox/i.test(ua) ? 'Firefox' : /Edg\//i.test(ua) ? 'Edge' : /Chrome/i.test(ua) ? 'Chrome' : /Safari/i.test(ua) ? 'Safari' : 'Browser';
      return os ? `${browser} on ${os}` : browser;
    }
  }
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function wsUrl(t: PairTarget): string {
  const host = t.host.includes(':') && !t.host.startsWith('[') ? `[${t.host}]` : t.host;
  return `${t.tls ? 'wss' : 'ws'}://${host}:${t.port}`;
}

const FRIENDLY: Record<string, string> = {
  untrusted_network:
    'This server only pairs by code on its local network or tailnet. Show a pairing QR on a signed-in device instead.',
  pairing_disabled: 'Pairing is turned off on this server.',
  too_many_pending: 'Too many devices are waiting to pair. Try again in a couple of minutes.',
  rate_limited: 'Too many attempts. Wait a moment and try again.',
  suspended: 'Pairing is paused on this server after too many wrong codes. Try again later.',
  bad_otp: 'This pairing QR has expired or was already used. Make a new one.',
  locked: 'Too many wrong codes. Start again.',
  unknown_request: 'This pairing request has expired. Start again.',
};

export function friendlyPairError(code: string | undefined, fallback?: string): string {
  return (code && FRIENDLY[code]) || fallback || 'Pairing failed';
}

type Resp = { type: string; success: boolean; payload?: any; error?: string; requestId?: string };

/** One pairing attempt over its own (unauthenticated) socket. */
export class PairingClient {
  private ws: WebSocket | null = null;
  private n = 0;
  private waiters = new Map<string, (r: Resp) => void>();
  private opened: Promise<void> | null = null;
  private pairingId: string | null = null;
  private nonce = randomNonce();
  state: PairState = { phase: 'idle' };

  constructor(
    readonly target: PairTarget,
    private readonly onUpdate: (s: PairState) => void = () => {},
    private readonly WS: typeof WebSocket = WebSocket,
  ) {}

  private set(s: PairState): void {
    this.state = s;
    this.onUpdate(s);
  }

  private open(): Promise<void> {
    if (this.opened) return this.opened;
    this.opened = new Promise<void>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new this.WS(wsUrl(this.target));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('Could not reach the server')), 8000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Could not reach the server'));
      };
      ws.onclose = () => {
        if (this.state.phase === 'waiting') this.set({ phase: 'error', error: 'Lost the connection to the server' });
        for (const w of this.waiters.values()) w({ type: 'error', success: false, error: 'Connection closed' });
        this.waiters.clear();
      };
      ws.onmessage = (ev) => this.onMessage(ev.data);
    });
    return this.opened;
  }

  private onMessage(data: unknown): void {
    let m: Resp;
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    if (m.requestId && this.waiters.has(m.requestId)) {
      const w = this.waiters.get(m.requestId)!;
      this.waiters.delete(m.requestId);
      w(m);
      return;
    }
    if (m.type === 'pair_result' && m.payload && m.payload.pairingId === this.pairingId) {
      this.applyResult(m.payload);
    }
  }

  private applyResult(p: any): void {
    if (p.status === 'approved') {
      if (p.publicNonce && p.publicNonce !== this.nonce) return; // not our request
      this.set({
        phase: 'approved',
        outcome: {
          token: p.token,
          deviceId: p.deviceId,
          deviceName: p.deviceName,
          daemonId: p.daemonId,
          daemonName: p.daemonName,
        },
      });
      this.close();
    } else if (p.status === 'denied') {
      this.set({ phase: 'denied', error: 'The request was denied.' });
      this.close();
    } else if (p.status === 'expired') {
      this.set({ phase: 'expired', error: 'The request expired. Start again.' });
      this.close();
    } else if (p.status === 'locked') {
      this.set({ phase: 'locked', error: friendlyPairError('locked') });
      this.close();
    }
  }

  private async request(type: string, payload?: unknown): Promise<Resp> {
    await this.open();
    const requestId = `pair_${++this.n}`;
    return new Promise<Resp>((resolve) => {
      const t = setTimeout(() => {
        this.waiters.delete(requestId);
        resolve({ type, success: false, error: 'The server did not answer' });
      }, 10_000);
      this.waiters.set(requestId, (r) => {
        clearTimeout(t);
        resolve(r);
      });
      this.ws!.send(JSON.stringify({ type, payload, requestId }));
    });
  }

  async hello(): Promise<DaemonHello> {
    const r = await this.request('pair_hello');
    if (!r.success) throw new Error(r.error || 'This server does not support pairing (update it)');
    return r.payload as DaemonHello;
  }

  /** Ask to pair; then confirm(code) or wait for an approval. */
  async start(deviceName: string, platform: PairPlatform = pairingPlatform()): Promise<PairState> {
    this.set({ phase: 'connecting' });
    try {
      const r = await this.request('pair_request', { deviceName, platform, publicNonce: this.nonce });
      if (!r.success) {
        const code = r.payload?.code as string | undefined;
        const unknownType = /Unknown message type|Not authenticated/i.test(r.error || '');
        this.set({
          phase: 'error',
          error: unknownType ? 'This server is too old to pair. Update it, or enter the token manually.' : friendlyPairError(code, r.error),
        });
        return this.state;
      }
      this.pairingId = r.payload.pairingId;
      this.set({ phase: 'waiting', expiresAt: r.payload.expiresAt });
    } catch (err) {
      this.set({ phase: 'error', error: (err as Error).message });
    }
    return this.state;
  }

  async confirm(code: string): Promise<PairState> {
    if (!this.pairingId) return this.state;
    const r = await this.request('pair_confirm', { pairingId: this.pairingId, code: code.replace(/\D/g, '') });
    if (r.success) {
      this.applyResult(r.payload);
      return this.state;
    }
    const c = r.payload?.code as string | undefined;
    if (c === 'bad_code') {
      this.set({ ...this.state, phase: 'waiting', error: 'Wrong code', attemptsLeft: r.payload?.attemptsLeft });
    } else if (c === 'rate_limited') {
      this.set({ ...this.state, phase: 'waiting', error: friendlyPairError(c) });
    } else {
      this.set({ phase: c === 'locked' ? 'locked' : 'error', error: friendlyPairError(c, r.error) });
      this.close();
    }
    return this.state;
  }

  async redeem(link: PairLink, deviceName: string, platform: PairPlatform = pairingPlatform()): Promise<PairState> {
    this.set({ phase: 'connecting' });
    try {
      const r = await this.request('pair_redeem_qr', { otp: link.otp, deviceName, platform });
      if (r.success) this.applyResult(r.payload);
      else this.set({ phase: 'error', error: friendlyPairError(r.payload?.code, r.error) });
    } catch (err) {
      this.set({ phase: 'error', error: (err as Error).message });
    }
    this.close();
    return this.state;
  }

  /** First-run only: pair a browser on the server itself without a code (setup_pair_local). */
  async pairLocal(deviceName: string, platform: PairPlatform = pairingPlatform()): Promise<PairState> {
    this.set({ phase: 'connecting' });
    try {
      const r = await this.request('setup_pair_local', { deviceName, platform });
      if (r.success) {
        this.pairingId = 'local';
        this.applyResult({ ...r.payload, pairingId: 'local' });
      } else {
        this.set({ phase: 'error', error: r.error || 'Automatic pairing is not available here' });
      }
    } catch (err) {
      this.set({ phase: 'error', error: (err as Error).message });
    }
    this.close();
    return this.state;
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/** The Server entry a successful pairing produces (replaces one for the same daemon/address). */
export function serverFromPairing(
  target: PairTarget,
  outcome: PairOutcome,
  existing: Server[],
  newId: () => string = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
): Server {
  const prev =
    existing.find((s) => s.daemonId && s.daemonId === outcome.daemonId) ||
    existing.find((s) => s.host === target.host && s.port === target.port);
  return {
    ...(prev || {}),
    id: prev?.id || newId(),
    name: prev?.name || outcome.daemonName || target.host,
    host: target.host,
    port: target.port,
    useTls: target.tls,
    token: outcome.token,
    enabled: true,
    daemonId: outcome.daemonId,
    deviceId: outcome.deviceId,
    authKind: 'device',
  };
}
