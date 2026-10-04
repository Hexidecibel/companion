import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DeviceRegistry,
  LAST_SEEN_FLUSH_MS,
  cleanDeviceName,
  parseDeviceToken,
} from '../src/pairing/registry';
import { buildMdnsTxt, lanAddresses, MDNS_TXT_KEYS } from '../src/mdns';
import { loadOrCreateDaemonId } from '../src/pairing/identity';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-registry-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

let n = 0;
function fresh(now?: () => number): DeviceRegistry {
  return new DeviceRegistry(path.join(dir, `sub${++n}`, 'devices.json'), now);
}

describe('DeviceRegistry', () => {
  it('creates a device, persists it 0600 without the token, and verifies the token', () => {
    const reg = fresh();
    const { device, token } = reg.create({ name: "Chris's iPad", platform: 'ios', via: 'code' });
    expect(parseDeviceToken(token)).toEqual({ id: device.id, secret: expect.any(String) });
    const raw = fs.readFileSync(reg.filePath, 'utf8');
    expect(raw).not.toContain(token.split('.')[2]);
    expect(fs.statSync(reg.filePath).mode & 0o777).toBe(0o600);
    const json = JSON.parse(raw);
    expect(json.devices[0]).toMatchObject({ id: device.id, name: "Chris's iPad", platform: 'ios' });
    expect(json.devices[0].salt).toMatch(/^[0-9a-f]{32}$/);
    expect(json.devices[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);

    // A second instance (daemon restart) reads it back.
    const again = new DeviceRegistry(reg.filePath);
    expect(again.verify(token)?.id).toBe(device.id);
    expect(again.list()[0]).not.toHaveProperty('tokenHash');
    expect(again.list()[0]).not.toHaveProperty('salt');
  });

  it('rejects wrong secrets, other ids, malformed and legacy tokens', () => {
    const reg = fresh();
    const a = reg.create({ name: 'A', platform: 'android', via: 'qr' });
    const b = reg.create({ name: 'B', platform: 'desktop', via: 'qr' });
    const [, , secretA] = a.token.split('.');
    expect(reg.verify(`cdt1.${b.device.id}.${secretA}`)).toBeNull();
    expect(reg.verify(a.token.slice(0, -1) + (a.token.endsWith('A') ? 'B' : 'A'))).toBeNull();
    expect(reg.verify('cdt1.0000000000000000.' + 'x'.repeat(43))).toBeNull();
    expect(reg.verify('not-a-token')).toBeNull();
    expect(reg.verify(undefined)).toBeNull();
    expect(reg.verify(a.token)?.name).toBe('A');
  });

  it('salts every token (same secret material never hashes the same)', () => {
    const reg = fresh();
    reg.create({ name: 'A', platform: 'web', via: 'code' });
    reg.create({ name: 'B', platform: 'web', via: 'code' });
    const json = JSON.parse(fs.readFileSync(reg.filePath, 'utf8'));
    expect(json.devices[0].salt).not.toBe(json.devices[1].salt);
  });

  it('revoke removes the device and its token stops working', () => {
    const reg = fresh();
    const { device, token } = reg.create({ name: 'Phone', platform: 'android', via: 'code' });
    expect(reg.revoke(device.id)?.name).toBe('Phone');
    expect(reg.verify(token)).toBeNull();
    expect(reg.exists(device.id)).toBe(false);
    expect(reg.revoke(device.id)).toBeNull();
  });

  it('rename cleans the name and refuses empty ones', () => {
    const reg = fresh();
    const { device } = reg.create({ name: 'x', platform: 'web', via: 'code' });
    expect(reg.rename(device.id, '  Work\nlaptop  ')?.name).toBe('Work laptop');
    expect(reg.rename(device.id, '   ')).toBeNull();
    expect(cleanDeviceName('a'.repeat(200))).toHaveLength(60);
  });

  it('sees edits made by another process (CLI while the daemon is down)', () => {
    const reg = fresh();
    const { device, token } = reg.create({ name: 'Phone', platform: 'android', via: 'code' });
    const other = new DeviceRegistry(reg.filePath);
    other.revoke(device.id);
    expect(reg.verify(token)).toBeNull();
  });

  it('coalesces lastSeenAt writes and never resurrects a revoked device', () => {
    let t = 1_000_000;
    const reg = fresh(() => t);
    const a = reg.create({ name: 'A', platform: 'web', via: 'code' });
    const b = reg.create({ name: 'B', platform: 'web', via: 'code' });
    t += LAST_SEEN_FLUSH_MS + 1;
    reg.touch(a.device.id); // flushes immediately (last flush long ago)
    const first = JSON.parse(fs.readFileSync(reg.filePath, 'utf8')).devices[0].lastSeenAt;
    expect(first).toBe(t);
    t += 10;
    reg.touch(a.device.id); // coalesced: not written yet
    expect(JSON.parse(fs.readFileSync(reg.filePath, 'utf8')).devices[0].lastSeenAt).toBe(first);
    // Another process revokes B meanwhile; our flush must not bring it back.
    new DeviceRegistry(reg.filePath).revoke(b.device.id);
    reg.shutdown();
    const after = JSON.parse(fs.readFileSync(reg.filePath, 'utf8')).devices;
    expect(after.map((d: { id: string }) => d.id)).toEqual([a.device.id]);
    expect(after[0].lastSeenAt).toBe(t);
  });

  it('tightens a group/world-readable file', () => {
    const reg = fresh();
    reg.create({ name: 'A', platform: 'web', via: 'code' });
    fs.chmodSync(reg.filePath, 0o644);
    new DeviceRegistry(reg.filePath).list();
    expect(fs.statSync(reg.filePath).mode & 0o777).toBe(0o600);
  });

  it('a missing file is an empty registry and is not created by reads', () => {
    const reg = fresh();
    expect(reg.list()).toEqual([]);
    expect(reg.verify('cdt1.0123456789abcdef.' + 'a'.repeat(43))).toBeNull();
    expect(fs.existsSync(reg.filePath)).toBe(false);
  });
});

describe('daemon identity', () => {
  it('is stable across loads and stored 0600', () => {
    const f = path.join(dir, 'id', 'daemon-id.json');
    const id = loadOrCreateDaemonId(f);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(loadOrCreateDaemonId(f)).toBe(id);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });
});

describe('mDNS TXT', () => {
  it('carries only public facts', () => {
    const token = 'super-secret-listener-token-1234567890';
    const txt = buildMdnsTxt({
      port: 9877,
      tls: false,
      id: 'a'.repeat(32),
      name: 'Companion on box',
      version: '1.0.0',
      pairing: true,
    });
    expect(Object.keys(txt).every((k) => (MDNS_TXT_KEYS as readonly string[]).includes(k))).toBe(
      true
    );
    expect(txt).toEqual({
      id: 'a'.repeat(32),
      name: 'Companion on box',
      version: '1.0.0',
      pairing: '1',
      tls: '0',
      port: '9877',
      proto: '1',
    });
    expect(JSON.stringify(txt)).not.toContain(token);
    const withIp = buildMdnsTxt({
      port: 9877,
      tls: true,
      id: 'a'.repeat(32),
      name: 'x',
      version: '1',
      pairing: false,
      addresses: ['192.168.1.48', '10.0.0.2', '172.16.0.4', '192.168.9.9'],
    });
    expect(withIp.ip).toBe('192.168.1.48,10.0.0.2,172.16.0.4');
    expect(withIp.pairing).toBe('0');
    expect(JSON.stringify(txt)).not.toMatch(/token|otp|code|secret/i);
  });
});

describe('lanAddresses', () => {
  const v4 = (address: string) => ({ address, family: 'IPv4', internal: false }) as any;
  it('skips container / VPN interfaces, link-local and the tailnet; LAN first', () => {
    expect(
      lanAddresses({
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as any],
        docker0: [v4('172.17.0.1')],
        'br-1234': [v4('192.168.16.1')],
        tailscale0: [v4('100.101.1.2')],
        wg0: [v4('10.200.0.1')],
        eth1: [v4('10.0.0.5')],
        eth0: [v4('192.168.1.48'), { address: 'fe80::1', family: 'IPv6', internal: false } as any],
        wlan0: [v4('169.254.3.3')],
      })
    ).toEqual(['192.168.1.48', '10.0.0.5']);
  });
});
