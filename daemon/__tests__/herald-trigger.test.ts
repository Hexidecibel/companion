import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import {
  HeraldTriggerService,
  TRIGGER_ACTIONS,
  TriggerTokenFile,
  WindowLimiter,
  parseTriggerAction,
  safeEqual,
} from '../src/herald/trigger';
import type { AuditEntry } from '../src/audit-log';
import type { HeraldEvent } from '../src/herald/protocol';

const TOKEN = 'a'.repeat(24) + '0123456789abcdef0123456789abcdef';
const OTHER = 'b'.repeat(24) + '0123456789abcdef0123456789abcdef';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'herald-trigger-'));
}

function writeToken(file: string, token: string, mode = 0o600): void {
  fs.writeFileSync(file, token + '\n', { mode });
  fs.chmodSync(file, mode);
}

const origin = { addr: '10.0.0.5', clientId: 'http', isLocal: false, tls: true, origin: null };

function makeService(
  opts: {
    active?: string | null;
    available?: boolean;
    deliverOk?: boolean;
    file?: TriggerTokenFile;
    now?: () => number;
  } = {}
) {
  const delivered: Array<{ clientId: string; event: HeraldEvent }> = [];
  const audits: AuditEntry[] = [];
  const svc = new HeraldTriggerService({
    available: () => opts.available ?? true,
    activeClient: () => (opts.active === undefined ? 'phone' : opts.active),
    deliver: (clientId, event) => {
      delivered.push({ clientId, event });
      return opts.deliverOk ?? true;
    },
    audit: (e) => audits.push(e),
    tokenFile: opts.file,
    now: opts.now,
  });
  return { svc, delivered, audits };
}

