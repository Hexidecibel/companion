import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { latestShowRef, pickShowTarget, resolveShowDevice } from '../src/herald/show';
import { HeraldService } from '../src/herald/service';
import { HeraldStore } from '../src/herald/store';
import type { ResolvedHeraldConfig } from '../src/herald/config';
import type {
  HeraldAction,
  HeraldDevicesSnapshot,
  HeraldEvent,
  HeraldInboxItem,
  HeraldMessage,
  HeraldShowResult,
} from '../src/herald/protocol';
import type { PendingChoice, SessionSnapshot, SessionSource } from '../src/herald/session-source';
import { HeraldTriggerService, triggerSignature } from '../src/herald/trigger';
import { executeTool, TOOL_SPECS, validateToolCall, type ToolEnv } from '../src/herald/tools';
import { ActionManager } from '../src/herald/actions';
import { snap } from './herald-helpers';

const choice: PendingChoice = {
  question: 'Which branch?',
  options: [{ label: 'main' }, { label: 'dev' }],
  multiSelect: false,
  signature: 'sig-1',
};

function action(over: Partial<HeraldAction> & { id: string; sessionId: string }): HeraldAction {
  return {
    tier: 'echo',
    kind: 'send_input',
    serverId: 'local',
    sessionName: over.sessionId,
    payload: 'go',
    readback: 'go',
    reasons: [],
    status: 'pending',
    createdAt: 1,
    ...over,
  };
}

function msg(over: Partial<HeraldMessage> & { id: string }): HeraldMessage {
  return { role: 'herald', text: 'x', createdAt: 1, ...over };
}

function item(over: Partial<HeraldInboxItem> & { id: string; sessionId: string }): HeraldInboxItem {
  return {
    serverId: 'local',
    sessionName: over.sessionId,
    priority: 'finished',
    headline: 'done',
    createdAt: 1,
    heard: false,
    ...over,
  };
}

const ref = (id: string) => ({ serverId: 'local', sessionId: id, sessionName: id });

