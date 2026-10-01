import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import {
  classifyTriggerOrigin,
  HeraldTriggerService,
  HomeIpResolver,
  ipNetwork,
  sha256Hex,
  TriggerTokenFile,
  triggerSignature,
} from '../src/herald/trigger';
import { parseHeraldConfigBlock, resolveHeraldConfig } from '../src/herald/config';
import type { AuditEntry } from '../src/audit-log';
import type { HeraldEvent } from '../src/herald/protocol';

const LEGACY = 'l'.repeat(24) + '0123456789abcdef0123456789abcdef';
const PC = 'p'.repeat(24) + '0123456789abcdef0123456789abcdef';
const MAC = 'm'.repeat(24) + '0123456789abcdef0123456789abcdef';
const HOME_IP = '73.97.227.16';

function writeFile(file: string, content: string, mode = 0o600) {
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
}

function registry(file: string, tokens: Array<{ name: string; token: string; revoked?: boolean }>, mode = 0o600) {
  writeFile(
    file,
    JSON.stringify({
      version: 1,
      tokens: tokens.map((t) => ({
        name: t.name,
        sha256: sha256Hex(t.token),
        createdAt: '2026-09-30T20:00:00Z',
        ...(t.revoked ? { revokedAt: '2026-09-30T21:00:00Z' } : {}),
      })),
    }),
    mode
  );
}

describe('per-device trigger tokens', () => {
  let dir: string;
  let legacy: string;
  let reg: string;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-tok-'));
    legacy = path.join(dir, 'herald-trigger.token');
    reg = path.join(dir, 'herald-trigger-tokens.json');
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the registry lives next to the legacy file by default', () => {
    expect(new TriggerTokenFile(legacy).registryPath).toBe(reg);
  });

  it('the legacy single token keeps working as "default" (no registry needed)', () => {
    writeFile(legacy, LEGACY + '\n');
    const f = new TriggerTokenFile(legacy);
    expect(f.identify(LEGACY)).toEqual({ name: 'default', sha256: sha256Hex(LEGACY) });
    expect(f.current()).toBe(LEGACY);
  });

  it('named tokens from the registry; revoked ones are refused; changes apply without restart', () => {
    writeFile(legacy, LEGACY + '\n');
    registry(reg, [
      { name: 'default', token: LEGACY },
      { name: 'gaming-pc', token: PC },
      { name: 'work-mac', token: MAC, revoked: true },
    ]);
    const f = new TriggerTokenFile(legacy);
    expect(f.identify(PC)?.name).toBe('gaming-pc');
    expect(f.identify(MAC)).toBeNull();
    expect(f.identify(LEGACY)?.name).toBe('default');
    expect(f.credentials().map((c) => c.name).sort()).toEqual(['default', 'gaming-pc']);
    // Revoke default via the registry: the legacy file no longer authorizes.
    const tmp = `${reg}.tmp`;
    registry(tmp, [
      { name: 'default', token: LEGACY, revoked: true },
      { name: 'gaming-pc', token: PC },
    ]);
    fs.renameSync(tmp, reg);
    expect(f.identify(LEGACY)).toBeNull();
    expect(f.identify(PC)?.name).toBe('gaming-pc');
    expect(f.stillValid({ name: 'default', sha256: sha256Hex(LEGACY) })).toBe(false);
  });

  it('refuses a group/world-readable registry and junk entries', () => {
    registry(reg, [{ name: 'gaming-pc', token: PC }], 0o644);
    const f = new TriggerTokenFile(legacy);
    expect(f.identify(PC)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/must be 600/));
    writeFile(reg, JSON.stringify({ tokens: [{ name: '../x', sha256: sha256Hex(PC) }, { name: 'ok', sha256: 'nothex' }] }));
    expect(f.identify(PC)).toBeNull();
    writeFile(reg, '{not json');
    expect(f.identify(PC)).toBeNull();
  });

  it('no tokens at all: nothing matches', () => {
    const f = new TriggerTokenFile(legacy);
    expect(f.identify(PC)).toBeNull();
    expect(f.identify('')).toBeNull();
    expect(f.identify(undefined)).toBeNull();
  });
});

