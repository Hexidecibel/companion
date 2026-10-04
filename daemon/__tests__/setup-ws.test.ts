/**
 * Setup mode through the real WebSocketHandler (mock sockets): loopback
 * auto-pair rules, the setup API gate (auth, credential kind, network), and
 * existing installs never entering setup mode.
 */
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Server } from 'http';

class MockWebSocket extends EventEmitter {
  readyState = 1;
  send = jest.fn();
  close = jest.fn();
  ping = jest.fn();
  terminate = jest.fn();
}
class MockWebSocketServer extends EventEmitter {
  clients = new Set<MockWebSocket>();
  close = jest.fn((cb?: () => void) => cb?.());
}
jest.mock('ws', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => new MockWebSocket()),
  WebSocket: Object.assign(jest.fn().mockImplementation(() => new MockWebSocket()), { OPEN: 1 }),
  WebSocketServer: jest.fn().mockImplementation(() => new MockWebSocketServer()),
  OPEN: 1,
}));

const MAIN = 'main-token-for-setup-tests';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-ws-'));
process.env.COMPANION_DEVICES_FILE = path.join(dir, 'devices.json');
process.env.COMPANION_HERALD_TRIGGER_TOKEN_FILE = path.join(dir, 'herald-trigger.token');
process.env.COMPANION_SETUP_STATE_FILE = path.join(dir, 'setup-state.json');
process.env.COMPANION_SECRETS_FILE = path.join(dir, 'secrets.env');
process.env.COMPANION_CONFIG = path.join(dir, 'config.json');

const mockWatcher = new EventEmitter() as any;
mockWatcher.getSessions = jest.fn().mockReturnValue([]);
mockWatcher.getActiveConversation = jest.fn().mockReturnValue(null);
mockWatcher.getConversationInfo = jest.fn().mockReturnValue(null);
mockWatcher.getConversationIdsForSession = jest.fn().mockReturnValue([]);
const mockInjector = {
  sendInput: jest.fn().mockResolvedValue(true),
  getActiveSession: jest.fn().mockReturnValue('claude'),
  checkSessionExists: jest.fn().mockResolvedValue(true),
} as any;
const mockStore = {
  getEscalation: jest.fn().mockReturnValue({
    events: {},
    pushDelaySeconds: 300,
    rateLimitSeconds: 60,
    quietHours: { enabled: false, start: '22:00', end: '08:00' },
    mutedSessions: [],
  }),
  getDevices: jest.fn().mockReturnValue([]),
} as any;
const mockPush = {
  getStore: jest.fn().mockReturnValue(mockStore),
  updateDeviceLastSeen: jest.fn(),
  sendToAllDevices: jest.fn(),
} as any;

import { WebSocketHandler } from '../src/websocket';
import type { DaemonConfig } from '../src/types';

const listener = { port: 9877, token: MAIN, tls: false };
function makeConfig(setupComplete: boolean | undefined): DaemonConfig {
  return {
    port: 9877,
    token: MAIN,
    tls: false,
    listeners: [listener],
    tmuxSession: 'claude',
    codeHome: path.join(dir, 'claude'),
    mdnsEnabled: false,
    pushDelayMs: 60000,
    autoApproveTools: [],
    git: false,
    herald: { state_dir: path.join(dir, 'herald'), voice_url: 'http://127.0.0.1:9' },
    ...(setupComplete === undefined ? {} : { setupComplete }),
  };
}

type Sent = { type: string; success: boolean; payload?: any; error?: string; requestId?: string };
const sentOf = (ws: MockWebSocket): Sent[] => ws.send.mock.calls.map((c) => JSON.parse(c[0] as string));
const last = (ws: MockWebSocket, type: string) =>
  sentOf(ws)
    .filter((m) => m.type === type)
    .at(-1);

