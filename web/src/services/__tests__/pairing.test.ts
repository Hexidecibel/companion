import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  addPluginListener: vi.fn(async () => ({ unregister: async () => {} })),
}));

import {
  friendlyPairError,
  guessDeviceName,
  PairingClient,
  parsePairLink,
  serverFromPairing,
  wsUrl,
} from '../pairing';
import { discoverDaemons, normalizeDiscovered } from '../discovery';
import { FakeDaemonSocket } from '../../test/fakePairingDaemon';
import { setNativeEnv } from '../../test/nativeEnv';
import type { Server } from '../../types';

const OTP = 'o'.repeat(43);
const flush = () => new Promise((r) => setTimeout(r, 5));

describe('parsePairLink', () => {
  it('parses a daemon-made link', () => {
    const l = parsePairLink(
      `companion://pair?host=192.168.1.5&port=9877&tls=0&id=${'a'.repeat(32)}&name=Companion+on+box&otp=${OTP}`,
    );
    expect(l).toEqual({ host: '192.168.1.5', port: 9877, tls: false, otp: OTP, daemonId: 'a'.repeat(32), name: 'Companion on box' });
  });

  it('accepts tls=1, hostnames, IPv6 and surrounding whitespace', () => {
    expect(parsePairLink(`  companion://pair?host=box.ts.net&port=443&tls=1&otp=${OTP}\n`)).toMatchObject({ host: 'box.ts.net', tls: true });
    expect(parsePairLink(`companion://pair?host=fd7a::1&port=9877&otp=${OTP}`)).toMatchObject({ host: 'fd7a::1' });
  });

  it('rejects anything else', () => {
    expect(parsePairLink('https://evil.example/pair?host=a&port=1&otp=' + OTP)).toBeNull();
    expect(parsePairLink(`companion://pair?host=a b&port=9877&otp=${OTP}`)).toBeNull();
    expect(parsePairLink(`companion://pair?host=a/b&port=9877&otp=${OTP}`)).toBeNull();
    expect(parsePairLink(`companion://pair?host=a&port=70000&otp=${OTP}`)).toBeNull();
    expect(parsePairLink(`companion://pair?host=a&port=9877&otp=short`)).toBeNull();
    expect(parsePairLink(`companion://pair?host=a&port=9877`)).toBeNull();
    expect(parsePairLink(`companion://other?host=a&port=9877&otp=${OTP}`)).toBeNull();
    expect(parsePairLink('')).toBeNull();
  });

  it('drops a malformed daemon id instead of trusting it', () => {
    expect(parsePairLink(`companion://pair?host=a&port=1&id=xyz&otp=${OTP}`)).not.toHaveProperty('daemonId');
  });
});

describe('serverFromPairing', () => {
  const outcome = { token: 'cdt1.x.y', deviceId: 'dev1', deviceName: 'Phone', daemonId: 'd'.repeat(32), daemonName: 'Box' };
  const base: Server = { id: 's1', name: 'My box', host: '10.0.0.2', port: 9877, token: 'old', useTls: false };

  it('replaces the entry for the same daemon id (new address, keeps the name)', () => {
    const s = serverFromPairing({ host: '10.0.0.9', port: 9877, tls: false }, outcome, [{ ...base, daemonId: 'd'.repeat(32) }]);
    expect(s).toMatchObject({ id: 's1', name: 'My box', host: '10.0.0.9', token: 'cdt1.x.y', authKind: 'device', deviceId: 'dev1' });
  });

  it('replaces a legacy entry at the same address', () => {
    expect(serverFromPairing({ host: '10.0.0.2', port: 9877, tls: false }, outcome, [base]).id).toBe('s1');
  });

  it('creates a new entry named after the daemon', () => {
    const s = serverFromPairing({ host: '10.0.0.3', port: 9877, tls: true }, outcome, [base], () => 'new');
    expect(s).toMatchObject({ id: 'new', name: 'Box', useTls: true, enabled: true });
  });
});