describe('show target resolution order', () => {
  const sessions = [snap({ sessionId: 'out4' }), snap({ sessionId: 'docs' }), snap({ sessionId: 'blog' })];

  it('1. the newest pending card wins over messages and inbox', () => {
    const t = pickShowTarget(undefined, {
      actions: [
        action({ id: 'a1', sessionId: 'docs', createdAt: 5 }),
        action({ id: 'a2', sessionId: 'out4', createdAt: 9, tier: 'hard_confirm' }),
        action({ id: 'a3', sessionId: 'blog', createdAt: 20, status: 'sent' }),
        action({ id: 'a4', sessionId: '', kind: 'cush_command', createdAt: 30 }),
      ],
      messages: [msg({ id: 'm', sessionRefs: [ref('blog')] })],
      inbox: [item({ id: 'i', sessionId: 'blog', createdAt: 50 })],
      sessions,
    });
    expect(t).toMatchObject({ ok: true, from: 'card', session: { sessionId: 'out4' } });
  });

  it("2. else the latest Herald message's first chip (only the latest one)", () => {
    const ctx = {
      actions: [],
      messages: [
        msg({ id: 'm1', sessionRefs: [ref('docs')] }),
        msg({ id: 'm2', sessionRefs: [ref('out4'), ref('docs')] }),
        msg({ id: 'u', role: 'user' }),
      ],
      inbox: [item({ id: 'i', sessionId: 'blog' })],
      sessions,
    };
    expect(pickShowTarget('', ctx)).toMatchObject({ ok: true, from: 'message', session: { sessionId: 'out4' } });
    // The latest Herald line names no session: an older chip is stale, go to the inbox.
    ctx.messages.push(msg({ id: 'm3' }));
    expect(pickShowTarget('', ctx)).toMatchObject({ ok: true, from: 'inbox', session: { sessionId: 'blog' } });
  });

  it('3. else the newest UNHEARD inbox item; else nothing', () => {
    const inbox = [
      item({ id: 'old', sessionId: 'docs', createdAt: 1 }),
      item({ id: 'new', sessionId: 'out4', createdAt: 9 }),
      item({ id: 'heard', sessionId: 'blog', createdAt: 99, heard: true }),
    ];
    expect(latestShowRef({ actions: [], messages: [], inbox })?.ref.sessionId).toBe('out4');
    expect(pickShowTarget(undefined, { actions: [], messages: [], inbox: [inbox[2]], sessions })).toEqual({
      ok: false,
      status: 'nothing',
      candidates: [],
    });
  });

  it('a named session resolves fuzzily; several matches are ambiguous; none is not_found', () => {
    const s = [
      snap({ sessionId: 'out4', sessionName: 'Out4' }),
      snap({ sessionId: 'doc-upload', sessionName: 'Doc Upload Site' }),
      snap({ sessionId: 'docs-web', sessionName: 'Docs Web' }),
      snap({ sessionId: 'docs-api', sessionName: 'Docs API' }),
    ];
    const ctx = { actions: [], messages: [], inbox: [], sessions: s };
    expect(pickShowTarget('out 4', ctx)).toMatchObject({ ok: true, from: 'named', session: { sessionId: 'out4' } });
    expect(pickShowTarget('doc upload site', ctx)).toMatchObject({ ok: true, session: { sessionId: 'doc-upload' } });
    expect(pickShowTarget('the docs api session', ctx)).toMatchObject({ ok: true, session: { sessionId: 'docs-api' } });
    const amb = pickShowTarget('the docs session', ctx);
    expect(amb).toMatchObject({ ok: false, status: 'ambiguous' });
    expect((amb as { candidates: string[] }).candidates.length).toBeGreaterThan(1);
    expect(pickShowTarget('how to deploy', ctx)).toEqual({ ok: false, status: 'not_found', candidates: [] });
  });

  it('flags a waiting prompt and uses the live session name', () => {
    const t = pickShowTarget(undefined, {
      actions: [],
      messages: [msg({ id: 'm', sessionRefs: [{ serverId: 'local', sessionId: 'out4', sessionName: 'old name' }] })],
      inbox: [],
      sessions: [snap({ sessionId: 'out4', sessionName: 'Out4', status: 'waiting', pendingChoice: choice })],
    });
    expect(t).toMatchObject({ ok: true, pending: true, session: { sessionName: 'Out4' } });
  });
});

// ---------------------------------------------------------------------------

function fakeSource(sessions: SessionSnapshot[]): SessionSource {
  return {
    serverId: 'local',
    listSessions: async () => sessions,
    getRecentTranscript: async () => ({ lastUserPrompt: null, assistantTurns: [] }),
    getLiveChoice: async () => null,
    sessionExists: async () => true,
    sendText: async () => true,
    sendChoice: async () => true,
  };
}

const cfg: ResolvedHeraldConfig = {
  featureEnabled: true,
  displayName: 'Herald',
  provider: 'openai_compatible',
  baseUrl: 'http://x/v1',
  model: 'm',
  echoDelayMs: 80,
  requestTimeoutMs: 5000,
  maxTokens: 700,
  stateDir: '/tmp/unused',
  apiKey: null,
  brainConfigured: false,
  disabledReason: 'off',
} as ResolvedHeraldConfig;

