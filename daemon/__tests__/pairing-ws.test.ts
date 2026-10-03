/**
 * Pairing + device-token auth through the real WebSocketHandler (mock sockets).
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
  WebSocket: Object.assign(
    jest.fn().mockImplementation(() => new MockWebSocket()),
    { OPEN: 1 }
  ),
  WebSocketServer: jest.fn().mockImplementation(() => new MockWebSocketServer()),
  OPEN: 1,
}));

const MAIN = 'main-token-for-pairing-tests';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-ws-'));
process.env.COMPANION_DEVICES_FILE = path.join(dir, 'devices.json');
process.env.COMPANION_HERALD_TRIGGER_TOKEN_FILE = path.join(dir, 'herald-trigger.token');

const mockWatcher = new EventEmitter() as any;
mockWatcher.getSessions = jest.fn().mockReturnValue([]);
mockWatcher.getActiveConversation = jest.fn().mockReturnValue(null);
mockWatcher.getConversationInfo = jest.fn().mockReturnValue(null);
const mockInjector = {
  sendInput: jest.fn().mockResolvedValue(true),
  getActiveSession: jest.fn().mockReturnValue('claude'),
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
const config: DaemonConfig = {
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
};

type Sent = {
  type: string;
  success: boolean;
  payload?: any;
  error?: string;
  requestId?: string;
  [k: string]: any;
};
const sentOf = (ws: MockWebSocket): Sent[] =>
  ws.send.mock.calls.map((c) => JSON.parse(c[0] as string));
const last = (ws: MockWebSocket, type: string) =>
  sentOf(ws)
    .filter((m) => m.type === type)
    .at(-1);

describe('pairing over the WebSocket', () => {
  let handler: WebSocketHandler;
  let wss: MockWebSocketServer;
  let audit: jest.SpyInstance;
  let logs: jest.SpyInstance[];
  let sockets: MockWebSocket[] = [];

  beforeEach(() => {
    fs.rmSync(path.join(dir, 'devices.json'), { force: true });
    logs = [
      jest.spyOn(console, 'log').mockImplementation(() => {}),
      jest.spyOn(console, 'warn').mockImplementation(() => {}),
      jest.spyOn(console, 'error').mockImplementation(() => {}),
    ];
    handler = new WebSocketHandler(
      [{ server: new EventEmitter() as unknown as Server, listener }],
      config,
      mockWatcher,
      mockInjector,
      mockPush
    );
    audit = jest.spyOn((handler as any).auditLog, 'append').mockImplementation(() => {});
    wss = (handler as any).wssMap.get(9877);
  });

  afterEach(() => {
    for (const ws of sockets) ws.emit('close', 1000, Buffer.from(''));
    sockets = [];
    handler.shutdown();
    clearInterval((handler as any).deadConnectionInterval);
    logs.forEach((l) => l.mockRestore());
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  function open(addr = '192.168.1.50'): MockWebSocket {
    const ws = new MockWebSocket();
    sockets.push(ws);
    wss.emit('connection', ws, { socket: { remoteAddress: addr }, headers: {} });
    return ws;
  }
  function msg(
    ws: MockWebSocket,
    type: string,
    payload?: unknown,
    extra: Record<string, unknown> = {}
  ) {
    ws.emit('message', JSON.stringify({ type, payload, requestId: `${type}-r`, ...extra }));
  }
  function signedIn(token = MAIN, addr = '127.0.0.1'): MockWebSocket {
    const ws = open(addr);
    msg(ws, 'authenticate', undefined, { token });
    return ws;
  }

  it('an unauthenticated socket may only do the pairing handshake', () => {
    const ws = open();
    msg(ws, 'get_sessions');
    expect(last(ws, 'error')).toMatchObject({ success: false, error: 'Not authenticated' });
    msg(ws, 'devices_list');
    expect(last(ws, 'error')).toMatchObject({ error: 'Not authenticated' });
    msg(ws, 'pair_approve', { pairingId: 'x' });
    expect(last(ws, 'error')).toMatchObject({ error: 'Not authenticated' });
    msg(ws, 'pair_hello');
    const hello = last(ws, 'pair_hello')!;
    expect(hello.success).toBe(true);
    expect(Object.keys(hello.payload).sort()).toEqual([
      'codePairing',
      'daemonId',
      'name',
      'pairing',
      'version',
    ]);
    expect(JSON.stringify(hello)).not.toContain(MAIN);
  });

  it('code pairing end to end: request, pending broadcast, confirm, then the device token signs in', () => {
    const admin = signedIn();
    const dev = open();
    msg(dev, 'pair_request', { deviceName: 'Pixel 9', platform: 'android', publicNonce: 'n1' });
    const req = last(dev, 'pair_request')!;
    expect(req.success).toBe(true);
    const pending = last(admin, 'pair_pending')!.payload.pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      deviceName: 'Pixel 9',
      platform: 'android',
      addr: '192.168.1.50',
    });
    // The requester never sees the code.
    expect(JSON.stringify(sentOf(dev))).not.toContain(pending[0].code);

    msg(dev, 'pair_confirm', { pairingId: req.payload.pairingId, code: pending[0].code });
    const res = last(dev, 'pair_confirm')!;
    expect(res.success).toBe(true);
    expect(res.payload).toMatchObject({
      status: 'approved',
      deviceName: 'Pixel 9',
      publicNonce: 'n1',
    });
    expect(last(admin, 'pair_pending')!.payload.pending).toEqual([]);

    const again = signedIn(res.payload.token, '192.168.1.50');
    const auth = last(again, 'authenticated')!;
    expect(auth).toMatchObject({
      success: true,
      authKind: 'device',
      deviceId: res.payload.deviceId,
    });
    expect(auth.daemonId).toMatch(/^[0-9a-f]{32}$/);

    // Every step was audited, never with the code or token.
    const actions = audit.mock.calls.map((c) => c[0].action);
    expect(actions).toEqual(expect.arrayContaining(['pair_request', 'pair_confirm']));
    const blob = JSON.stringify(audit.mock.calls);
    expect(blob).not.toContain(pending[0].code);
    expect(blob).not.toContain(res.payload.token);
  });

  it('approval from a signed-in client delivers the token to the waiting device', () => {
    const admin = signedIn();
    const dev = open();
    msg(dev, 'pair_request', { deviceName: 'iPad', platform: 'ios', publicNonce: 'n2' });
    const { pairingId } = last(dev, 'pair_request')!.payload;
    msg(admin, 'pair_approve', { pairingId });
    expect(last(admin, 'pair_approve')!.success).toBe(true);
    const result = last(dev, 'pair_result')!;
    expect(result.payload).toMatchObject({
      status: 'approved',
      via: 'approval',
      deviceName: 'iPad',
    });
  });

  it('deny reaches the device', () => {
    const admin = signedIn();
    const dev = open();
    msg(dev, 'pair_request', { deviceName: 'iPad', platform: 'ios', publicNonce: 'n2' });
    const { pairingId } = last(dev, 'pair_request')!.payload;
    msg(admin, 'pair_deny', { pairingId });
    expect(last(dev, 'pair_result')!.payload).toEqual({ status: 'denied', pairingId });
  });

  it('code pairing from the internet is refused; via a trusted proxy the real client counts', () => {
    const dev = open('203.0.113.9');
    msg(dev, 'pair_request', { deviceName: 'x', platform: 'web', publicNonce: 'n' });
    expect(last(dev, 'pair_request')).toMatchObject({
      success: false,
      payload: { code: 'untrusted_network' },
    });

    const proxied = new MockWebSocket();
    sockets.push(proxied);
    wss.emit('connection', proxied, {
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    msg(proxied, 'pair_request', { deviceName: 'x', platform: 'web', publicNonce: 'n' });
    expect(last(proxied, 'pair_request')).toMatchObject({ payload: { code: 'untrusted_network' } });
  });

  it('QR pairing: create (signed in), redeem from anywhere, single use', () => {
    const admin = signedIn();
    msg(admin, 'pair_qr_create', { host: 'box.example', port: 443, tls: true });
    return new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
      for (let i = 0; i < 20 && !last(admin, 'pair_qr_create'); i++)
        await new Promise((r) => setTimeout(r, 10));
      const qr = last(admin, 'pair_qr_create')!;
      expect(qr.success).toBe(true);
      const url = new URL(qr.payload.link);
      expect(url.protocol).toBe('companion:');
      expect(url.searchParams.get('host')).toBe('box.example');
      expect(url.searchParams.get('tls')).toBe('1');
      expect(qr.payload.qrDataUrl).toMatch(/^data:image\/png;base64,/);
      const otp = url.searchParams.get('otp');

      const dev = open('198.51.100.7');
      msg(dev, 'pair_redeem_qr', { otp, deviceName: 'Work laptop', platform: 'desktop' });
      expect(last(dev, 'pair_redeem_qr')!.payload).toMatchObject({ status: 'approved', via: 'qr' });
      const dev2 = open('198.51.100.8');
      msg(dev2, 'pair_redeem_qr', { otp, deviceName: 'Replay', platform: 'desktop' });
      expect(last(dev2, 'pair_redeem_qr')).toMatchObject({
        success: false,
        payload: { code: 'bad_otp' },
      });
    });
  });

  it('legacy token still works and can upgrade to a device token', () => {
    const admin = signedIn();
    expect(last(admin, 'authenticated')).toMatchObject({ success: true, authKind: 'legacy' });
    msg(admin, 'device_upgrade', { deviceName: 'Old phone', platform: 'android' });
    const up = last(admin, 'device_upgrade')!;
    expect(up.payload).toMatchObject({ status: 'approved', via: 'upgrade' });
    const dev = signedIn(up.payload.token);
    expect(last(dev, 'authenticated')).toMatchObject({ authKind: 'device' });
    // A device-token client cannot upgrade again.
    msg(dev, 'device_upgrade', { deviceName: 'x', platform: 'android' });
    expect(last(dev, 'device_upgrade')).toMatchObject({
      success: false,
      payload: { code: 'not_legacy' },
    });
  });

  it('devices_list / rename / revoke; revoke closes live sockets and the token is refused', () => {
    const admin = signedIn();
    msg(admin, 'device_upgrade', { deviceName: 'Phone', platform: 'android' });
    const { token, deviceId } = last(admin, 'device_upgrade')!.payload;
    const dev = signedIn(token, '192.168.1.60');

    msg(dev, 'devices_list');
    const list = last(dev, 'devices_list')!.payload;
    expect(list.currentDeviceId).toBe(deviceId);
    expect(list.devices[0]).not.toHaveProperty('tokenHash');
    expect(list.devices[0]).not.toHaveProperty('salt');

    msg(admin, 'device_rename', { deviceId, name: 'Pixel' });
    expect(last(admin, 'device_rename')!.payload.device.name).toBe('Pixel');

    msg(admin, 'device_revoke', { deviceId });
    expect(last(admin, 'device_revoke')!.success).toBe(true);
    expect(last(dev, 'token_invalidated')!.payload).toEqual({ reason: 'device_revoked' });
    expect(dev.close).toHaveBeenCalledWith(WebSocketHandler.CLOSE_DEVICE_REVOKED, 'device_revoked');

    const retry = signedIn(token);
    expect(last(retry, 'authenticated')).toMatchObject({ success: false, error: 'device_revoked' });
    msg(retry, 'get_sessions');
    expect(last(retry, 'error')).toMatchObject({ error: 'Not authenticated' });
  });

  it('a wrong main token is still refused', () => {
    const ws = signedIn('nope');
    expect(last(ws, 'authenticated')).toMatchObject({ success: false });
  });

  it('pairing:false refuses requests', () => {
    (config as any).pairing = false;
    try {
      const dev = open();
      msg(dev, 'pair_request', { deviceName: 'x', platform: 'web', publicNonce: 'n' });
      expect(last(dev, 'pair_request')).toMatchObject({ payload: { code: 'pairing_disabled' } });
    } finally {
      delete (config as any).pairing;
    }
  });
});