describe('trigger origin trust', () => {
  const proxies = ['127.0.0.1', '::1'];
  it.each([
    ['127.0.0.1', undefined, 'local'],
    ['::ffff:127.0.0.1', undefined, 'local'],
    ['::1', undefined, 'local'],
    ['192.168.1.20', undefined, 'lan'],
    ['10.0.0.5', undefined, 'lan'],
    ['172.20.0.3', undefined, 'lan'],
    ['100.101.102.103', undefined, 'tailnet'],
    ['fd7a:115c:a1e0::1', undefined, 'tailnet'],
    ['203.0.113.9', undefined, 'public'],
    // HAProxy on this host (peer loopback) sets X-Forwarded-For to the real client.
    ['::ffff:127.0.0.1', '192.168.1.20', 'lan'],
    ['127.0.0.1', '100.64.1.2', 'tailnet'],
    ['127.0.0.1', '203.0.113.9', 'public'],
    ['127.0.0.1', '1.2.3.4, 192.168.1.20', 'lan'],
    ['127.0.0.1', 'garbage', 'public'],
    // XFF from anyone but a trusted proxy is not believed (and means "forwarded from somewhere").
    ['192.168.1.20', '127.0.0.1', 'public'],
    ['100.95.87.89', '192.168.1.20', 'public'],
  ])('peer %s xff %s -> %s', (peer, xff, network) => {
    expect(classifyTriggerOrigin({ peer, forwardedFor: xff, trustedProxies: proxies }).network).toBe(network);
  });

  it("the home's own public IP via the proxy is home (hairpin NAT from the LAN)", () => {
    const info = classifyTriggerOrigin({ peer: '127.0.0.1', forwardedFor: HOME_IP, trustedProxies: proxies, homeIps: [HOME_IP] });
    expect(info).toEqual({ client: HOME_IP, network: 'home', proxied: true });
    // But not when an untrusted peer claims it.
    expect(classifyTriggerOrigin({ peer: '203.0.113.9', forwardedFor: HOME_IP, trustedProxies: proxies, homeIps: [HOME_IP] }).network).toBe('public');
  });

  it('ipNetwork edge cases', () => {
    expect(ipNetwork('100.63.255.255')).toBe('public');
    expect(ipNetwork('100.128.0.1')).toBe('public');
    expect(ipNetwork('172.32.0.1')).toBe('public');
    expect(ipNetwork('[fe80::1%eth0]')).toBe('lan');
    expect(ipNetwork('2001:db8::1')).toBe('public');
  });

  it('home IPs resolve from configured hosts, cached', async () => {
    const lookup = jest.fn(async () => [HOME_IP]);
    let now = 0;
    const r = new HomeIpResolver(['dev.example.org'], 1000, lookup, () => now);
    expect(await r.get()).toEqual([HOME_IP]);
    expect(await r.get()).toEqual([HOME_IP]);
    expect(lookup).toHaveBeenCalledTimes(1);
    now = 5000;
    await r.get();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(await new HomeIpResolver([]).get()).toEqual([]);
  });

  it('config: trust settings parse with safe defaults', () => {
    const def = resolveHeraldConfig(parseHeraldConfigBlock({}), {});
    expect(def.trigger).toEqual({ publicListen: false, homeHosts: [], trustedProxies: ['127.0.0.1', '::1'] });
    const set = resolveHeraldConfig(
      parseHeraldConfigBlock({ trigger_public_listen: true, trigger_home_hosts: ['dev.cush.rocks', 5], trigger_trusted_proxies: ['100.95.87.89'] }),
      {}
    );
    expect(set.trigger).toEqual({ publicListen: true, homeHosts: ['dev.cush.rocks'], trustedProxies: ['100.95.87.89'] });
  });
});