describe('HeraldService.show (routing)', () => {
  let dir: string;
  let svc: HeraldService | null = null;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-show-'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    svc?.shutdown();
    svc = null;
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function make(devices: HeraldDevicesSnapshot | null, deliverOk = true) {
    const delivered: Array<{ clientId: string; event: HeraldEvent }> = [];
    svc = new HeraldService({
      config: cfg,
      provider: null,
      sources: [
        fakeSource([
          snap({ sessionId: 'out4', sessionName: 'Out4', status: 'waiting', pendingChoice: choice }),
          snap({ sessionId: 'docs', sessionName: 'Docs' }),
        ]),
      ],
      store: new HeraldStore(dir, 10),
      broadcast: () => {},
      audit: () => {},
      pollIntervalMs: 60_000,
      devices: () => devices,
      activeClientId: () => devices?.activeDevice?.id ?? null,
      deliverToClient: (clientId, event) => {
        delivered.push({ clientId, event });
        return deliverOk;
      },
    });
    return { svc, delivered };
  }

  const twoDevices: HeraldDevicesSnapshot = {
    activeDevice: { id: 'pc', label: 'Windows PC', pinned: false, reason: 'recent' },
    devices: [
      { id: 'pc', label: 'Windows PC', handsFree: false },
      { id: 'ph', label: 'Companion app on Android', handsFree: false },
    ],
  };

  it('sends a navigate event to the ACTIVE device, flagged pending', async () => {
    const { svc, delivered } = make(twoDevices);
    const r = await svc.show({ session: 'out4' }, { via: 'voice', requesterId: 'ph' });
    expect(r).toEqual({ status: 'shown', session: ref2('out4', 'Out4'), device: { id: 'pc', label: 'Windows PC' } });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].clientId).toBe('pc');
    expect(delivered[0].event).toMatchObject({ kind: 'navigate', via: 'voice', pending: true, session: { sessionId: 'out4' } });
    expect((delivered[0].event as { ack?: boolean }).ack).toBeUndefined();
  });

  it('cross-device: a named device (id or label) gets it; the active device does not change', async () => {
    const { svc, delivered } = make(twoDevices);
    expect(await svc.show({ session: 'docs', device: 'ph' }, { via: 'voice', requesterId: 'pc' })).toMatchObject({
      status: 'shown',
      device: { id: 'ph' },
    });
    expect(await svc.show({ session: 'docs', device: 'windows pc' }, { via: 'voice' })).toMatchObject({
      status: 'shown',
      device: { id: 'pc' },
    });
    expect(delivered.map((d) => d.clientId)).toEqual(['ph', 'pc']);
    expect(twoDevices.activeDevice?.id).toBe('pc');
  });

  it('an offline device / no device / ambiguous / not found are reported, nothing delivered', async () => {
    const { svc, delivered } = make(twoDevices);
    expect(await svc.show({ session: 'docs', device: 'Work Mac' }, { via: 'voice' })).toMatchObject({ status: 'offline' });
    expect(await svc.show({ session: 'pod bay doors' }, { via: 'voice' })).toEqual({ status: 'not_found' });
    expect(await svc.show({}, { via: 'voice' })).toEqual({ status: 'nothing' });
    expect(delivered).toHaveLength(0);
    const gone = make(twoDevices, false);
    expect(await gone.svc.show({ session: 'docs' }, { via: 'voice' })).toMatchObject({ status: 'no_device' });
  });

  // "Show me a companion on my PC." from the Windows PC while the Mac was active.
  const macActive: HeraldDevicesSnapshot = {
    activeDevice: { id: 'mac', label: 'Mac desktop', pinned: false, reason: 'recent' },
    devices: [
      { id: 'mac', label: 'Mac desktop', handsFree: false, platform: { os: 'macos', app: 'native' } },
      { id: 'win', label: 'Windows desktop', handsFree: false, platform: { os: 'windows', app: 'native' } },
    ],
  };

  it('device words ("my PC") go to the Windows device, not the active Mac', async () => {
    const { svc, delivered } = make(macActive);
    expect(await svc.show({ session: 'docs', device: 'my PC' }, { via: 'voice', requesterId: 'win' })).toMatchObject({
      status: 'shown',
      device: { id: 'win', label: 'Windows desktop' },
    });
    expect(delivered.map((d) => d.clientId)).toEqual(['win']);
  });

  it('device words that match nothing never fall back to the active device', async () => {
    const { svc, delivered } = make(macActive);
    expect(await svc.show({ session: 'docs', device: 'my phone' }, { via: 'voice', requesterId: 'win' })).toMatchObject({
      status: 'offline',
    });
    expect(delivered).toHaveLength(0);
  });

  it('the brain\'s device words resolve from the device that asked', () => {
    const { svc } = make(macActive);
    expect(svc.resolveDeviceWords('here', 'win')).toMatchObject({ kind: 'device', id: 'win', self: true });
    expect(svc.resolveDeviceWords('the computer', 'mac')).toMatchObject({ kind: 'device', id: 'win' });
    expect(svc.resolveDeviceWords('my phone', 'win')).toEqual({ kind: 'none', noun: 'a phone' });
  });

  it('with no active device it falls back to the requester', async () => {
    const { svc, delivered } = make({ activeDevice: null, devices: [{ id: 'ph', label: 'Phone', handsFree: false }] });
    expect(await svc.show({ session: 'docs' }, { via: 'voice', requesterId: 'ph' })).toMatchObject({ status: 'shown' });
    expect(delivered[0].clientId).toBe('ph');
    expect(await svc.show({ session: 'docs' }, { via: 'voice' })).toMatchObject({ status: 'no_device' });
  });

  it('unnamed: uses the newest unheard inbox item from the poll', async () => {
    const { svc, delivered } = make(twoDevices);
    await svc.start();
    await svc.poll();
    const r = await svc.show({}, { via: 'voice' });
    expect(r).toMatchObject({ status: 'shown', session: { sessionId: 'out4' } });
    expect(delivered[0].event).toMatchObject({ kind: 'navigate', pending: true });
  });
});