describe('PairingClient', () => {
  beforeEach(() => FakeDaemonSocket.reset());
  const WS = FakeDaemonSocket as unknown as typeof WebSocket;
  const target = { host: '10.0.0.2', port: 9877, tls: false };

  it('code flow: wrong code keeps waiting with tries left, right code yields a token', async () => {
    const states: string[] = [];
    const c = new PairingClient(target, (s) => states.push(s.phase), WS);
    await c.start('Pixel', 'android');
    expect(c.state.phase).toBe('waiting');
    expect(FakeDaemonSocket.last.url).toBe('ws://10.0.0.2:9877');
    expect(FakeDaemonSocket.last.sent[0]).toMatchObject({ type: 'pair_request', payload: { deviceName: 'Pixel', platform: 'android' } });
    await c.confirm('000000');
    expect(c.state).toMatchObject({ phase: 'waiting', error: 'Wrong code', attemptsLeft: 4 });
    await c.confirm('424 242');
    expect(c.state.phase).toBe('approved');
    expect(c.state.outcome).toMatchObject({ deviceId: '0123456789abcdef', daemonName: 'Companion on box' });
    expect(FakeDaemonSocket.last.closed).toBe(true);
    expect(states).toEqual(['connecting', 'waiting', 'waiting', 'approved']);
  });

  it('approval from another device completes the waiting request', async () => {
    const c = new PairingClient(target, () => {}, WS);
    await c.start('iPad', 'ios');
    FakeDaemonSocket.last.approve();
    expect(c.state.phase).toBe('approved');
  });

  it('ignores an approval carrying someone else nonce', async () => {
    const c = new PairingClient(target, () => {}, WS);
    await c.start('iPad', 'ios');
    const s = FakeDaemonSocket.last;
    s.emit({ type: 'pair_result', success: true, payload: { ...s.approved('approval'), publicNonce: 'other' } });
    expect(c.state.phase).toBe('waiting');
  });

  it('denied / expired end the attempt', async () => {
    const c = new PairingClient(target, () => {}, WS);
    await c.start('x', 'web');
    FakeDaemonSocket.last.emit({ type: 'pair_result', success: true, payload: { status: 'denied', pairingId: 'pid-1' } });
    expect(c.state.phase).toBe('denied');
  });

  it('explains an untrusted network and an old daemon', async () => {
    FakeDaemonSocket.mode = 'untrusted';
    const c = new PairingClient(target, () => {}, WS);
    await c.start('x', 'web');
    expect(c.state).toMatchObject({ phase: 'error', error: friendlyPairError('untrusted_network') });
    FakeDaemonSocket.mode = 'old';
    const d = new PairingClient(target, () => {}, WS);
    await d.start('x', 'web');
    expect(d.state.error).toMatch(/too old/);
  });

  it('QR redeem', async () => {
    const c = new PairingClient({ ...target, tls: true }, () => {}, WS);
    await c.redeem({ ...target, tls: true, otp: OTP }, 'Laptop', 'desktop');
    expect(FakeDaemonSocket.last.url).toBe('wss://10.0.0.2:9877');
    expect(c.state.phase).toBe('approved');
    const d = new PairingClient(target, () => {}, WS);
    await d.redeem({ ...target, otp: 'z'.repeat(43) }, 'Laptop', 'desktop');
    expect(d.state).toMatchObject({ phase: 'error', error: friendlyPairError('bad_otp') });
  });

  it('brackets IPv6 hosts in the URL', () => {
    expect(wsUrl({ host: 'fd7a::1', port: 9877, tls: false })).toBe('ws://[fd7a::1]:9877');
  });
});

describe('device name guess', () => {
  afterEach(() => setNativeEnv('browser'));
  it('names by platform', () => {
    setNativeEnv('android');
    expect(guessDeviceName()).toBe('Android phone');
    setNativeEnv('ios');
    expect(guessDeviceName()).toBe('iPhone');
    setNativeEnv('browser');
    expect(guessDeviceName()).toBe('Chrome on Linux');
  });
});

