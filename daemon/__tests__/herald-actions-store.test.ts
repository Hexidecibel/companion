import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ActionManager } from '../src/herald/actions';
import { HeraldStore, sanitizeState } from '../src/herald/store';
import type { HeraldAction } from '../src/herald/protocol';
import type { PendingChoice, SessionSource } from '../src/herald/session-source';

function fakeSource(overrides: Partial<SessionSource> = {}) {
  const src = {
    serverId: 'local',
    listSessions: jest.fn(async () => []),
    getRecentTranscript: jest.fn(async () => ({ lastUserPrompt: null, assistantTurns: [] })),
    getLiveChoice: jest.fn(async (): Promise<PendingChoice | null> => null),
    sessionExists: jest.fn(async () => true),
    sendText: jest.fn(async () => true),
    sendChoice: jest.fn(async () => true),
    ...overrides,
  };
  return src as typeof src & SessionSource;
}

function makeManager(src: SessionSource, echoDelayMs = 5000) {
  const changes: HeraldAction[] = [];
  const sent: HeraldAction[] = [];
  const audits: string[] = [];
  const mgr = new ActionManager({
    getSource: (id) => (id === 'local' ? src : null),
    echoDelayMs,
    onChange: (a) => changes.push(a),
    onSent: (a) => sent.push(a),
    audit: (event) => audits.push(event),
  });
  return { mgr, changes, sent, audits };
}

const base = {
  serverId: 'local',
  sessionId: 'companion',
  sessionName: 'companion',
  reasons: [] as string[],
};

