import type { NetworkInterfaceInfo } from 'os';
import { deriveSelfInfo, reachableAddresses } from '../src/herald/self-info';
import { buildSystemPrompt } from '../src/herald/prompt';

function v4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  };
}

const HOST_IFACES: NodeJS.Dict<NetworkInterfaceInfo[]> = {
  lo: [v4('127.0.0.1', true)],
  docker0: [v4('10.200.0.1')],
  'br-d6890ec457e6': [v4('10.200.8.1')],
  'br-df3af65363f5': [v4('192.168.192.1')],
  'br-d641f5aac6aa': [v4('172.20.0.1')],
  tailscale0: [v4('100.95.87.89')],
  enp3s0: [
    v4('192.168.1.48'),
    {
      address: 'fe80::1',
      netmask: 'ffff:ffff:ffff:ffff::',
      family: 'IPv6',
      mac: '00:00:00:00:00:00',
      internal: false,
      cidr: 'fe80::1/64',
      scopeid: 2,
    },
  ],
  weird0: [v4('172.17.0.5'), v4('10.200.3.4'), v4('169.254.1.1')],
};

describe('herald self-info address derivation', () => {
  it('keeps LAN then tailnet, skipping loopback, docker and bridge addresses', () => {
    expect(reachableAddresses(HOST_IFACES)).toEqual(['192.168.1.48', '100.95.87.89']);
  });

  it('builds web URLs from the listener port and TLS flag', () => {
    expect(deriveSelfInfo({ port: 9877 }, HOST_IFACES).webUrls).toEqual([
      'http://192.168.1.48:9877/web',
      'http://100.95.87.89:9877/web',
    ]);
    expect(deriveSelfInfo({ port: 9443, tls: true }, HOST_IFACES).webUrls[0]).toBe(
      'https://192.168.1.48:9443/web'
    );
  });

  it('returns no URLs without a listener or usable interfaces', () => {
    expect(deriveSelfInfo(undefined, HOST_IFACES).webUrls).toEqual([]);
    expect(deriveSelfInfo({ port: 9877 }, { lo: [v4('127.0.0.1', true)] }).webUrls).toEqual([]);
  });

  it('keeps other private ranges as a fallback after LAN and tailnet', () => {
    const ifaces = { eth1: [v4('10.0.0.7')], eth0: [v4('192.168.50.2')] };
    expect(reachableAddresses(ifaces)).toEqual(['192.168.50.2', '10.0.0.7']);
  });
});

describe('herald system prompt self-knowledge', () => {
  const listener = { port: 9877, token: 'super-secret-token-abc123', tls: false };
  const prompt = buildSystemPrompt('Herald', deriveSelfInfo(listener, HOST_IFACES));

  it('includes the reachable addresses and nothing internal', () => {
    expect(prompt).toContain('http://192.168.1.48:9877/web');
    expect(prompt).toContain('http://100.95.87.89:9877/web');
    expect(prompt).not.toMatch(/127\.0\.0\.1|localhost/);
    expect(prompt).not.toMatch(/\b172\.(1[6-9]|2\d|3[01])\./);
    expect(prompt).not.toMatch(/\b10\.200\./);
    expect(prompt).not.toContain('192.168.192.1');
  });

  it('never contains the listener token', () => {
    expect(prompt).not.toContain(listener.token);
    expect(prompt.toLowerCase()).not.toContain('token');
  });

  it('describes itself: access points, cross-device state, native app and voice', () => {
    expect(prompt).toMatch(/Ctrl\+J/);
    expect(prompt).toMatch(/Herald button on mobile/);
    expect(prompt).toMatch(/stored on the server/);
    expect(prompt).toMatch(/Companion desktop and phone apps/);
    expect(prompt).toMatch(/hands-free by saying "Hey Jarvis"/);
    expect(prompt).not.toMatch(/Voice is not available yet/);
  });

  it('allows practical answers, keeps deep technical work routed, and bans option menus', () => {
    expect(prompt).toMatch(/Never deflect these as off-topic/);
    expect(prompt).toMatch(/no designing, debugging, writing or reviewing code/);
    expect(prompt).toMatch(/Never reply with a menu/);
    // Grounding rules are unchanged.
    expect(prompt).toMatch(/Grounding \(most important rule\)/);
    expect(prompt).toMatch(/Never guess or embellish/);
  });

  it('is stable for the same inputs and falls back without addresses', () => {
    expect(buildSystemPrompt('Herald', deriveSelfInfo(listener, HOST_IFACES))).toBe(prompt);
    const bare = buildSystemPrompt('Herald');
    expect(bare).toMatch(/same address they opened you on/);
    expect(bare).not.toMatch(/https?:\/\//);
  });

  it('carries the feature guide (profiles, device check, hands-free, triggers, overlay) in the stable prefix', () => {
    for (const phrase of ['Profiles:', 'Device check:', 'Hands-free:', 'Triggers:', 'Take control:', 'Floating orb', 'Wispr Flow', 'Gaming:']) {
      expect(prompt).toContain(phrase);
    }
    // Before the per-conversation rules, and identical for every conversation.
    expect(prompt.indexOf('Using you')).toBeLessThan(prompt.indexOf('How you speak:'));
    expect(buildSystemPrompt('Herald')).toContain('Using you');
  });
});