function ref2(sessionId: string, sessionName: string) {
  return { serverId: 'local', sessionId, sessionName };
}

// ---------------------------------------------------------------------------

describe('show_session brain tool', () => {
  const sessions = [
    snap({ sessionId: 'out4', sessionName: 'Out4', status: 'waiting', pendingChoice: choice }),
    snap({ sessionId: 'docs', sessionName: 'Docs' }),
  ];
  function env(over: Partial<ToolEnv> = {}): ToolEnv {
    return {
      listSessions: async () => sessions,
      getSource: () => null,
      actions: new ActionManager({ getSource: () => null, echoDelayMs: 20, onChange: () => {}, onSent: () => {}, audit: () => {} }),
      now: () => 1000,
      statusSince: () => null,
      echoDelayMs: 20,
      ...over,
    };
  }
  const turn = () => ({ userText: 'pull up whatever out4 is stuck on', sessionRefs: new Map(), proposals: [] });

  it('is a declared tool that takes a session', () => {
    const spec = TOOL_SPECS.find((t) => t.name === 'show_session');
    expect(spec).toBeTruthy();
    expect(validateToolCall('show_session', '{"session":"out4"}')).toEqual({ ok: true, value: { session: 'out4' } });
    expect(validateToolCall('show_session', '{}').ok).toBe(false);
  });

  it('opens the session on the active device and reports what waits there', async () => {
    const shown: string[] = [];
    const t = turn();
    const out = await executeTool(
      'show_session',
      { session: 'out 4' },
      env({
        showSession: (s): HeraldShowResult => {
          shown.push(s.sessionId);
          return { status: 'shown', session: ref2(s.sessionId, s.sessionName), device: { id: 'pc', label: 'Windows PC' } };
        },
      }),
      t
    );
    expect(out.isError).toBe(false);
    expect(shown).toEqual(['out4']);
    const body = JSON.parse(out.content);
    expect(body).toMatchObject({ shown: 'Out4', on: 'Windows PC', waiting_on_user: { question: 'Which branch?' } });
    expect([...t.sessionRefs.values()].map((r) => r.sessionId)).toEqual(['out4']);
  });

  it('takes an optional device in the user\'s words', () => {
    expect(validateToolCall('show_session', '{"session":"companion","device":"my PC"}')).toEqual({
      ok: true,
      value: { session: 'companion', device: 'my PC' },
    });
  });

  it('"Show me a companion on my PC.": shows it on the device the words name', async () => {
    const shownOn: Array<string | undefined> = [];
    const out = await executeTool(
      'show_session',
      { session: 'docs', device: 'my PC' },
      env({
        resolveDevice: (p) => (p === 'my PC' ? { kind: 'device', id: 'win', label: 'Windows desktop', self: true } : { kind: 'none', noun: 'x' }),
        showSession: (s, deviceId): HeraldShowResult => {
          shownOn.push(deviceId);
          return { status: 'shown', session: ref2(s.sessionId, s.sessionName), device: { id: 'win', label: 'Windows desktop' } };
        },
      }),
      turn()
    );
    expect(out.isError).toBe(false);
    expect(shownOn).toEqual(['win']);
    expect(JSON.parse(out.content)).toMatchObject({ on: 'Windows desktop' });
  });

  it('a named device that is not connected: says so, shows nothing elsewhere', async () => {
    const showSession = jest.fn();
    const out = await executeTool(
      'show_session',
      { session: 'docs', device: 'my PC' },
      env({ resolveDevice: () => ({ kind: 'none', noun: 'a PC' }), showSession }),
      turn()
    );
    expect(out.isError).toBe(true);
    expect(out.content).toContain("I don't see a PC connected.");
    expect(showSession).not.toHaveBeenCalled();
  });

  it('several devices match: asks which one', async () => {
    const showSession = jest.fn();
    const out = await executeTool(
      'show_session',
      { session: 'docs', device: 'pc' },
      env({
        resolveDevice: () => ({
          kind: 'ambiguous',
          devices: [
            { id: 'a', label: 'Windows desktop' },
            { id: 'b', label: 'Chrome on Windows' },
          ],
        }),
        showSession,
      }),
      turn()
    );
    expect(out.isError).toBe(true);
    expect(out.content).toContain('Which one, Windows desktop or Chrome on Windows?');
    expect(showSession).not.toHaveBeenCalled();
  });

  it('asks instead of guessing, and reports no device', async () => {
    const amb = await executeTool('show_session', { session: 'zzz' }, env({ showSession: () => ({ status: 'shown' }) }), turn());
    expect(amb.isError).toBe(true);
    const none = await executeTool('show_session', { session: 'docs' }, env({ showSession: () => ({ status: 'no_device' }) }), turn());
    expect(none.isError).toBe(true);
    expect(none.content).toMatch(/No device/);
    const off = await executeTool('show_session', { session: 'docs' }, env(), turn());
    expect(off.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('show trigger action', () => {
  const origin = { addr: '10.0.0.5', clientId: 'http', isLocal: false, tls: true, origin: null };
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  function make(result: (session: string | undefined) => HeraldShowResult, active: string | null = 'mac') {
    const calls: Array<{ session: string | undefined; clientId: string }> = [];
    const claims: string[] = [];
    const svc = new HeraldTriggerService({
      available: () => true,
      activeClient: () => active,
      claimDevice: (d) => {
        claims.push(d);
        return d === 'Work Mac' ? 'mac2' : null;
      },
      deliver: () => true,
      show: (session, clientId) => {
        calls.push({ session, clientId });
        return result(session);
      },
      audit: () => {},
    });
    return { svc, calls, claims };
  }

  it('resolves the session (optional) on the active device', () => {
    const { svc, calls } = make(() => ({ status: 'shown' }));
    expect(svc.fire({ action: 'show' }, { via: 'http', origin })).toMatchObject({
      ok: true,
      result: { action: 'show', delivered: true },
      target: 'mac',
    });
    expect(svc.fire({ action: 'show', session: 'Out4' }, { via: 'http', origin }).ok).toBe(true);
    expect(calls).toEqual([
      { session: undefined, clientId: 'mac' },
      { session: 'Out4', clientId: 'mac' },
    ]);
  });

  it('device= makes that device active first, like every action', () => {
    const { svc, calls, claims } = make(() => ({ status: 'shown' }));
    expect(svc.fire({ action: 'show', device: 'Work Mac' }, { via: 'http', origin })).toMatchObject({ ok: true, target: 'mac2' });
    expect(claims).toEqual(['Work Mac']);
    expect(calls[0].clientId).toBe('mac2');
  });

  it('maps failures to codes', () => {
    const cases: Array<[HeraldShowResult, number, string]> = [
      [{ status: 'ambiguous', candidates: ['Docs', 'Docs API'] }, 409, 'ambiguous_session'],
      [{ status: 'not_found' }, 404, 'unknown_session'],
      [{ status: 'nothing' }, 404, 'nothing_to_show'],
      [{ status: 'no_device' }, 409, 'no_active_device'],
    ];
    for (const [r, status, code] of cases) {
      const { svc } = make(() => r);
      expect(svc.fire({ action: 'show', session: 'x' }, { via: 'http', origin })).toMatchObject({ ok: false, status, code });
    }
    const { svc, calls } = make(() => ({ status: 'shown' }), null);
    expect(svc.fire({ action: 'show' }, { via: 'http', origin })).toMatchObject({ ok: false, code: 'no_active_device' });
    expect(calls).toHaveLength(0);
    expect(svc.fire({ action: 'show', session: 'x'.repeat(201) }, { via: 'http', origin })).toMatchObject({ code: 'bad_request' });
  });

  it('is unavailable without a show handler', () => {
    const svc = new HeraldTriggerService({ available: () => true, activeClient: () => 'a', deliver: () => true, audit: () => {} });
    expect(svc.fire({ action: 'show' }, { via: 'http', origin })).toMatchObject({ ok: false, code: 'unavailable' });
  });

  it('signed mode covers the session (it cannot be swapped)', () => {
    const k = 'f'.repeat(64);
    expect(triggerSignature(k, '1', 'show', '', '')).toBe(triggerSignature(k, '1', 'show', ''));
    expect(triggerSignature(k, '1', 'show', '', 'Out4')).not.toBe(triggerSignature(k, '1', 'show', '', 'Docs'));
  });
});

// ---------------------------------------------------------------------------

describe('resolveShowDevice (device aliases, shared with the web)', () => {
  const fleet = [
    { id: 'mac', label: 'Mac desktop', platform: { os: 'macos', app: 'native' } },
    { id: 'win', label: 'Gaming rig', platform: { os: 'windows', app: 'native' } },
    { id: 'ph', label: 'Companion app on Android', platform: { os: 'android', app: 'native' } },
    { id: 'pad', label: 'Safari on iPad' },
  ];

  it.each([
    ['PC', 'win'],
    ['my PC', 'win'],
    ['computer', 'win'],
    ['desktop', 'win'],
    ['Windows', 'win'],
    ['gaming PC', 'win'],
    ['Mac', 'mac'],
    ['MacBook', 'mac'],
    ['laptop', 'mac'],
    ['phone', 'ph'],
    ['Android', 'ph'],
    ['tablet', 'pad'],
    ['iPad', 'pad'],
    ['here', 'ph'],
    ['this one', 'ph'],
    ['ph', 'ph'],
    ['Gaming rig', 'win'],
  ])('"%s" -> %s', (phrase, id) => {
    expect(resolveShowDevice(phrase, fleet, 'ph')).toMatchObject({ kind: 'device', id });
  });

  it('none: "I don\'t see an iPhone connected." material', () => {
    expect(resolveShowDevice('iPhone', fleet, 'ph')).toEqual({ kind: 'none', noun: 'an iPhone' });
    expect(resolveShowDevice('my PC', fleet.filter((d) => d.id !== 'win'), 'ph')).toEqual({ kind: 'none', noun: 'a PC' });
  });

  it('a PC-word with only a Linux desktop falls back to it; "Windows" does not', () => {
    const linux = [{ id: 'lx', label: 'Firefox on Linux', platform: { os: 'linux', app: 'browser' } }];
    expect(resolveShowDevice('my computer', linux, null)).toMatchObject({ kind: 'device', id: 'lx' });
    expect(resolveShowDevice('windows', linux, null)).toEqual({ kind: 'none', noun: 'a Windows PC' });
  });
});