describe('mic-opening actions from untrusted origins', () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  function make(publicListen = false) {
    const delivered: HeraldEvent[] = [];
    const audits: AuditEntry[] = [];
    const svc = new HeraldTriggerService({
      available: () => true,
      activeClient: () => 'desk',
      claimDevice: () => 'desk',
      deliver: (_c, e) => {
        delivered.push(e);
        return true;
      },
      audit: (a) => audits.push(a),
      trust: { publicListen },
    });
    return { svc, delivered, audits };
  }
  const origin = { addr: '127.0.0.1', clientId: 'http', isLocal: false, tls: true, origin: null };

  it('public: listen 403, toggle delivered with allowListen=false, the rest allowed', () => {
    const { svc, delivered, audits } = make();
    const src = { via: 'http' as const, origin, network: 'public' as const, client: '203.0.113.9', credential: 'gaming-pc', auth: 'bearer' as const };
    expect(svc.fire('listen', src)).toMatchObject({ ok: false, status: 403, code: 'untrusted_origin' });
    expect(svc.fire({ action: 'listen', device: 'desk' }, src)).toMatchObject({ status: 403 });
    expect(svc.fire('toggle', src).ok).toBe(true);
    expect(delivered[0]).toMatchObject({ kind: 'trigger', action: 'toggle', allowListen: false });
    for (const a of ['brief', 'stop', 'repeat']) expect(svc.fire(a, src).ok).toBe(true);
    expect(svc.fire({ action: 'claim', device: 'desk' }, src).ok).toBe(true);
    expect(audits[0].payload).toMatchObject({ network: 'public', client: '203.0.113.9', token: 'gaming-pc', auth: 'bearer' });
    expect(audits[2].payload).toMatchObject({ listenBlocked: true });
  });

  it.each(['local', 'lan', 'tailnet', 'home'] as const)('%s: listen and toggle open the mic', (network) => {
    const { svc, delivered } = make();
    expect(svc.fire('listen', { via: 'http', origin, network }).ok).toBe(true);
    expect(svc.fire('toggle', { via: 'http', origin, network }).ok).toBe(true);
    expect(delivered.every((e) => !('allowListen' in e))).toBe(true);
  });

  it('herald.trigger_public_listen=true allows it from anywhere', () => {
    const { svc } = make(true);
    expect(svc.fire('listen', { via: 'http', origin, network: 'public' }).ok).toBe(true);
  });
});