describe('setup mode over the WebSocket', () => {
  let handler: WebSocketHandler;
  let wss: MockWebSocketServer;
  let sockets: MockWebSocket[] = [];
  let logs: jest.SpyInstance[];

  function boot(setupComplete: boolean | undefined) {
    fs.writeFileSync(
      process.env.COMPANION_CONFIG!,
      JSON.stringify({ port: 9877, token: MAIN, ...(setupComplete === undefined ? {} : { setup_complete: setupComplete }) })
    );
    handler = new WebSocketHandler(
      [{ server: new EventEmitter() as unknown as Server, listener }],
      makeConfig(setupComplete),
      mockWatcher,
      mockInjector,
      mockPush
    );
    jest.spyOn((handler as any).auditLog, 'append').mockImplementation(() => {});
    wss = (handler as any).wssMap.get(9877);
  }

  beforeEach(() => {
    for (const f of ['devices.json', 'setup-state.json', 'secrets.env']) fs.rmSync(path.join(dir, f), { force: true });
    logs = ['log', 'warn', 'error'].map((m) => jest.spyOn(console, m as 'log').mockImplementation(() => {}));
  });
  afterEach(() => {
    for (const ws of sockets) ws.emit('close', 1000, Buffer.from(''));
    sockets = [];
    handler.shutdown();
    clearInterval((handler as any).deadConnectionInterval);
    logs.forEach((l) => l.mockRestore());
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  function open(addr: string, headers: Record<string, string> = {}): MockWebSocket {
    const ws = new MockWebSocket();
    sockets.push(ws);
    wss.emit('connection', ws, { socket: { remoteAddress: addr }, headers });
    return ws;
  }
  const local = (extra: Record<string, string> = {}) =>
    open('127.0.0.1', { host: 'localhost:9877', origin: 'http://localhost:9877', ...extra });
  function msg(ws: MockWebSocket, type: string, payload?: unknown, extra: Record<string, unknown> = {}) {
    ws.emit('message', JSON.stringify({ type, payload, requestId: `${type}-r`, ...extra }));
  }
  const flush = () => new Promise((r) => setImmediate(r));

  it('pair_hello advertises setup mode and loopback auto-pair to a local browser', () => {
    boot(false);
    const ws = local();
    msg(ws, 'pair_hello');
    expect(last(ws, 'pair_hello')!.payload).toMatchObject({ setupMode: true, localAutoPair: true });
    const lan = open('192.168.1.20', { host: '192.168.1.5:9877' });
    msg(lan, 'pair_hello');
    expect(last(lan, 'pair_hello')!.payload).toMatchObject({ setupMode: true, localAutoPair: false });
    const pub = open('8.8.8.8', { host: 'example.com' });
    msg(pub, 'pair_hello');
    expect(last(pub, 'pair_hello')!.payload.setupMode).toBeUndefined();
  });

  it('auto-pair: refused from the LAN, a foreign Origin, a non-loopback Host, or through a proxy', () => {
    boot(false);
    const cases = [
      open('192.168.1.20', { host: '192.168.1.5:9877' }),
      local({ origin: 'https://evil.example' }),
      local({ host: 'rebind.attacker.com:9877', origin: 'http://rebind.attacker.com:9877' }),
      local({ 'x-forwarded-for': '203.0.113.9' }),
      local({ 'x-real-ip': '203.0.113.9' }),
      local({ origin: 'null' }),
    ];
    for (const ws of cases) {
      msg(ws, 'setup_pair_local', { deviceName: 'x', platform: 'web' });
      expect(last(ws, 'setup_pair_local')).toMatchObject({ success: false, payload: { code: 'not_allowed' } });
    }
    expect(fs.existsSync(path.join(dir, 'devices.json'))).toBe(false);
  });

  it('auto-pair works once from a loopback browser (or a no-Origin native client), then never again', () => {
    boot(false);
    const ws = local();
    msg(ws, 'setup_pair_local', { deviceName: 'Chrome on Linux', platform: 'web' });
    const r = last(ws, 'setup_pair_local')!;
    expect(r.success).toBe(true);
    expect(r.payload).toMatchObject({ status: 'approved', deviceName: 'Chrome on Linux' });
    expect(r.payload.token).toMatch(/^cdt1\./);

    const again = open('127.0.0.1', { host: '127.0.0.1:9877' });
    msg(again, 'pair_hello');
    expect(last(again, 'pair_hello')!.payload.localAutoPair).toBe(false);
    msg(again, 'setup_pair_local', { deviceName: 'second', platform: 'web' });
    expect(last(again, 'setup_pair_local')!.success).toBe(false);
  });

  it('setup API: refused unauthenticated, works for a paired device on the LAN', async () => {
    boot(false);
    const anon = local();
    msg(anon, 'setup_status');
    expect(last(anon, 'error')).toMatchObject({ error: 'Not authenticated' });

    const pairer = local();
    msg(pairer, 'setup_pair_local', { deviceName: 'Me', platform: 'web' });
    const token = last(pairer, 'setup_pair_local')!.payload.token;

    const dev = open('192.168.1.20', { host: '192.168.1.5:9877' });
    msg(dev, 'authenticate', undefined, { token });
    expect(last(dev, 'authenticated')!.success).toBe(true);
    msg(dev, 'setup_status');
    await flush();
    const st = last(dev, 'setup_status')!;
    expect(st.success).toBe(true);
    expect(st.payload).toMatchObject({ setupMode: true, deviceCount: 1 });
    expect(JSON.stringify(st)).not.toContain(MAIN);
  });

  it('setup API: refused from public networks, including through an untrusted proxy', async () => {
    boot(false);
    const pub = open('8.8.8.8', { host: 'x' });
    msg(pub, 'authenticate', undefined, { token: MAIN });
    msg(pub, 'setup_status');
    await flush();
    expect(last(pub, 'setup_status')).toMatchObject({ success: false, payload: { code: 'untrusted_network' } });

    // HAProxy on another LAN box forwarding a public client.
    const proxied = open('192.168.1.2', { host: 'dev.example', 'x-forwarded-for': '198.51.100.7' });
    msg(proxied, 'authenticate', undefined, { token: MAIN });
    msg(proxied, 'setup_update', { patch: { name: 'pwned' } });
    await flush();
    expect(last(proxied, 'setup_update')).toMatchObject({ success: false, payload: { code: 'untrusted_network' } });
    const raw = JSON.parse(fs.readFileSync(process.env.COMPANION_CONFIG!, 'utf8'));
    expect(raw.name).toBeUndefined();
  });

  it('setup API: the Herald trigger token cannot use it', async () => {
    boot(false);
    const ws = local();
    msg(ws, 'authenticate', undefined, { token: MAIN });
    (handler as any).clients.forEach((c: any) => {
      if (c.ws === ws) c.scope = 'trigger';
    });
    msg(ws, 'setup_status');
    await flush();
    expect(last(ws, 'setup_status')!.success).toBe(false);
  });

  it('settings write over the API keeps unknown config keys and renames live', async () => {
    boot(false);
    fs.writeFileSync(
      process.env.COMPANION_CONFIG!,
      JSON.stringify({ port: 9877, token: MAIN, setup_complete: false, custom_key: 42 })
    );
    const ws = local();
    msg(ws, 'authenticate', undefined, { token: MAIN });
    msg(ws, 'setup_update', { patch: { name: 'Studio box', pairing: 'lan' } });
    await flush();
    expect(last(ws, 'setup_update')).toMatchObject({ success: true, payload: { serverName: 'Studio box' } });
    const raw = JSON.parse(fs.readFileSync(process.env.COMPANION_CONFIG!, 'utf8'));
    expect(raw).toMatchObject({ name: 'Studio box', custom_key: 42, pairing: true, setup_complete: false });
    msg(ws, 'pair_hello');
    expect(last(ws, 'pair_hello')!.payload.name).toBe('Studio box');

    msg(ws, 'setup_mark_step', { step: 'name', state: 'done' });
    await flush();
    expect(last(ws, 'setup_mark_step')!.payload.steps).toEqual({ name: 'done' });
    msg(ws, 'setup_mark_step', { step: 'pair', state: 'skipped' });
    await flush();
    expect(last(ws, 'setup_mark_step')).toMatchObject({ success: false, payload: { code: 'bad_request' } });

    msg(ws, 'setup_complete');
    await flush();
    expect(last(ws, 'setup_complete')!.payload).toMatchObject({ setupMode: false, setupComplete: true });
    expect(JSON.parse(fs.readFileSync(process.env.COMPANION_CONFIG!, 'utf8')).setup_complete).toBe(true);
    msg(ws, 'pair_hello');
    expect(last(ws, 'pair_hello')!.payload.setupMode).toBeUndefined();
  });

  it('an existing install (no setup_complete key) is not in setup mode: no auto-pair', () => {
    boot(undefined);
    const ws = local();
    msg(ws, 'pair_hello');
    const hello = last(ws, 'pair_hello')!.payload;
    expect(hello.setupMode).toBeUndefined();
    expect(Object.keys(hello).sort()).toEqual(['codePairing', 'daemonId', 'name', 'pairing', 'version']);
    msg(ws, 'setup_pair_local', { deviceName: 'x', platform: 'web' });
    expect(last(ws, 'setup_pair_local')!.success).toBe(false);
  });

  it('the wizard can only poll sessions it started', async () => {
    boot(false);
    const ws = local();
    msg(ws, 'authenticate', undefined, { token: MAIN });
    msg(ws, 'setup_session_progress', { sessionName: 'someone-elses' });
    await flush();
    expect(last(ws, 'setup_session_progress')).toMatchObject({ success: false, payload: { code: 'not_found' } });
    msg(ws, 'setup_start_session', { dir: '/etc' });
    await flush();
    expect(last(ws, 'setup_start_session')).toMatchObject({ success: false, payload: { code: 'forbidden' } });
  });

  it('installing a service needs an explicit confirm', async () => {
    boot(false);
    const ws = local();
    msg(ws, 'authenticate', undefined, { token: MAIN });
    msg(ws, 'setup_install_service', { target: 'daemon' });
    await flush();
    expect(last(ws, 'setup_install_service')).toMatchObject({ success: false, payload: { code: 'bad_request' } });
  });
});