async function flush() {
  // Let chained promises inside execute() settle under fake timers.
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe('ActionManager', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('echo auto-sends after the delay (server-owned timer)', async () => {
    const src = fakeSource();
    const { mgr, sent, audits } = makeManager(src);
    const a = mgr.create({ ...base, tier: 'echo', kind: 'send_input', payload: 'continue', readback: 'companion: "continue"', meta: {} });
    expect(a.status).toBe('pending');
    expect(a.autoSendAt).toBe(Date.now() + 5000);
    jest.advanceTimersByTime(4999);
    await flush();
    expect(src.sendText).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await flush();
    expect(src.sendText).toHaveBeenCalledWith('companion', 'continue', `herald-${a.id}`);
    expect(mgr.get(a.id)?.status).toBe('sent');
    expect(mgr.get(a.id)?.autoSendAt).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(audits).toEqual(['proposed', 'sent']);
  });

  it('cancel stops the echo timer', async () => {
    const src = fakeSource();
    const { mgr, audits } = makeManager(src);
    const a = mgr.create({ ...base, tier: 'echo', kind: 'send_input', payload: 'go', readback: 'r', meta: {} });
    const c = mgr.cancel(a.id);
    expect(c.status).toBe('cancelled');
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(src.sendText).not.toHaveBeenCalled();
    expect(audits).toEqual(['proposed', 'cancelled']);
    // Idempotent: confirming a cancelled action does nothing.
    expect((await mgr.confirm(a.id)).status).toBe('cancelled');
  });

  it('confirm on echo sends immediately', async () => {
    const src = fakeSource();
    const { mgr } = makeManager(src);
    const a = mgr.create({ ...base, tier: 'echo', kind: 'send_input', payload: 'go', readback: 'r', meta: {} });
    const r = await mgr.confirm(a.id);
    expect(r.status).toBe('sent');
    expect(src.sendText).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(10_000);
    await flush();
    expect(src.sendText).toHaveBeenCalledTimes(1);
  });

  it('hard_confirm never auto-sends and expires after the TTL', async () => {
    const src = fakeSource();
    const { mgr, audits } = makeManager(src);
    const a = mgr.create({ ...base, tier: 'hard_confirm', reasons: ['deploy'], kind: 'send_input', payload: 'deploy', readback: 'r', meta: {} });
    expect(a.autoSendAt).toBeUndefined();
    jest.advanceTimersByTime(9 * 60_000);
    await flush();
    expect(mgr.get(a.id)?.status).toBe('pending');
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(mgr.get(a.id)?.status).toBe('expired');
    expect(src.sendText).not.toHaveBeenCalled();
    expect(audits).toEqual(['proposed', 'expired']);
  });

  it('hard_confirm sends on explicit confirm', async () => {
    const src = fakeSource();
    const { mgr, audits } = makeManager(src);
    const a = mgr.create({ ...base, tier: 'hard_confirm', reasons: ['x'], kind: 'send_input', payload: 'deploy', readback: 'r', meta: {} });
    expect((await mgr.confirm(a.id)).status).toBe('sent');
    expect(audits).toEqual(['proposed', 'confirmed', 'sent']);
  });

  it('escalate upgrades echo to hard_confirm and disarms auto-send; never lowers', async () => {
    const src = fakeSource();
    const { mgr } = makeManager(src);
    const a = mgr.create({ ...base, tier: 'echo', kind: 'send_input', payload: 'go', readback: 'r', meta: {} });
    const e = mgr.escalate(a.id, 'batch');
    expect(e?.tier).toBe('hard_confirm');
    expect(e?.autoSendAt).toBeUndefined();
    expect(e?.reasons).toContain('batch');
    jest.advanceTimersByTime(30_000);
    await flush();
    expect(src.sendText).not.toHaveBeenCalled();
  });

  const choice: PendingChoice = { question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false, signature: 'sigA' };

  it('answer_choice sends via the choice path when the same prompt is live', async () => {
    const src = fakeSource({ getLiveChoice: jest.fn(async () => choice) });
    const { mgr } = makeManager(src);
    const a = mgr.create({
      ...base,
      tier: 'hard_confirm',
      kind: 'answer_choice',
      payload: 'No',
      readback: 'companion: option 2, No',
      meta: { choice: { index: 1, optionCount: 2, multiSelect: false, signature: 'sigA' } },
    });
    expect((await mgr.confirm(a.id)).status).toBe('sent');
    expect(src.sendChoice).toHaveBeenCalledWith('companion', 1, 2, false);
  });

  it('answer_choice expires (does not send) when the prompt changed', async () => {
    const src = fakeSource({ getLiveChoice: jest.fn(async () => ({ ...choice, signature: 'sigB' })) });
    const { mgr } = makeManager(src);
    const a = mgr.create({
      ...base,
      tier: 'echo',
      kind: 'answer_choice',
      payload: 'No',
      readback: 'r',
      meta: { choice: { index: 1, optionCount: 2, multiSelect: false, signature: 'sigA' } },
    });
    jest.advanceTimersByTime(5000);
    await flush();
    const r = mgr.get(a.id)!;
    expect(r.status).toBe('expired');
    expect(r.error).toMatch(/changed or was already answered/);
    expect(src.sendChoice).not.toHaveBeenCalled();
  });

  it('answer_choice expires when the prompt is gone', async () => {
    const src = fakeSource();
    const { mgr } = makeManager(src);
    const a = mgr.create({
      ...base,
      tier: 'hard_confirm',
      kind: 'answer_choice',
      payload: 'No',
      readback: 'r',
      meta: { choice: { index: 1, optionCount: 2, multiSelect: false, signature: 'sigA' } },
    });
    expect((await mgr.confirm(a.id)).status).toBe('expired');
  });

  it('send_input refuses to type into a choice box that appeared', async () => {
    const src = fakeSource({ getLiveChoice: jest.fn(async () => choice) });
    const { mgr } = makeManager(src);
    const a = mgr.create({ ...base, tier: 'hard_confirm', reasons: ['x'], kind: 'send_input', payload: 'hello', readback: 'r', meta: {} });
    const r = await mgr.confirm(a.id);
    expect(r.status).toBe('expired');
    expect(src.sendText).not.toHaveBeenCalled();
  });

  it('fails cleanly when the session is gone or delivery fails', async () => {
    const gone = fakeSource({ sessionExists: jest.fn(async () => false) });
    const m1 = makeManager(gone);
    const a1 = m1.mgr.create({ ...base, tier: 'hard_confirm', reasons: ['x'], kind: 'send_input', payload: 'x', readback: 'r', meta: {} });
    expect((await m1.mgr.confirm(a1.id)).status).toBe('failed');

    const broken = fakeSource({ sendText: jest.fn(async () => false) });
    const m2 = makeManager(broken);
    const a2 = m2.mgr.create({ ...base, tier: 'hard_confirm', reasons: ['x'], kind: 'send_input', payload: 'x', readback: 'r', meta: {} });
    const r2 = await m2.mgr.confirm(a2.id);
    expect(r2.status).toBe('failed');
    expect(r2.error).toMatch(/Could not deliver/);
    expect(m2.sent).toHaveLength(0);
  });

  it('double confirm sends once', async () => {
    let release!: () => void;
    const src = fakeSource({ sendText: jest.fn(() => new Promise<boolean>((r) => (release = () => r(true)))) });
    const { mgr } = makeManager(src);
    const a = mgr.create({ ...base, tier: 'hard_confirm', reasons: ['x'], kind: 'send_input', payload: 'x', readback: 'r', meta: {} });
    const p1 = mgr.confirm(a.id);
    await flush();
    const p2 = await mgr.confirm(a.id);
    expect(p2.status).toBe('pending');
    release();
    expect((await p1).status).toBe('sent');
    expect(src.sendText).toHaveBeenCalledTimes(1);
  });

  it('an unreadable screen at re-validation fails closed (nothing typed)', async () => {
    const src = fakeSource({ getLiveChoice: jest.fn(async () => Promise.reject(new Error("could not read companion's screen"))) });
    const { mgr, sent } = makeManager(src);
    const a = mgr.create({ ...base, tier: 'echo', kind: 'send_input', payload: 'hello', readback: 'r', meta: {} });
    jest.advanceTimersByTime(5000);
    await flush();
    const r = mgr.get(a.id)!;
    expect(r.status).toBe('failed');
    expect(src.sendText).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('a delivery timeout says the text may still have been typed', async () => {
    const src = fakeSource({ sendText: jest.fn(() => new Promise<boolean>(() => undefined)) });
    const { mgr } = makeManager(src);
    const a = mgr.create({ ...base, tier: 'hard_confirm', reasons: ['x'], kind: 'send_input', payload: 'x', readback: 'r', meta: {} });
    const p = mgr.confirm(a.id);
    await flush();
    jest.advanceTimersByTime(20_000);
    const r = await p;
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/may still have been typed/);
  });

  it('a cancel racing an in-flight auto-send does not double-resolve', async () => {
    let release!: () => void;
    const src = fakeSource({ sendText: jest.fn(() => new Promise<boolean>((r) => (release = () => r(true)))) });
    const { mgr, sent } = makeManager(src);
    const a = mgr.create({ ...base, tier: 'echo', kind: 'send_input', payload: 'x', readback: 'r', meta: {} });
    jest.advanceTimersByTime(5000);
    await flush();
    expect(mgr.cancel(a.id).status).toBe('pending'); // already in flight: cancel is a no-op
    release();
    await flush();
    expect(mgr.get(a.id)!.status).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(src.sendText).toHaveBeenCalledTimes(1);
  });

  it('unknown action throws', async () => {
    const { mgr } = makeManager(fakeSource());
    await expect(mgr.confirm('nope')).rejects.toThrow('Unknown action');
    expect(() => mgr.cancel('nope')).toThrow('Unknown action');
  });
});

describe('HeraldStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-store-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const action = (status: HeraldAction['status']): HeraldAction => ({
    id: `a-${status}`,
    tier: 'echo',
    kind: 'send_input',
    serverId: 'local',
    sessionId: 's',
    sessionName: 's',
    payload: 'p',
    readback: 'r',
    reasons: [],
    status,
    autoSendAt: status === 'pending' ? 123 : undefined,
    createdAt: 1,
  });

  it('round-trips state atomically, expiring pending actions on load', async () => {
    const store = new HeraldStore(dir, 10);
    const state = {
      version: 1,
      messages: [{ id: 'm1', role: 'user' as const, text: 'hi', createdAt: 1, sessionRefs: [{ serverId: 'local', sessionId: 's', sessionName: 's' }] }],
      heard: ['h1'],
      actions: [action('sent'), action('pending')],
    };
    store.scheduleSave(() => state);
    await store.flush();
    expect(fs.readdirSync(dir)).toEqual(['state.json']); // no temp files left
    const loaded = await new HeraldStore(dir).load(999);
    expect(loaded.messages).toEqual(state.messages);
    expect(loaded.heard).toEqual(['h1']);
    expect(loaded.actions[0].status).toBe('sent');
    expect(loaded.actions[1].status).toBe('expired');
    expect(loaded.actions[1].autoSendAt).toBeUndefined();
    expect(loaded.actions[1].resolvedAt).toBe(999);
  });

  it('debounces bursts into one write with the latest data', async () => {
    const store = new HeraldStore(dir, 20);
    const writes = jest.spyOn(fs.promises, 'writeFile');
    for (let i = 0; i < 5; i++) store.scheduleSave(() => ({ version: 1, messages: [], heard: [`h${i}`], actions: [] }));
    await new Promise((r) => setTimeout(r, 60));
    await store.flush();
    expect(writes).toHaveBeenCalledTimes(1);
    writes.mockRestore();
    expect((await store.load()).heard).toEqual(['h4']);
  });

  it('missing file loads empty state', async () => {
    const s = await new HeraldStore(dir).load();
    expect(s).toEqual({ version: 1, messages: [], heard: [], actions: [] });
  });

  it('corrupt file is moved aside and Herald starts fresh', async () => {
    fs.writeFileSync(path.join(dir, 'state.json'), '{"messages": [ {oops');
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const s = await new HeraldStore(dir).load(42);
    errSpy.mockRestore();
    expect(s.messages).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'state.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'state.json.corrupt-42'))).toBe(true);
  });

  it('sanitizeState keeps a valid verbosity and user intents, drops junk', () => {
    const s = sanitizeState(
      {
        verbosity: 'brief',
        messages: [
          { id: 'u', role: 'user', text: 'Shorter.', createdAt: 1, intent: 'shorter' },
          { id: 'v', role: 'user', text: 'x', createdAt: 2, intent: 'explode' },
          { id: 'h', role: 'herald', text: 'y', createdAt: 3, intent: 'more' },
        ],
      },
      1
    );
    expect(s.verbosity).toBe('brief');
    expect(s.messages.map((m) => m.intent)).toEqual(['shorter', undefined, undefined]);
    expect(sanitizeState({ verbosity: 'loud' }, 1).verbosity).toBeUndefined();
    expect(sanitizeState({ verbosity: 'auto' }, 1).verbosity).toBeUndefined();
  });

  it('sanitizeState drops malformed entries and bounds sizes', () => {
    const s = sanitizeState(
      {
        messages: [{ id: 'ok', role: 'herald', text: 'x', createdAt: 1 }, { id: 5 }, null, { id: 'bad', role: 'robot', text: 'x', createdAt: 1 }],
        heard: ['a', 7, 'b'],
        actions: [{ id: 'x' }, action('cancelled')],
      },
      1
    );
    expect(s.messages.map((m) => m.id)).toEqual(['ok']);
    expect(s.heard).toEqual(['a', 'b']);
    expect(s.actions.map((a) => a.id)).toEqual(['a-cancelled']);
    const many = sanitizeState({ messages: Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, role: 'user', text: 't', createdAt: i })) }, 1);
    expect(many.messages).toHaveLength(100);
    expect(many.messages[0].id).toBe('m200');
    expect(() => sanitizeState('nope', 1)).toThrow();
  });
});