describe('HTTP: HAProxy forwarding, named tokens and signed mode', () => {
  let dir: string;
  let server: http.Server;
  let base: string;
  let delivered: HeraldEvent[];
  let audits: AuditEntry[];
  let now: number;
  let log: jest.SpyInstance;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-trig-http-'));
    const legacy = path.join(dir, 'herald-trigger.token');
    writeFile(legacy, LEGACY + '\n');
    registry(path.join(dir, 'herald-trigger-tokens.json'), [
      { name: 'gaming-pc', token: PC },
      { name: 'old-mac', token: MAC, revoked: true },
    ]);
    delivered = [];
    audits = [];
    now = Date.now();
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const svc = new HeraldTriggerService({
      available: () => true,
      activeClient: () => 'desk',
      claimDevice: () => 'desk',
      deliver: (_c, e) => {
        delivered.push(e);
        return true;
      },
      audit: (a) => audits.push(a),
      tokenFile: new TriggerTokenFile(legacy),
      now: () => now,
      homeResolver: new HomeIpResolver(['home.example'], 60_000, async () => [HOME_IP]),
    });
    server = http.createServer((req, res) => svc.handleHttp(req, res, false));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/herald/trigger`;
  });
  afterEach(async () => {
    log.mockRestore();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const post = (body: object, headers: Record<string, string>) =>
    fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('a named token is accepted and audited by name; revoked is 401; legacy still works', async () => {
    expect((await post({ action: 'brief' }, { Authorization: `Bearer ${PC}` })).status).toBe(200);
    expect(audits[0].payload).toMatchObject({ token: 'gaming-pc', auth: 'bearer', network: 'local' });
    expect((await post({ action: 'brief' }, { Authorization: `Bearer ${MAC}` })).status).toBe(401);
    expect((await post({ action: 'brief' }, { Authorization: `Bearer ${LEGACY}` })).status).toBe(200);
    expect(audits[2].payload).toMatchObject({ token: 'default' });
    expect(JSON.stringify(audits)).not.toContain(PC);
  });

  it('through HAProxy: LAN client listens, internet client cannot, hairpin (home IP) can', async () => {
    const auth = { Authorization: `Bearer ${PC}` };
    expect((await post({ action: 'listen' }, { ...auth, 'X-Forwarded-For': '192.168.1.20' })).status).toBe(200);
    const pub = await post({ action: 'listen' }, { ...auth, 'X-Forwarded-For': '203.0.113.9' });
    expect(pub.status).toBe(403);
    expect(await pub.json()).toMatchObject({ code: 'untrusted_origin' });
    expect((await post({ action: 'listen' }, { ...auth, 'X-Forwarded-For': HOME_IP })).status).toBe(200);
    expect(audits.map((a) => a.payload.network)).toEqual(['lan', 'public', 'home']);
    expect(audits[1].origin.isLocal).toBe(false);
  });

  it('signed mode: valid accepted, skew > 60 s / replay / wrong key / tampered device refused', async () => {
    const key = sha256Hex(PC);
    const ts = String(Math.floor(now / 1000));
    const sig = triggerSignature(key, ts, 'toggle', 'Gaming PC');
    const body = { action: 'toggle', device: 'Gaming PC' };
    const ok = await post(body, { 'X-Herald-Ts': ts, 'X-Herald-Sig': sig });
    expect(ok.status).toBe(200);
    expect(audits[0].payload).toMatchObject({ token: 'gaming-pc', auth: 'signed' });
    // Replay of the same request.
    const replay = await post(body, { 'X-Herald-Ts': ts, 'X-Herald-Sig': sig });
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { error: string }).error).toMatch(/replay/);
    // Clock skew.
    const old = String(Math.floor(now / 1000) - 61);
    const skew = await post({ action: 'brief' }, { 'X-Herald-Ts': old, 'X-Herald-Sig': triggerSignature(key, old, 'brief') });
    expect(skew.status).toBe(401);
    expect(((await skew.json()) as { error: string }).error).toMatch(/more than 60 s off/);
    const near = String(Math.floor(now / 1000) - 59);
    expect((await post({ action: 'brief' }, { 'X-Herald-Ts': near, 'X-Herald-Sig': triggerSignature(key, near, 'brief') })).status).toBe(200);
    // Signed with a revoked token, or over a different device.
    expect((await post({ action: 'brief' }, { 'X-Herald-Ts': ts, 'X-Herald-Sig': triggerSignature(sha256Hex(MAC), ts, 'brief') })).status).toBe(401);
    expect((await post({ action: 'toggle', device: 'Other' }, { 'X-Herald-Ts': ts, 'X-Herald-Sig': triggerSignature(key, ts, 'toggle', 'Gaming PC') })).status).toBe(401);
    expect((await post({ action: 'brief' }, { 'X-Herald-Ts': 'soon', 'X-Herald-Sig': sig })).status).toBe(401);
  });

  it('signature matches what openssl / the scripts compute', () => {
    const key = sha256Hex(PC);
    const expected = crypto.createHmac('sha256', key).update('1790800000.brief.', 'utf8').digest('hex');
    expect(triggerSignature(key, '1790800000', 'brief')).toBe(expected);
  });
});