describe('trigger token file', () => {
  let dir: string;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    dir = tmpDir();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('matches only the exact token, with no file meaning no trigger access', () => {
    const file = new TriggerTokenFile(path.join(dir, 'tok'));
    expect(file.current()).toBeNull();
    expect(file.matches(TOKEN)).toBe(false);
    writeToken(file.path, TOKEN);
    expect(file.matches(TOKEN)).toBe(true);
    expect(file.matches(OTHER)).toBe(false);
    expect(file.matches(TOKEN.slice(0, -1))).toBe(false);
    expect(file.matches('')).toBe(false);
    expect(file.matches(undefined)).toBe(false);
    expect(file.matches(42)).toBe(false);
  });

  it('picks up a rotation without a restart', () => {
    const file = new TriggerTokenFile(path.join(dir, 'tok'));
    writeToken(file.path, TOKEN);
    expect(file.matches(TOKEN)).toBe(true);
    // Rotation replaces the file (new inode), like the CLI's mv.
    const tmp = path.join(dir, 'tok.new');
    writeToken(tmp, OTHER);
    fs.renameSync(tmp, file.path);
    expect(file.matches(TOKEN)).toBe(false);
    expect(file.matches(OTHER)).toBe(true);
  });

  it('refuses a group/world-readable file and a malformed or short token', () => {
    const file = new TriggerTokenFile(path.join(dir, 'tok'));
    writeToken(file.path, TOKEN, 0o644);
    expect(file.matches(TOKEN)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/must be 600/));
    fs.chmodSync(file.path, 0o600);
    expect(file.matches(TOKEN)).toBe(true);
    writeToken(file.path, 'short');
    expect(file.current()).toBeNull();
    writeToken(file.path, `${TOKEN} ${TOKEN}`);
    expect(file.current()).toBeNull();
  });

  it('compares in constant time via equal-length digests', () => {
    expect(safeEqual('x', 'x')).toBe(true);
    expect(safeEqual('x', 'xx')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('HeraldTriggerService routing', () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  it('parses exactly the five actions', () => {
    expect(TRIGGER_ACTIONS).toEqual(['brief', 'listen', 'stop', 'repeat', 'toggle']);
    for (const a of TRIGGER_ACTIONS) expect(parseTriggerAction(a)).toBe(a);
    expect(parseTriggerAction('TOGGLE')).toBeNull();
    expect(parseTriggerAction(undefined)).toBeNull();
    expect(parseTriggerAction({})).toBeNull();
  });

  it('routes each action to the active device as a trigger herald_event', () => {
    const { svc, delivered } = makeService({ active: 'desk-browser' });
    for (const action of TRIGGER_ACTIONS) {
      const out = svc.fire(action, { via: 'http', origin });
      expect(out).toMatchObject({
        ok: true,
        status: 200,
        target: 'desk-browser',
        result: { action, delivered: true },
      });
    }
    expect(delivered.map((d) => d.clientId)).toEqual(Array(5).fill('desk-browser'));
    expect(delivered.map((d) => d.event.kind)).toEqual(Array(5).fill('trigger'));
    expect(delivered.map((d) => (d.event as { action: string }).action)).toEqual([
      ...TRIGGER_ACTIONS,
    ]);
    const ids = delivered.map((d) => (d.event as { id: string }).id);
    expect(new Set(ids).size).toBe(5);
  });

  it('409 no_active_device when nobody can act (none elected, or it just left)', () => {
    const none = makeService({ active: null });
    expect(none.svc.fire('brief', { via: 'http', origin })).toMatchObject({
      ok: false,
      status: 409,
      code: 'no_active_device',
      error: expect.stringMatching(/No active device/),
    });
    expect(none.delivered).toHaveLength(0);
    const gone = makeService({ active: 'ghost', deliverOk: false });
    expect(gone.svc.fire('toggle', { via: 'ws', origin })).toMatchObject({
      status: 409,
      code: 'no_active_device',
    });
  });

  it('400 for an unknown action, 503 when Herald voice is off', () => {
    const { svc } = makeService();
    expect(svc.fire('launch', { via: 'http', origin })).toMatchObject({
      status: 400,
      code: 'bad_request',
    });
    const off = makeService({ available: false });
    expect(off.svc.fire('toggle', { via: 'http', origin })).toMatchObject({
      status: 503,
      code: 'unavailable',
    });
  });

  it('rate limits to 10 triggers per 10 s, then recovers', () => {
    let now = 1_000_000;
    const { svc, delivered } = makeService({ now: () => now });
    for (let i = 0; i < 10; i++) expect(svc.fire('toggle', { via: 'http', origin }).ok).toBe(true);
    const limited = svc.fire('toggle', { via: 'ws', origin });
    expect(limited).toMatchObject({ ok: false, status: 429, code: 'rate_limited' });
    expect((limited as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    expect(delivered).toHaveLength(10);
    now += 10_001;
    expect(svc.fire('toggle', { via: 'http', origin }).ok).toBe(true);
  });

  it('audit-logs every trigger (accepted and rejected), never the token', () => {
    const { svc, audits } = makeService({ active: 'phone' });
    svc.fire('brief', { via: 'http', origin, forwardedFor: '203.0.113.9' });
    svc.fire('nope', { via: 'ws', origin });
    svc.rejectUnauthorized({ via: 'http', origin }, 'toggle');
    expect(audits).toHaveLength(3);
    expect(audits[0]).toMatchObject({
      action: 'herald_trigger',
      origin,
      payload: { via: 'http', action: 'brief', forwardedFor: '203.0.113.9' },
      result: { ok: true, target: 'phone' },
    });
    expect(audits[1]).toMatchObject({
      payload: { via: 'ws', action: 'invalid' },
      result: { ok: false, code: 'bad_request', status: 400 },
    });
    expect(audits[2]).toMatchObject({ result: { ok: false, code: 'unauthorized', status: 401 } });
    expect(JSON.stringify(audits)).not.toContain(TOKEN);
  });

  it('bad-token floods from one address stop being audited (429)', () => {
    const { svc, audits } = makeService();
    for (let i = 0; i < 20; i++) {
      expect(svc.rejectUnauthorized({ via: 'http', origin }, 'toggle').status).toBe(401);
    }
    expect(svc.rejectUnauthorized({ via: 'http', origin }, 'toggle').status).toBe(429);
    expect(audits).toHaveLength(20);
    // A different address is unaffected.
    const other = { ...origin, addr: '10.0.0.6' };
    expect(svc.rejectUnauthorized({ via: 'http', origin: other }, 'toggle').status).toBe(401);
  });

  it('WindowLimiter prunes idle keys', () => {
    let now = 0;
    const l = new WindowLimiter(1, 100, () => now);
    expect(l.take('a')).toBeNull();
    expect(l.take('a')).toBe(100);
    now = 500;
    l.prune();
    expect((l as unknown as { hits: Map<string, number[]> }).hits.size).toBe(0);
  });
});

describe('POST /herald/trigger', () => {
  let dir: string;
  let server: http.Server;
  let base: string;
  let ctx: ReturnType<typeof makeService>;
  let active: string | null;
  let log: jest.SpyInstance;

  beforeEach(async () => {
    dir = tmpDir();
    const file = new TriggerTokenFile(path.join(dir, 'tok'));
    writeToken(file.path, TOKEN);
    active = 'desk';
    const delivered: Array<{ clientId: string; event: HeraldEvent }> = [];
    const audits: AuditEntry[] = [];
    const svc = new HeraldTriggerService({
      available: () => true,
      activeClient: () => active,
      deliver: (clientId, event) => {
        delivered.push({ clientId, event });
        return true;
      },
      audit: (e) => audits.push(e),
      tokenFile: file,
    });
    ctx = { svc, delivered, audits };
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    server = http.createServer((req, res) => svc.handleHttp(req, res, false));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/herald/trigger`;
  });

  afterEach(async () => {
    log.mockRestore();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const post = (body?: string, token: string | null = TOKEN, url = base, method = 'POST') =>
    fetch(url, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
    });

  it('delivers a JSON action and answers 200', async () => {
    const res = await post(JSON.stringify({ action: 'brief' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ success: true, action: 'brief', delivered: true });
    expect(ctx.delivered[0]).toMatchObject({
      clientId: 'desk',
      event: { kind: 'trigger', action: 'brief' },
    });
  });

  it('an empty body means toggle; ?action= also works', async () => {
    expect((await post()).status).toBe(200);
    expect((await post(undefined, TOKEN, `${base}?action=repeat`)).status).toBe(200);
    expect(ctx.delivered.map((d) => (d.event as { action: string }).action)).toEqual([
      'toggle',
      'repeat',
    ]);
  });

  it('401 without / with a wrong token (audited), nothing delivered', async () => {
    const none = await post(JSON.stringify({ action: 'toggle' }), null);
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toMatch(/Bearer/);
    const wrong = await post(JSON.stringify({ action: 'toggle' }), OTHER);
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ success: false, code: 'unauthorized' });
    expect(ctx.delivered).toHaveLength(0);
    expect(ctx.audits.map((a) => a.result.code)).toEqual(['unauthorized', 'unauthorized']);
  });

  it('409 with a clear message when no device is active', async () => {
    active = null;
    const res = await post(JSON.stringify({ action: 'brief' }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('no_active_device');
    expect(body.error).toMatch(/No active device/);
  });

  it('400 bad action / bad JSON, 405 for GET, 413 for a big body, 429 over the limit', async () => {
    expect((await post(JSON.stringify({ action: 'explode' }))).status).toBe(400);
    expect((await post('{not json')).status).toBe(400);
    const get = await fetch(base, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect((await post(JSON.stringify({ action: 'toggle', pad: 'x'.repeat(4000) }))).status).toBe(
      413
    );
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await post(JSON.stringify({ action: 'stop' }))).status;
    expect(last).toBe(429);
  });
});
