/**
 * Docker packaging: GET /health, container detection, the pairing-code banner,
 * the container branches of the setup checks / info / service, the Tailscale
 * sidecar socket client, the public app-feed fallback and the COMPANION_MDNS
 * runtime override.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-container-'));
const cfgPath = path.join(dir, 'config.json');
process.env.COMPANION_CONFIG = cfgPath;
process.env.COMPANION_SETUP_STATE_FILE = path.join(dir, 'setup-state.json');

import { detectContainer, pairingCodeBanner, ContainerInfo, DOCKER_COMMANDS } from '../src/container';
import { handleHealthRequest, healthPayload } from '../src/health';
import { appVersion } from '../src/version';
import { createQRRequestHandler } from '../src/qr-server';
import { CheckEnv, RunResult, Runner, runChecks, tailscaleStatusViaSocket } from '../src/setup/checks';
import {
  appDownloadsWithFallback,
  appFeedUrl,
  DEFAULT_APP_FEED_URL,
  remoteAccessInfo,
  resetRemoteFeedCacheForTests,
  servicePlan,
} from '../src/setup/info';
import { SetupService } from '../src/setup/service';
import { SetupStateStore } from '../src/setup/state';
import { loadConfig } from '../src/config';
import type { DaemonConfig } from '../src/types';
import type { PrereqCheck, PrereqId } from '../src/setup/protocol';

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const DOCKER: ContainerInfo = {
  runtime: 'docker',
  projectsDir: null,
  hostNetwork: false,
  tailscaleSocket: null,
  publishedPort: 9744,
};

// ------------------------------------------------------------------ detection

describe('container detection', () => {
  const none = () => false;
  it('host install: no flag and no /.dockerenv', () => {
    expect(detectContainer({}, none)).toBeNull();
  });
  it('the image flag or /.dockerenv; COMPANION_CONTAINER=0 turns it off', () => {
    expect(detectContainer({ COMPANION_CONTAINER: 'docker' }, none)).toMatchObject({ runtime: 'docker', hostNetwork: false });
    expect(detectContainer({}, (p) => p === '/.dockerenv')).not.toBeNull();
    expect(detectContainer({ COMPANION_CONTAINER: '0' }, () => true)).toBeNull();
  });
  it('reads the projects mount (only when it exists), host networking, socket and published port', () => {
    const c = detectContainer(
      {
        COMPANION_CONTAINER: 'docker',
        COMPANION_PROJECTS_DIR: dir,
        COMPANION_NETWORK: 'host',
        COMPANION_TAILSCALE_SOCKET: '/var/run/tailscale/tailscaled.sock',
        COMPANION_PUBLISHED_PORT: '9744',
      },
      fs.existsSync
    );
    expect(c).toEqual({
      runtime: 'docker',
      projectsDir: dir,
      hostNetwork: true,
      tailscaleSocket: '/var/run/tailscale/tailscaled.sock',
      publishedPort: 9744,
    });
    const bad = detectContainer(
      { COMPANION_CONTAINER: 'docker', COMPANION_PROJECTS_DIR: path.join(dir, 'missing'), COMPANION_TAILSCALE_SOCKET: 'rel.sock', COMPANION_PUBLISHED_PORT: 'x' },
      fs.existsSync
    );
    expect(bad).toMatchObject({ projectsDir: null, tailscaleSocket: null, publishedPort: null });
  });
  it('the pairing banner shows the code and a sanitized device name', () => {
    const b = pairingCodeBanner('123456', 'Chris\u0007 iPad');
    expect(b.join('\n')).toContain('PAIRING CODE:  123 456');
    expect(b.join('\n')).toContain('"Chris? iPad"');
    expect(new Set(b.map((l) => l.length)).size).toBe(1);
  });
});

// ------------------------------------------------------------------ /health

describe('GET /health', () => {
  const env = process.env.COMPANION_VERSION;
  afterEach(() => {
    if (env === undefined) delete process.env.COMPANION_VERSION;
    else process.env.COMPANION_VERSION = env;
  });

  it('answers ok, version and setupComplete only', () => {
    expect(healthPayload({ setupComplete: false })).toEqual({
      ok: true,
      version: appVersion(),
      setupComplete: false,
    });
    // An existing install (no key) is complete.
    const p = healthPayload({});
    expect(p.setupComplete).toBe(true);
    expect(p.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('a runtime COMPANION_VERSION no longer overrides the build version', () => {
    process.env.COMPANION_VERSION = '9.9.9';
    expect(healthPayload({}).version).toBe(appVersion());
  });

  async function serve(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
    const srv = http.createServer(handler);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    return { port, close: () => new Promise((r) => srv.close(() => r())) };
  }
  const get = (port: number, p: string, method = 'GET') =>
    new Promise<{ status: number; body: string; type: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, method }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode || 0, body, type: String(res.headers['content-type']) }));
      });
      req.on('error', reject);
      req.end();
    });

  it('the daemon HTTP handler serves it unauthenticated, with no secrets', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const config = {
      listeners: [{ port: 1, token: 'listener-secret-token', tls: false }],
      setupComplete: false,
      name: 'Secret Name',
    } as unknown as DaemonConfig;
    const s = await serve(createQRRequestHandler(config));
    try {
      const r = await get(s.port, '/health');
      expect(r.status).toBe(200);
      expect(r.type).toContain('application/json');
      expect(JSON.parse(r.body)).toEqual({ ok: true, version: appVersion(), setupComplete: false });
      expect(r.body).not.toContain('listener-secret-token');
      expect(r.body).not.toContain('Secret Name');
      // Completing setup shows up live (same config object).
      config.setupComplete = true;
      expect(JSON.parse((await get(s.port, '/health?x=1')).body).setupComplete).toBe(true);
      expect((await get(s.port, '/health', 'HEAD')).body).toBe('');
      expect((await get(s.port, '/health', 'POST')).status).toBe(405);
    } finally {
      await s.close();
      jest.restoreAllMocks();
    }
  });

  it('other paths are left to the caller', () => {
    const res = { writeHead: jest.fn(), end: jest.fn() } as unknown as http.ServerResponse;
    const req = { method: 'GET' } as http.IncomingMessage;
    expect(handleHealthRequest(req, res, '/healthz', {})).toBe(false);
    expect(handleHealthRequest(req, res, '/web/health', {})).toBe(false);
  });
});

// ------------------------------------------------------------------ checks

const ok = (stdout: string): RunResult => ({ ok: true, stdout, missing: false, timedOut: false, code: 0 });
const missing: RunResult = { ok: false, stdout: '', missing: true, timedOut: false, code: null };

function checkEnv(over: Partial<CheckEnv> = {}, table: Record<string, RunResult> = {}): CheckEnv {
  const run: Runner = async (cmd) => table[cmd] ?? missing;
  return {
    run,
    platform: 'linux',
    home: '/home/companion',
    codeHome: '/home/companion/.claude',
    nodeVersion: 'v20.20.2',
    voiceUrl: 'http://herald-voice:9889',
    daemonPorts: [9877],
    freeBytes: async () => 50 * 1024 ** 3,
    voiceHealthy: async () => false,
    portFree: async () => false,
    exists: () => false,
    supervisor: () => null,
    ...over,
  };
}
const byId = (list: PrereqCheck[]) => Object.fromEntries(list.map((c) => [c.id, c])) as Record<PrereqId, PrereqCheck>;

describe('setup checks in a container', () => {
  it('compose commands replace apt, npm -g and systemd; no voice-port conflict', async () => {
    const r = byId(await runChecks(checkEnv({ container: DOCKER }, { tmux: ok('tmux 3.3a'), git: ok('git version 2.39.5') })));
    expect(r.tmux.status).toBe('ok');
    expect(r.claude_installed).toMatchObject({ status: 'fail', command: DOCKER_COMMANDS.setupClaude });
    expect(r.claude_login).toMatchObject({ status: 'warn', command: DOCKER_COMMANDS.claude });
    expect(r.service).toMatchObject({ status: 'ok', detail: expect.stringContaining('unless-stopped') });
    expect(r.port.status).toBe('ok'); // the voice port belongs to another container
    expect(r.herald_voice).toMatchObject({ status: 'warn', command: DOCKER_COMMANDS.voiceUp });
    expect(r.tailscale).toMatchObject({ status: 'warn', command: DOCKER_COMMANDS.tailscaleUp });
  });

  it('a missing tmux points at the image, not apt', async () => {
    const r = byId(await runChecks(checkEnv({ container: DOCKER }), ['tmux']));
    expect(r.tmux).toMatchObject({ status: 'fail', command: 'bin/docker update' });
  });

  it('Tailscale sidecar: running and connected / not connected', async () => {
    const sock = { ...DOCKER, tailscaleSocket: '/x.sock' };
    const up = byId(
      await runChecks(
        checkEnv({ container: sock, tailscale: async () => ({ installed: true, up: true, dnsName: 'companion.tail1.ts.net' }) }),
        ['tailscale']
      )
    );
    expect(up.tailscale).toMatchObject({ status: 'ok', detail: 'Sidecar connected as companion.tail1.ts.net' });
    const down = byId(
      await runChecks(checkEnv({ container: sock, tailscale: async () => ({ installed: true, up: false, dnsName: null }) }), ['tailscale'])
    );
    expect(down.tailscale).toMatchObject({ status: 'warn', command: 'docker compose logs tailscale' });
  });

  it('a host install keeps its own guidance', async () => {
    const r = byId(await runChecks(checkEnv(), ['claude_installed', 'service']));
    expect(r.claude_installed.command).toBe('npm install -g @anthropic-ai/claude-code');
    expect(r.service.command).toBe('bin/companion autostart enable --no-start');
  });
});

// ------------------------------------------------------------------ tailscale socket

describe('Tailscale LocalAPI over the sidecar socket', () => {
  async function fakeTailscaled(body: string): Promise<{ sock: string; paths: string[]; close: () => Promise<void> }> {
    const sock = path.join(dir, `ts-${Math.random().toString(36).slice(2)}.sock`);
    const paths: string[] = [];
    const srv = http.createServer((req, res) => {
      paths.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    });
    await new Promise<void>((r) => srv.listen(sock, r));
    return { sock, paths, close: () => new Promise((r) => srv.close(() => r())) };
  }

  it('reads BackendState and Self.DNSName with a read-only GET', async () => {
    const t = await fakeTailscaled(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'companion.tail1.ts.net.' } }));
    try {
      expect(await tailscaleStatusViaSocket(t.sock)).toEqual({ installed: true, up: true, dnsName: 'companion.tail1.ts.net' });
      expect(t.paths).toEqual(['GET /localapi/v0/status']);
    } finally {
      await t.close();
    }
  });

  it('NeedsLogin is not up; junk is not up; no socket is not running', async () => {
    const t = await fakeTailscaled(JSON.stringify({ BackendState: 'NeedsLogin', Self: {} }));
    const j = await fakeTailscaled('not json');
    try {
      expect(await tailscaleStatusViaSocket(t.sock)).toEqual({ installed: true, up: false, dnsName: null });
      expect(await tailscaleStatusViaSocket(j.sock)).toEqual({ installed: true, up: false, dnsName: null });
      expect(await tailscaleStatusViaSocket(path.join(dir, 'nope.sock'))).toEqual({ installed: false, up: false, dnsName: null });
    } finally {
      await t.close();
      await j.close();
    }
  });
});

// ------------------------------------------------------------------ info

describe('setup info in a container', () => {
  const paths = { platform: 'linux' as NodeJS.Platform, home: dir, binDir: '/x/bin', daemonEntry: '/x/index.js', nodePath: '/n', voiceHome: dir };

  it('services: nothing to install, compose does it', () => {
    const d = servicePlan('daemon', { ...paths, container: DOCKER });
    expect(d.exec).toBeNull();
    expect(d.info).toMatchObject({ supported: false, installed: true });
    const v = servicePlan('voice', { ...paths, container: DOCKER });
    expect(v.exec).toBeNull();
    expect(v.info.command).toBe('docker compose --profile voice up -d');
  });

  it('remote: sidecar URL is HTTPS on 443; bridge networks hide container IPs', async () => {
    const run: Runner = async () => missing;
    const sidecar = await remoteAccessInfo({
      run,
      port: 9877,
      tls: false,
      lan: ['172.18.0.2'],
      container: { ...DOCKER, tailscaleSocket: '/s' },
      tailscale: async () => ({ installed: true, up: true, dnsName: 'companion.tail1.ts.net' }),
    });
    expect(sidecar.tailscale.url).toBe('https://companion.tail1.ts.net/web/');
    expect(sidecar.lanUrls).toEqual([]);
    const host = await remoteAccessInfo({ run, port: 9877, tls: false, lan: ['192.168.1.5'], container: { ...DOCKER, hostNetwork: true } });
    expect(host.lanUrls).toEqual(['http://192.168.1.5:9877/web/']);
  });

  it('feed URL: default public feed, override, off, and unsafe values refused', () => {
    expect(appFeedUrl({})).toBe(DEFAULT_APP_FEED_URL);
    expect(appFeedUrl({ COMPANION_APP_FEED_URL: 'https://example.com/feed/stable' })).toBe('https://example.com/feed/stable/');
    expect(appFeedUrl({ COMPANION_APP_FEED_URL: '' })).toBeNull();
    expect(appFeedUrl({ COMPANION_APP_FEED_URL: 'off' })).toBeNull();
    expect(appFeedUrl({ COMPANION_APP_FEED_URL: 'file:///etc/' })).toBeNull();
    expect(appFeedUrl({ COMPANION_APP_FEED_URL: 'https://u:p@example.com/' })).toBeNull();
  });

  it('downloads: the local feed wins; an empty one falls back to the public feed (cached)', async () => {
    resetRemoteFeedCacheForTests();
    const empty = path.join(dir, 'feed-empty');
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      if (url.endsWith('android.json')) return { versionName: '1.0.521', url: 'https://feed.example/stable/Companion_1.0.521.apk' };
      return { version: '1.0.521', platforms: { 'linux-x86_64': { url: 'https://feed.example/stable/C.AppImage' } } };
    };
    let t = 1000;
    const r = await appDownloadsWithFallback(empty, 'https://feed.example/stable/', fetcher, () => t);
    expect(r.source).toBe('remote');
    expect(r.downloads.map((d) => [d.platform, d.localPath])).toEqual([
      ['android', null],
      ['linux', null],
    ]);
    expect(calls).toEqual([
      'https://feed.example/stable/android.json',
      'https://feed.example/stable/latest.json',
      'https://feed.example/stable/installers.json',
    ]);
    t += 60_000;
    await appDownloadsWithFallback(empty, 'https://feed.example/stable/', fetcher, () => t);
    expect(calls).toHaveLength(3); // cached
    // Off: no network at all.
    const off = await appDownloadsWithFallback(empty, null, fetcher, () => t);
    expect(off).toMatchObject({ source: 'none', feedUrl: null, downloads: [] });

    const local = path.join(dir, 'feed-local', 'stable');
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, 'android.json'), JSON.stringify({ versionName: '2.0.0', url: 'https://x/stable/A.apk' }));
    const l = await appDownloadsWithFallback(path.dirname(local), 'https://feed.example/stable/', fetcher, () => t);
    expect(l.source).toBe('local');
    expect(calls).toHaveLength(3);
  });

  it('downloads: an unreachable public feed is "none", not an error', async () => {
    resetRemoteFeedCacheForTests();
    const r = await appDownloadsWithFallback(path.join(dir, 'nothing'), 'https://down.example/', async () => null);
    expect(r).toMatchObject({ source: 'none', downloads: [], feedUrl: 'https://down.example/' });
  });
});

// ------------------------------------------------------------------ SetupService

describe('setup service in a container', () => {
  const home = path.join(dir, 'home');
  const projects = path.join(home, 'projects');
  fs.mkdirSync(path.join(projects, 'demo-app'), { recursive: true });
  fs.mkdirSync(path.join(home, 'private'), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify({ port: 9877, token: 't', setup_complete: false }));

  function service(container: ContainerInfo | null, run: Runner = async () => missing, env: NodeJS.ProcessEnv = {}) {
    const config = {
      listeners: [{ port: 9877, token: 't', tls: false }],
      tmuxSession: 'main',
      mdnsEnabled: false,
      setupComplete: false,
      projectRoots: [],
    } as unknown as DaemonConfig;
    const unused = () => {
      throw new Error('unused');
    };
    return new SetupService({
      config,
      configPath: () => cfgPath,
      identity: () => ({ id: 'id', name: 'Test', version: '1.0.0' }),
      rename: () => {},
      deviceCount: () => 1,
      checks: { run: async () => [] } as never,
      run,
      state: new SetupStateStore(path.join(dir, 'setup-state.json')),
      home,
      feedDir: () => path.join(dir, 'nofeed'),
      lanAddresses: () => [],
      servicePaths: unused as never,
      reloadHerald: () => 'live',
      spawnSession: async () => ({ ok: true, sessionName: 's1' }),
      sessionExists: async () => true,
      capturePane: async () => '',
      conversationFor: () => false,
      sendToSession: async () => true,
      secretsFromFile: new Set(),
      env,
      log: () => {},
      container,
    });
  }

  it('status reports the container; a host install reports null', () => {
    const c = { ...DOCKER, projectsDir: projects, tailscaleSocket: '/s' };
    expect(service(c).status().container).toEqual({ runtime: 'docker', projectsDir: projects, hostNetwork: false, tailscaleSidecar: true });
    expect(service(null).status().container).toBeNull();
  });

  it('the folder picker is rooted at the projects mount', () => {
    const s = service({ ...DOCKER, projectsDir: projects });
    const root = s.listDirs({});
    expect(root.path).toBe(fs.realpathSync(projects));
    expect(root.parent).toBeNull();
    expect(root.entries.map((e) => e.name)).toEqual(['demo-app']);
    expect(() => s.listDirs({ path: path.join(home, 'private') })).toThrow();
    expect(() => s.listDirs({ path: '../private' })).toThrow();
    // A host install still browses $HOME.
    expect(service(null).listDirs({}).entries.map((e) => e.name)).toEqual(['private', 'projects']);
  });

  it('project roots and the first session must be inside the projects mount', async () => {
    const s = service({ ...DOCKER, projectsDir: projects });
    expect(() => s.updateSettings({ projectRoots: [path.join(home, 'private')] })).toThrow();
    s.updateSettings({ projectRoots: [projects] });
    await expect(s.startSession(path.join(home, 'private'))).rejects.toMatchObject({ code: 'forbidden' });
    const p = await s.startSession(path.join(projects, 'demo-app'));
    expect(p.attachCommand).toBe('docker compose exec companion tmux attach -t s1');
  });

  it('install Claude Code: container only, explicit confirm, reports the version', async () => {
    await expect(service(null).installClaude(true)).rejects.toMatchObject({ code: 'unavailable' });
    const calls: string[][] = [];
    const run: Runner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return cmd === 'claude' ? ok('2.1.289 (Claude Code)\n') : ok('Installing...\nInstalled: 2.1.289\n');
    };
    const s = service(DOCKER, run, { COMPANION_SETUP_CLAUDE: '/app/docker/setup-claude.sh' });
    await expect(s.installClaude(undefined)).rejects.toMatchObject({ code: 'bad_request' });
    const r = await s.installClaude(true);
    expect(r).toMatchObject({ ok: true, version: '2.1.289 (Claude Code)' });
    expect(calls).toEqual([['/app/docker/setup-claude.sh', '--quiet'], ['claude', '--version']]);
    // No script configured (not the image): point at the compose command.
    await expect(service(DOCKER, run, {}).installClaude(true)).rejects.toMatchObject({ code: 'unavailable' });
    // The installer ran but claude still does not start.
    const broken = service(DOCKER, async (cmd) => (cmd === 'claude' ? missing : ok('x')), { COMPANION_SETUP_CLAUDE: '/s.sh' });
    expect(await broken.installClaude(true)).toMatchObject({ ok: false, version: null });
  });
});

// ------------------------------------------------------------------ config

describe('COMPANION_MDNS', () => {
  afterEach(() => {
    delete process.env.COMPANION_MDNS;
    jest.restoreAllMocks();
  });
  it('wins over the config file on every start when set', () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    fs.writeFileSync(cfgPath, JSON.stringify({ port: 9877, token: 't', mdns_enabled: true }));
    expect(loadConfig().mdnsEnabled).toBe(true);
    process.env.COMPANION_MDNS = '0';
    expect(loadConfig().mdnsEnabled).toBe(false);
    fs.writeFileSync(cfgPath, JSON.stringify({ port: 9877, token: 't', mdns_enabled: false }));
    process.env.COMPANION_MDNS = '1';
    expect(loadConfig().mdnsEnabled).toBe(true);
    // The file itself is not rewritten by the override.
    expect(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).mdns_enabled).toBe(false);
  });
});