describe('discovery', () => {
  beforeEach(() => {
    invoke.mockReset();
  });
  afterEach(() => setNativeEnv('browser'));

  it('normalizes, dedupes by daemon id, prefers IPv4, reads TXT flags', () => {
    const id = 'b'.repeat(32);
    const list = normalizeDiscovered([
      { name: 'Companion on box', host: 'box.local.', addresses: ['fe80::1'], port: 9877, txt: { id, name: 'Box', pairing: '1', tls: '0', version: '1.2.0' } },
      { name: 'Companion on box', host: 'box.local.', addresses: ['fe80::1', '192.168.1.5'], port: 9877, txt: { id, name: 'Box', pairing: '1', tls: '0' } },
      { name: 'Old daemon', host: 'old.local', addresses: [], port: 9877, txt: { version: '1.0', tls: 'true' } },
      { name: 'broken', port: 'x' },
      null,
    ]);
    expect(list).toEqual([
      { key: id, name: 'Box', host: '192.168.1.5', candidates: ['192.168.1.5', 'box.local'], port: 9877, tls: false, daemonId: id, version: '1.2.0', pairing: true },
      { key: 'old.local:9877', name: 'Old daemon', host: 'old.local', candidates: ['old.local'], port: 9877, tls: true, version: '1.0', pairing: false },
    ]);
  });

  it('tries the daemon LAN hint first and bridges last', () => {
    const [d] = normalizeDiscovered([
      {
        name: 'Hexinas',
        host: 'hexinas.local.',
        addresses: ['10.200.0.1', '172.19.0.1', '192.168.16.1', '192.168.1.48', 'fd00::5'],
        port: 9877,
        txt: { ip: '192.168.1.48', pairing: '1' },
      },
    ]);
    expect(d.host).toBe('192.168.1.48');
    expect(d.candidates).toEqual(['192.168.1.48', '192.168.16.1', '10.200.0.1', '172.19.0.1', 'hexinas.local', 'fd00::5']);
  });

  it('pickReachable returns the first candidate that answers', async () => {
    const { pickReachable } = await import('../discovery');
    class Dead {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      constructor() {
        setTimeout(() => this.onerror?.(), 0);
      }
      send() {}
      close() {}
    }
    const Mixed = function (this: unknown, url: string) {
      return url.includes('10.0.0.9') ? new FakeDaemonSocket(url) : new Dead();
    } as unknown as typeof WebSocket;
    const t = await pickReachable({ candidates: ['10.0.0.1', '10.0.0.9'], port: 9877, tls: false }, { WS: Mixed, timeoutMs: 1000 });
    expect(t).toEqual({ host: '10.0.0.9', port: 9877, tls: false });
    const none = await pickReachable({ candidates: ['10.0.0.1'], port: 9877, tls: false }, { WS: Mixed, timeoutMs: 1000 });
    expect(none).toBeNull();
  });

  it('asks the native plugin in the apps, returns null in a browser', async () => {
    setNativeEnv('browser');
    expect(await discoverDaemons(100)).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    setNativeEnv('android');
    invoke.mockResolvedValue({ daemons: [{ name: 'X', host: '10.0.0.7', port: 9877, txt: { pairing: '1' } }] });
    expect(await discoverDaemons(100)).toEqual([
      { key: '10.0.0.7:9877', name: 'X', host: '10.0.0.7', candidates: ['10.0.0.7'], port: 9877, tls: false, pairing: true },
    ]);
    expect(invoke).toHaveBeenCalledWith('plugin:herald-native|discover_daemons', { timeoutMs: 100 });
  });

  it('an older app without the command yields null (no crash)', async () => {
    setNativeEnv('ios');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invoke.mockImplementation(() => Promise.reject(new Error('not found')));
    const r = await discoverDaemons(100).catch((e) => `threw ${String(e)}`);
    warn.mockRestore();
    expect(r).toBeNull();
  });
});

void flush;

describe('deep links', () => {
  afterEach(() => setNativeEnv('browser'));
  it('delivers the link that cold-started the app, and nothing in a browser', async () => {
    const { listenDeepLinks } = await import('../nativeBridge');
    const got: string[] = [];
    setNativeEnv('browser');
    await listenDeepLinks((u) => got.push(u));
    expect(got).toEqual([]);
    setNativeEnv('android');
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'plugin:herald-native|take_pending_link' ? { url: `companion://pair?host=a&port=1&otp=${OTP}` } : null,
    );
    const off = await listenDeepLinks((u) => got.push(u));
    expect(got).toHaveLength(1);
    expect(parsePairLink(got[0])).toMatchObject({ host: 'a', port: 1 });
    off();
  });
});
