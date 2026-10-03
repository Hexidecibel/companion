import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DeviceRegistry } from '../src/pairing/registry';
import { PairingManager, PAIRING_LIMITS, PairResult, PendingPairing } from '../src/pairing/manager';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-manager-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

let n = 0;
function setup(over: { enabled?: boolean; allowPublic?: boolean } = {}) {
  let t = 1_000_000;
  let codeSeq = 0;
  const registry = new DeviceRegistry(path.join(dir, `r${++n}`, 'devices.json'), () => t);
  const delivered: Array<{ clientId: string; result: PairResult }> = [];
  const changes: PendingPairing[][] = [];
  const audits: Array<{ action: string; ok: boolean; info: Record<string, unknown> }> = [];
  const m = new PairingManager({
    registry,
    daemon: () => ({ id: 'd'.repeat(32), name: 'Companion test' }),
    enabled: () => over.enabled !== false,
    allowPublic: () => over.allowPublic === true,
    deliver: (clientId, result) => delivered.push({ clientId, result }),
    onChange: (p) => changes.push(p),
    audit: (action, info, ok) => audits.push({ action, info, ok }),
    now: () => t,
    randomCode: () => String(123456 + codeSeq++),
    log: () => {},
  });
  const req = (clientId = 'c1', addr = '192.168.1.20', network: any = 'lan') =>
    m.request({
      clientId,
      addr,
      network,
      deviceName: 'Pixel',
      platform: 'android',
      publicNonce: 'nonce1',
    });
  return {
    m,
    registry,
    delivered,
    changes,
    audits,
    req,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('PairingManager: code flow', () => {
  it('issues a token once for the right code from the requesting socket', () => {
    const s = setup();
    const r = s.req();
    if (!r.ok) throw new Error('request failed');
    expect(s.m.list()[0]).toMatchObject({
      deviceName: 'Pixel',
      code: '123456',
      platform: 'android',
    });
    expect(s.changes.length).toBe(1);

    // Another socket cannot answer for it, even with the right code.
    const stolen = s.m.confirm({
      clientId: 'c2',
      addr: '192.168.1.21',
      pairingId: r.pairingId,
      code: '123456',
    });
    expect(stolen).toMatchObject({ ok: false, code: 'unknown_request' });

    const ok = s.m.confirm({
      clientId: 'c1',
      addr: '192.168.1.20',
      pairingId: r.pairingId,
      code: '123 456',
    });
    if (!ok.ok || ok.result.status !== 'approved') throw new Error('confirm failed');
    expect(ok.result.publicNonce).toBe('nonce1');
    expect(ok.result.daemonId).toBe('d'.repeat(32));
    expect(s.registry.verify(ok.result.token)?.name).toBe('Pixel');
    expect(s.m.list()).toEqual([]);
    // Single use.
    expect(
      s.m.confirm({ clientId: 'c1', addr: '192.168.1.20', pairingId: r.pairingId, code: '123456' })
        .ok
    ).toBe(false);
    // Audit never carries the code or token.
    expect(JSON.stringify(s.audits)).not.toContain('123456');
    expect(JSON.stringify(s.audits)).not.toContain(ok.result.token);
  });

  it('locks after 5 wrong codes and tells the requester', () => {
    const s = setup();
    const r = s.req();
    if (!r.ok) throw new Error();
    let last: any;
    for (let i = 0; i < PAIRING_LIMITS.maxAttemptsPerRequest; i++) {
      s.advance(20_000); // past the backoff (<= 8 s here), inside the 2-minute TTL
      last = s.m.confirm({
        clientId: 'c1',
        addr: '192.168.1.20',
        pairingId: r.pairingId,
        code: '000000',
      });
      if (i < 4) expect(last).toMatchObject({ code: 'bad_code', attemptsLeft: 4 - i });
    }
    expect(last).toMatchObject({ ok: false, code: 'locked' });
    expect(s.delivered.at(-1)).toEqual({
      clientId: 'c1',
      result: { status: 'locked', pairingId: r.pairingId },
    });
    expect(s.m.list()).toEqual([]);
  });

  it('backs off exponentially per IP after wrong codes', () => {
    const s = setup();
    const r = s.req();
    if (!r.ok) throw new Error();
    const c = (code: string) =>
      s.m.confirm({ clientId: 'c1', addr: '192.168.1.20', pairingId: r.pairingId, code });
    expect(c('000000')).toMatchObject({ code: 'bad_code' });
    expect(c('123456')).toMatchObject({ code: 'rate_limited' }); // even the right code waits
    s.advance(1_000);
    expect(c('000001')).toMatchObject({ code: 'bad_code' });
    s.advance(1_000);
    expect(c('123456')).toMatchObject({ code: 'rate_limited', retryAfterMs: 1_000 }); // 2 s now
    s.advance(1_000);
    expect(c('123456').ok).toBe(true);
  });

  it('expires after 2 minutes', () => {
    const s = setup();
    const r = s.req();
    if (!r.ok) throw new Error();
    s.advance(PAIRING_LIMITS.codeTtlMs + 1);
    s.m.sweep();
    expect(s.delivered).toEqual([
      { clientId: 'c1', result: { status: 'expired', pairingId: r.pairingId } },
    ]);
    expect(
      s.m.confirm({ clientId: 'c1', addr: '192.168.1.20', pairingId: r.pairingId, code: '123456' })
    ).toMatchObject({
      code: 'unknown_request',
    });
  });

  it('caps pending per IP, globally, and requests per IP per window', () => {
    const s = setup();
    for (let i = 0; i < 3; i++) expect(s.req(`a${i}`, '10.0.0.1').ok).toBe(true);
    expect(s.req('a4', '10.0.0.1')).toMatchObject({ code: 'too_many_pending' });
    for (let i = 0; i < 7; i++) expect(s.req(`b${i}`, `10.0.1.${i}`).ok).toBe(true);
    expect(s.m.list()).toHaveLength(PAIRING_LIMITS.maxPending);
    expect(s.req('z', '10.0.2.1')).toMatchObject({ code: 'too_many_pending' });

    const t = setup();
    for (let i = 0; i < PAIRING_LIMITS.requestsPerIp; i++) {
      // Same socket: each new request replaces the previous one.
      expect(t.req('same', '10.9.9.9').ok).toBe(true);
    }
    expect(t.req('same', '10.9.9.9')).toMatchObject({ code: 'rate_limited' });
    expect(t.m.list()).toHaveLength(1);
  });

  it('refuses public networks unless allowed, and honours pairing:false', () => {
    expect(setup().req('c', '8.8.8.8', 'public')).toMatchObject({ code: 'untrusted_network' });
    expect(setup({ allowPublic: true }).req('c', '8.8.8.8', 'public').ok).toBe(true);
    expect(setup().req('c', '100.100.1.1', 'tailnet').ok).toBe(true);
    expect(setup().req('c', '127.0.0.1', 'local').ok).toBe(true);
    expect(setup({ enabled: false }).req()).toMatchObject({ code: 'pairing_disabled' });
  });

  it('validates the request fields', () => {
    const s = setup();
    expect(
      s.m.request({
        clientId: 'c',
        addr: '10.0.0.1',
        network: 'lan',
        deviceName: '',
        platform: 'ios',
        publicNonce: 'n',
      })
    ).toMatchObject({ code: 'bad_request' });
    expect(
      s.m.request({
        clientId: 'c',
        addr: '10.0.0.1',
        network: 'lan',
        deviceName: 'x',
        platform: 'ios',
        publicNonce: '',
      })
    ).toMatchObject({ code: 'bad_request' });
    expect(
      s.m.request({
        clientId: 'c',
        addr: '10.0.0.1',
        network: 'lan',
        deviceName: 'x',
        platform: 'ios',
        publicNonce: 'a b',
      })
    ).toMatchObject({ code: 'bad_request' });
    const ok = s.m.request({
      clientId: 'c',
      addr: '10.0.0.1',
      network: 'lan',
      deviceName: 'x',
      platform: 'toaster',
      publicNonce: 'n',
    });
    expect(ok.ok).toBe(true);
    expect(s.m.list()[0].platform).toBe('other');
  });

  it('suspends code pairing after too many wrong codes daemon-wide', () => {
    const s = setup();
    for (let i = 0; i < PAIRING_LIMITS.globalFailures; i++) {
      // A different IP and socket each time keeps per-IP limits out of the way.
      const addr = `10.1.${Math.floor(i / 200)}.${i % 200}`;
      const r = s.req(`c${i}`, addr);
      if (!r.ok) throw new Error(JSON.stringify(r));
      s.m.confirm({ clientId: `c${i}`, addr, pairingId: r.pairingId, code: '999999' });
      s.m.clientGone(`c${i}`);
    }
    expect(s.req('late', '10.2.0.1')).toMatchObject({ code: 'suspended' });
    s.advance(PAIRING_LIMITS.globalSuspendMs + 1);
    expect(s.req('later', '10.2.0.2').ok).toBe(true);
  });

  it('a closed requester socket cancels its request silently', () => {
    const s = setup();
    expect(s.req().ok).toBe(true);
    s.m.clientGone('c1');
    expect(s.m.list()).toEqual([]);
    expect(s.delivered).toEqual([]);
  });
});

describe('PairingManager: approval', () => {
  it('approve delivers the token to the waiting requester', () => {
    const s = setup();
    const r = s.req();
    if (!r.ok) throw new Error();
    const a = s.m.approve(r.pairingId, { clientId: 'admin', label: 'device x' });
    expect(a.ok).toBe(true);
    const d = s.delivered[0];
    expect(d.clientId).toBe('c1');
    if (d.result.status !== 'approved') throw new Error();
    expect(d.result.via).toBe('approval');
    expect(s.registry.verify(d.result.token)).not.toBeNull();
  });

  it('deny tells the requester and no device is made', () => {
    const s = setup();
    const r = s.req();
    if (!r.ok) throw new Error();
    expect(s.m.deny(r.pairingId, { label: 'cli' }).ok).toBe(true);
    expect(s.delivered).toEqual([
      { clientId: 'c1', result: { status: 'denied', pairingId: r.pairingId } },
    ]);
    expect(s.registry.list()).toEqual([]);
  });

  it('races: the first decision wins, the rest get not_pending / unknown_request', () => {
    const s = setup();
    const r = s.req();
    if (!r.ok) throw new Error();
    expect(s.m.approve(r.pairingId, { label: 'a' }).ok).toBe(true);
    expect(s.m.deny(r.pairingId, { label: 'b' })).toMatchObject({ code: 'not_pending' });
    expect(s.m.approve(r.pairingId, { label: 'c' })).toMatchObject({ code: 'not_pending' });
    expect(
      s.m.confirm({ clientId: 'c1', addr: '192.168.1.20', pairingId: r.pairingId, code: '123456' })
    ).toMatchObject({
      code: 'unknown_request',
    });
    expect(s.registry.list()).toHaveLength(1);

    const t = setup();
    const r2 = t.req();
    if (!r2.ok) throw new Error();
    expect(
      t.m.confirm({ clientId: 'c1', addr: '192.168.1.20', pairingId: r2.pairingId, code: '123456' })
        .ok
    ).toBe(true);
    expect(t.m.approve(r2.pairingId, { label: 'late' })).toMatchObject({ code: 'not_pending' });
    expect(t.registry.list()).toHaveLength(1);
  });

  it('cannot approve an expired request', () => {
    const s = setup();
    const r = s.req();
    if (!r.ok) throw new Error();
    s.advance(PAIRING_LIMITS.codeTtlMs + 1);
    expect(s.m.approve(r.pairingId, { label: 'a' })).toMatchObject({ code: 'not_pending' });
    expect(s.registry.list()).toEqual([]);
  });
});

describe('PairingManager: QR', () => {
  it('a QR secret is single use', () => {
    const s = setup();
    const q = s.m.createQr({ label: 'cli' });
    if (!q.ok) throw new Error();
    expect(q.otp).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const first = s.m.redeemQr({
      clientId: 'x',
      addr: '8.8.8.8',
      otp: q.otp,
      deviceName: 'Laptop',
      platform: 'desktop',
    });
    expect(first.ok).toBe(true);
    s.advance(10 * 60_000);
    const replay = s.m.redeemQr({
      clientId: 'y',
      addr: '8.8.4.4',
      otp: q.otp,
      deviceName: 'Evil',
      platform: 'desktop',
    });
    expect(replay).toMatchObject({ ok: false, code: 'bad_otp' });
    expect(s.registry.list().map((d) => d.name)).toEqual(['Laptop']);
  });

  it('expires after 10 minutes', () => {
    const s = setup();
    const q = s.m.createQr({ label: 'cli' });
    if (!q.ok) throw new Error();
    s.advance(PAIRING_LIMITS.qrTtlMs + 1);
    expect(
      s.m.redeemQr({
        clientId: 'x',
        addr: '10.0.0.1',
        otp: q.otp,
        deviceName: 'L',
        platform: 'ios',
      })
    ).toMatchObject({
      code: 'bad_otp',
    });
  });

  it('keeps at most 5 outstanding (a new one retires the oldest)', () => {
    const s = setup();
    const otps: string[] = [];
    for (let i = 0; i < 6; i++) {
      const q = s.m.createQr({ label: 'cli' });
      if (!q.ok) throw new Error();
      otps.push(q.otp);
    }
    expect(
      s.m.redeemQr({
        clientId: 'x',
        addr: '10.0.0.1',
        otp: otps[0],
        deviceName: 'L',
        platform: 'ios',
      }).ok
    ).toBe(false);
    s.advance(60_000);
    expect(
      s.m.redeemQr({
        clientId: 'x',
        addr: '10.0.0.2',
        otp: otps[5],
        deviceName: 'L',
        platform: 'ios',
      }).ok
    ).toBe(true);
  });

  it('bad OTPs back off per IP', () => {
    const s = setup();
    const q = s.m.createQr({ label: 'cli' });
    if (!q.ok) throw new Error();
    expect(
      s.m.redeemQr({
        clientId: 'x',
        addr: '1.2.3.4',
        otp: 'nope',
        deviceName: 'L',
        platform: 'ios',
      })
    ).toMatchObject({ code: 'bad_otp' });
    expect(
      s.m.redeemQr({ clientId: 'x', addr: '1.2.3.4', otp: q.otp, deviceName: 'L', platform: 'ios' })
    ).toMatchObject({
      code: 'rate_limited',
    });
  });

  it('is refused when pairing is disabled', () => {
    expect(setup({ enabled: false }).m.createQr({ label: 'cli' })).toMatchObject({
      code: 'pairing_disabled',
    });
  });
});
