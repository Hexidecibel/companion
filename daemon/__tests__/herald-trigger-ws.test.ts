/**
 * Trigger token scoping through the real WebSocketHandler: the trigger token
 * authenticates a trigger-only session that is refused every other message
 * type, while the main token can also fire herald_trigger. Routing goes to the
 * device elected by herald_presence (the announcer).
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

const MAIN = 'main-token-for-tests';
const TRIGGER = 'c'.repeat(64);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-trigger-ws-'));
const tokenFile = path.join(dir, 'herald-trigger.token');
fs.writeFileSync(tokenFile, TRIGGER + '\n', { mode: 0o600 });
fs.chmodSync(tokenFile, 0o600);
process.env.COMPANION_HERALD_TRIGGER_TOKEN_FILE = tokenFile;

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
  // Isolated Herald state and an unreachable voice service: never the real ones.
  herald: { state_dir: path.join(dir, 'herald'), voice_url: 'http://127.0.0.1:9' },
};

type Sent = { type: string; success: boolean; payload?: any; error?: string; requestId?: string };

function sentOf(ws: MockWebSocket): Sent[] {
  return ws.send.mock.calls.map((c) => JSON.parse(c[0] as string) as Sent);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

describe('herald_trigger over the WebSocket', () => {
  let handler: WebSocketHandler;
  let wss: MockWebSocketServer;
  let audit: jest.SpyInstance;
  let logs: jest.SpyInstance[];
  let sockets: MockWebSocket[] = [];

  beforeEach(() => {
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

  function connect(token: string): MockWebSocket {
    const ws = new MockWebSocket();
    sockets.push(ws);
    wss.emit('connection', ws, { socket: { remoteAddress: '127.0.0.1' } });
    ws.emit('message', JSON.stringify({ type: 'authenticate', token, requestId: 'auth' }));
    return ws;
  }

  function sendMsg(
    ws: MockWebSocket,
    type: string,
    payload: unknown = {},
    requestId = `r-${type}`
  ) {
    ws.emit('message', JSON.stringify({ type, payload, requestId }));
  }

  it('the trigger token authenticates a trigger-only session', () => {
    const ws = connect(TRIGGER);
    const auth = sentOf(ws).find((m) => m.type === 'authenticated')!;
    expect(auth).toMatchObject({ success: true, scope: 'trigger' });
    const main = connect(MAIN);
    const mainAuth = sentOf(main).find((m) => m.type === 'authenticated') as Sent & {
      scope?: string;
    };
    expect(mainAuth.success).toBe(true);
    expect(mainAuth.scope).toBeUndefined();
  });

  it('rejects the trigger token for every other message type', async () => {
    const ws = connect(TRIGGER);
    const types = [
      ...Array.from(((handler as any).handlers as Map<string, unknown>).keys()),
      'rotate_token',
      'no_such_type',
    ].filter((t) => t !== 'herald_trigger');
    expect(types).toEqual(
      expect.arrayContaining([
        'subscribe',
        'send_input',
        'herald_send',
        'herald_presence',
        'get_highlights',
      ])
    );
    for (const t of types) sendMsg(ws, t, { text: 'x', sessionId: 's' });
    await flush();
    const replies = sentOf(ws).filter((m) => m.requestId && m.requestId !== 'auth');
    expect(replies).toHaveLength(types.length);
    for (const r of replies) {
      expect(r).toMatchObject({ success: false, payload: { code: 'forbidden' } });
      expect(r.error).toMatch(/only fire Herald triggers/);
    }
    expect(mockInjector.sendInput).not.toHaveBeenCalled();
    // ping still keeps the socket alive.
    sendMsg(ws, 'ping');
    expect(sentOf(ws).pop()).toMatchObject({ type: 'pong', success: true });
  });

  it('routes a trigger to the active device; 409 with no device', async () => {
    const trig = connect(TRIGGER);
    sendMsg(trig, 'herald_trigger', { action: 'toggle' }, 't0');
    await flush();
    expect(sentOf(trig).find((m) => m.requestId === 't0')).toMatchObject({
      success: false,
      payload: { code: 'no_active_device' },
    });

    const desk = connect(MAIN);
    const phone = connect(MAIN);
    sendMsg(desk, 'herald_presence', { interacted: false });
    sendMsg(phone, 'herald_presence', { interacted: true });
    await flush();
    desk.send.mockClear();
    phone.send.mockClear();

    sendMsg(trig, 'herald_trigger', { action: 'brief' }, 't1');
    await flush();
    expect(sentOf(trig).find((m) => m.requestId === 't1')).toMatchObject({
      success: true,
      payload: { action: 'brief', delivered: true },
    });
    const pushed = sentOf(phone).filter((m) => m.type === 'herald_event');
    expect(pushed).toHaveLength(1);
    expect(pushed[0].payload).toMatchObject({ kind: 'trigger', action: 'brief' });
    expect(sentOf(desk).filter((m) => m.type === 'herald_event')).toHaveLength(0);
    // The trigger-only socket itself never receives herald events.
    expect(sentOf(trig).filter((m) => m.type === 'herald_event')).toHaveLength(0);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'herald_trigger',
        payload: expect.objectContaining({ via: 'ws', action: 'brief' }),
        result: expect.objectContaining({ ok: true }),
      })
    );
  });

  it('the main token can fire herald_trigger too', async () => {
    const desk = connect(MAIN);
    sendMsg(desk, 'herald_presence', { interacted: true });
    await flush();
    sendMsg(desk, 'herald_trigger', { action: 'repeat' }, 'm1');
    await flush();
    const msgs = sentOf(desk);
    expect(msgs.find((m) => m.requestId === 'm1')).toMatchObject({
      success: true,
      payload: { action: 'repeat' },
    });
    expect(
      msgs.find((m) => m.type === 'herald_event' && m.payload?.kind === 'trigger')
    ).toBeTruthy();
    sendMsg(desk, 'herald_trigger', { action: 'dance' }, 'm2');
    await flush();
    expect(sentOf(desk).find((m) => m.requestId === 'm2')).toMatchObject({
      success: false,
      payload: { code: 'bad_request' },
    });
  });

  it('a wrong token is still rejected', () => {
    const ws = connect('d'.repeat(64));
    expect(sentOf(ws).find((m) => m.type === 'authenticated')).toMatchObject({ success: false });
    sendMsg(ws, 'herald_trigger', { action: 'toggle' });
    expect(sentOf(ws).pop()).toMatchObject({ success: false, error: 'Not authenticated' });
  });
});
