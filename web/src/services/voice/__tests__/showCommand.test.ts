import { describe, expect, it, vi } from 'vitest';
import { matchShowCommand, matchVoiceCommand } from '../voiceCommands';
import {
  localShowTarget,
  matchClarifyAnswer,
  orList,
  resolveDevicePhrase,
  runShowCommand,
  type ShowActions,
} from '../showCommand';
import type { HeraldAction, HeraldDeviceInfo, HeraldShowResult } from '../../../types/herald';

describe('matchShowCommand: phrases', () => {
  it.each([
    'show me', 'Show me that.', 'show me it', 'Open it', 'take me there', 'Pull it up!', 'let me see',
    'Hey Jarvis, show me', 'Herald, pull that up', 'um, show me that', 'okay open it up',
  ])('"%s" = show what Herald just talked about', (t) => {
    expect(matchShowCommand(t)).toEqual({ target: null, device: null });
  });

  it.each([
    ['show me Out4', 'out4'],
    ['Open Doc Upload Site', 'doc upload site'],
    ['show me the deploy session', 'deploy'],
    ['Take me to Docs.', 'docs'],
    ['pull up the blog', 'blog'],
    ['pull Out4 up', 'out4'],
    ['Herald, show me companion web', 'companion web'],
    ['switch to the out 4 one', 'out 4'],
  ])('"%s" names %s', (t, target) => {
    expect(matchShowCommand(t)).toEqual({ target, device: null });
  });

  it('splits off the device: "on my computer" / "on the Mac" / "on my phone" / "here" / a label', () => {
    expect(matchShowCommand('show me on my computer')).toEqual({ target: null, device: 'my computer' });
    expect(matchShowCommand('show it on the Mac')).toEqual({ target: null, device: 'the mac' });
    expect(matchShowCommand('pull it up on my phone')).toEqual({ target: null, device: 'my phone' });
    expect(matchShowCommand('show me Out4 on my phone')).toEqual({ target: 'out4', device: 'my phone' });
    expect(matchShowCommand('open docs here')).toEqual({ target: 'docs', device: 'here' });
    expect(matchShowCommand('show me out4 on work box', ['Work Box'])).toEqual({ target: 'out4', device: 'work box' });
    // "on" inside a name that is not a device stays part of the name.
    expect(matchShowCommand('open carry on wayward')).toEqual({ target: 'carry on wayward', device: null });
  });
});

describe('matchShowCommand: negative cases go to the brain', () => {
  it.each([
    'show me how to deploy',
    'show me what Out4 did',
    'Can you show me the logs?',
    'open a new session in companion',
    'show me all the sessions',
    'show me my sessions',
    'let me see if it passed',
    'show me why the build failed',
    'take me to the place where it broke',
    'show me something',
    'show me more',
    'what is going on',
    'open',
    'show',
    'stop',
    'I want to see Out4',
    'please show me out4 and docs',
    'show me the deploy session on the mac and then tell me what it is doing',
  ])('"%s" is not a show command', (t) => {
    expect(matchShowCommand(t)).toBeNull();
  });

  it('existing commands are unaffected', () => {
    expect(matchShowCommand('stop')).toBeNull();
    expect(matchVoiceCommand('show me')).toBeNull();
    expect(matchVoiceCommand('stop')).toBe('stop');
  });
});

const devices: HeraldDeviceInfo[] = [
  { id: 'pc', label: 'Chrome on Windows', handsFree: false },
  { id: 'mac', label: 'Work Mac', handsFree: false },
  { id: 'ph', label: 'Companion app on Android', handsFree: false },
];

describe('resolveDevicePhrase (cross-device)', () => {
  it('maps device words to the device list', () => {
    expect(resolveDevicePhrase('my phone', devices, 'pc')).toMatchObject({ kind: 'device', id: 'ph', self: false });
    expect(resolveDevicePhrase('the mac', devices, 'pc')).toMatchObject({ kind: 'device', id: 'mac' });
    expect(resolveDevicePhrase('work mac', devices, 'pc')).toMatchObject({ kind: 'device', id: 'mac' });
    expect(resolveDevicePhrase('windows', devices, 'mac')).toMatchObject({ kind: 'device', id: 'pc' });
    expect(resolveDevicePhrase('here', devices, 'ph')).toMatchObject({ kind: 'device', id: 'ph', self: true });
  });

  it('PC / computer / desktop mean the Windows device, wherever the user is and whichever device is active', () => {
    for (const phrase of ['my pc', 'my computer', 'the desktop', 'windows', 'my gaming pc']) {
      expect(resolveDevicePhrase(phrase, devices, 'ph')).toMatchObject({ kind: 'device', id: 'pc' });
      expect(resolveDevicePhrase(phrase, devices, 'mac')).toMatchObject({ kind: 'device', id: 'pc' });
    }
  });

  it('a device that is not connected is offline, said the way it was asked', () => {
    expect(resolveDevicePhrase('my phone', devices.slice(0, 2), 'pc')).toEqual({ kind: 'offline', noun: 'a phone' });
    expect(resolveDevicePhrase('the ipad', devices, 'pc')).toEqual({ kind: 'offline', noun: 'an iPad' });
    expect(resolveDevicePhrase('my pc', devices.slice(1), 'mac')).toEqual({ kind: 'offline', noun: 'a PC' });
  });

  it('two Windows devices: this one when it is one of them, else ask', () => {
    const two: HeraldDeviceInfo[] = [...devices, { id: 'pc2', label: 'Windows desktop', handsFree: false }];
    expect(resolveDevicePhrase('my pc', two, 'pc2')).toMatchObject({ kind: 'device', id: 'pc2', self: true });
    expect(resolveDevicePhrase('my pc', two, 'mac')).toEqual({
      kind: 'ambiguous',
      labels: ['Chrome on Windows', 'Windows desktop'],
      devices: [{ id: 'pc', label: 'Chrome on Windows' }, { id: 'pc2', label: 'Windows desktop' }],
    });
  });
});

describe('"Show me a companion on my PC." (bug: answered on the Mac)', () => {
  // As the hub listed them: the Mac app is the active device, the user is on the Windows app.
  const fleet: HeraldDeviceInfo[] = [
    { id: 'mac', label: 'Mac desktop', handsFree: false, platform: { os: 'macos', app: 'native' } },
    { id: 'win', label: 'Windows desktop', handsFree: false, platform: { os: 'windows', app: 'native' } },
    { id: 'ph', label: 'Companion app on Android', handsFree: false, platform: { os: 'android', app: 'native' } },
  ];

  it('is a show command for "companion" on "my pc" (the extra "a" is dropped)', () => {
    expect(matchShowCommand('Show me a companion on my PC.', fleet.map((d) => d.label))).toEqual({ target: 'companion', device: 'my pc' });
    expect(matchShowCommand('show me an out4 on the phone')).toEqual({ target: 'out4', device: 'the phone' });
  });

  it('"my PC" is the Windows device, never the active Mac', () => {
    expect(resolveDevicePhrase('my pc', fleet, 'win')).toMatchObject({ kind: 'device', id: 'win', self: true });
    expect(resolveDevicePhrase('my pc', fleet, 'ph')).toMatchObject({ kind: 'device', id: 'win', self: false });
  });

  it('platform beats the label: a renamed Windows PC is still "my PC"', () => {
    const renamed = fleet.map((d) => (d.id === 'win' ? { ...d, label: 'Battlestation' } : d));
    expect(resolveDevicePhrase('my pc', renamed, 'mac')).toMatchObject({ kind: 'device', id: 'win' });
    expect(resolveDevicePhrase('battlestation', renamed, 'mac')).toMatchObject({ kind: 'device', id: 'win' });
  });

  it.each([
    ['PC', 'win'], ['my PC', 'win'], ['computer', 'win'], ['desktop', 'win'], ['Windows', 'win'], ['gaming PC', 'win'],
    ['Mac', 'mac'], ['MacBook', 'mac'], ['laptop', 'mac'],
    ['phone', 'ph'], ['Android', 'ph'],
    ['here', 'win'], ['this one', 'win'],
  ])('"%s" -> %s', (phrase, id) => {
    expect(resolveDevicePhrase(phrase, fleet, 'win')).toMatchObject({ kind: 'device', id });
  });

  it('iPhone / iPad / tablet with none connected: "I don\'t see ..."', () => {
    expect(resolveDevicePhrase('iPhone', fleet, 'win')).toEqual({ kind: 'offline', noun: 'an iPhone' });
    expect(resolveDevicePhrase('tablet', fleet, 'win')).toEqual({ kind: 'offline', noun: 'a tablet' });
    const withPad = [...fleet, { id: 'pad', label: 'Safari on iPad', handsFree: false, platform: { os: 'ipados' as const, app: 'browser' as const } }];
    expect(resolveDevicePhrase('iPad', withPad, 'win')).toMatchObject({ kind: 'device', id: 'pad' });
    expect(resolveDevicePhrase('tablet', withPad, 'win')).toMatchObject({ kind: 'device', id: 'pad' });
  });

  it('runs end to end: asks the hub for the Windows device', async () => {
    const requests: unknown[] = [];
    const acks: string[] = [];
    const cmd = matchShowCommand('Show me a companion on my PC.', fleet.map((d) => d.label))!;
    const out = await runShowCommand(cmd, 'Show me a companion on my PC.', {
      devices: () => fleet,
      selfId: () => 'win',
      activeId: () => 'mac',
      request: async (req) => {
        requests.push(req);
        return { status: 'shown', session: { serverId: 'local', sessionId: 'c', sessionName: 'Companion' }, device: { id: 'win', label: 'Windows desktop' } };
      },
      localTarget: () => null,
      navigateHere: () => {},
      say: () => {},
      ack: (l) => acks.push(l),
      sendToBrain: () => {},
      setClarify: () => {},
      now: () => 0,
    });
    expect(requests).toEqual([{ session: 'companion', device: 'win' }]);
    expect(out).toBe('shown_here');
    expect(acks).toEqual(["Here's Companion."]);
  });

  it('no PC connected: says so, never shows it on the Mac', async () => {
    const said: string[] = [];
    const request = vi.fn();
    const out = await runShowCommand({ target: 'companion', device: 'my pc' }, 'Show me a companion on my PC.', {
      devices: () => fleet.filter((d) => d.id !== 'win'),
      selfId: () => 'ph',
      activeId: () => 'mac',
      request,
      localTarget: () => null,
      navigateHere: () => {},
      say: (l) => said.push(l),
      ack: () => {},
      sendToBrain: () => {},
      setClarify: () => {},
      now: () => 0,
    });
    expect(out).toBe('offline');
    expect(request).not.toHaveBeenCalled();
    expect(said).toEqual(["I don't see a PC connected."]);
  });
});

describe('ambiguity: "Which one, Out4 or Docs?"', () => {
  const c = ['Out4', 'Docs', 'Doc Upload Site'];
  it('lists at most three', () => {
    expect(orList(['Out4', 'Docs'])).toBe('Out4 or Docs');
    expect(orList(['a', 'b', 'c', 'd'])).toBe('a, b or c');
  });
  it('picks from a short answer', () => {
    expect(matchClarifyAnswer('Out4', c)).toBe('Out4');
    expect(matchClarifyAnswer('out 4', c)).toBe('Out4');
    expect(matchClarifyAnswer('the docs one', c)).toBe('Docs');
    expect(matchClarifyAnswer('doc upload', c)).toBe('Doc Upload Site');
    expect(matchClarifyAnswer('the second one', c)).toBe('Docs');
    expect(matchClarifyAnswer('the last one', c)).toBe('Doc Upload Site');
    expect(matchClarifyAnswer('show me Out4', c)).toBe('Out4');
  });
  it('anything else is not an answer', () => {
    expect(matchClarifyAnswer('never mind', c)).toBeNull();
    expect(matchClarifyAnswer('what is the weather like in Paris today', c)).toBeNull();
    expect(matchClarifyAnswer('doc', ['Docs', 'Doc Upload Site'])).toBeNull();
  });
});

describe('localShowTarget (older hub): same order as the hub', () => {
  const card = { id: 'a', status: 'pending', kind: 'send_input', serverId: 'local', sessionId: 'out4', sessionName: 'Out4', createdAt: 5 } as HeraldAction;
  it('card, then the latest Herald message, then the newest unheard inbox item', () => {
    const messages = [{ id: 'm', role: 'herald' as const, text: '', createdAt: 1, sessionRefs: [{ serverId: 'local', sessionId: 'docs', sessionName: 'Docs' }] }];
    const inbox = [{ id: 'i', serverId: 'local', sessionId: 'blog', sessionName: 'Blog', priority: 'finished' as const, headline: '', createdAt: 1, heard: false }];
    expect(localShowTarget({ actions: [card], messages, inbox })?.sessionId).toBe('out4');
    expect(localShowTarget({ actions: [{ ...card, status: 'sent' }], messages, inbox })?.sessionId).toBe('docs');
    expect(localShowTarget({ actions: [], messages: [...messages, { id: 'n', role: 'herald', text: '', createdAt: 2 }], inbox })?.sessionId).toBe('blog');
    expect(localShowTarget({ inbox: [{ ...inbox[0], heard: true }] })).toBeNull();
  });
});

describe('runShowCommand', () => {
  function actions(result: HeraldShowResult | Error, over: Partial<ShowActions> = {}) {
    const calls = { said: [] as string[], acks: [] as string[], brain: [] as string[], requests: [] as unknown[], nav: [] as string[], clarify: [] as unknown[] };
    const a: ShowActions = {
      devices: () => devices,
      selfId: () => 'pc',
      activeId: () => 'pc',
      request: vi.fn(async (req) => {
        calls.requests.push(req);
        if (result instanceof Error) throw result;
        return result;
      }),
      localTarget: () => ({ serverId: 'local', sessionId: 'out4', sessionName: 'Out4' }),
      navigateHere: (r) => calls.nav.push(r.sessionId),
      say: (l) => calls.said.push(l),
      ack: (l) => calls.acks.push(l),
      sendToBrain: (t) => calls.brain.push(t),
      setClarify: (c) => calls.clarify.push(c),
      now: () => 1000,
      ...over,
    };
    return { a, calls };
  }
  const out4 = { serverId: 'local', sessionId: 'out4', sessionName: 'Out4' };

  it('shown here: "Here\'s Out4."', async () => {
    const { a, calls } = actions({ status: 'shown', session: out4, device: { id: 'pc', label: 'Chrome on Windows' } });
    expect(await runShowCommand({ target: null, device: null }, 'show me', a)).toBe('shown_here');
    expect(calls.requests).toEqual([{}]);
    expect(calls.acks).toEqual(["Here's Out4."]);
  });

  it('cross-device: sends the resolved device id and names it in the answer', async () => {
    const { a, calls } = actions({ status: 'shown', session: out4, device: { id: 'ph', label: 'Companion app on Android' } });
    expect(await runShowCommand({ target: 'out4', device: 'my phone' }, 'show me out4 on my phone', a)).toBe('shown_there');
    expect(calls.requests).toEqual([{ session: 'out4', device: 'ph' }]);
    expect(calls.acks).toEqual(['Out4 is up on Companion app on Android.']);
  });

  it('an offline device is said without asking the hub', async () => {
    const { a, calls } = actions({ status: 'shown' }, { devices: () => devices.slice(0, 2) });
    expect(await runShowCommand({ target: null, device: 'my phone' }, 'show me on my phone', a)).toBe('offline');
    expect(calls.requests).toHaveLength(0);
    expect(calls.said).toEqual(["I don't see a phone connected."]);
  });

  it('several devices match: asks which one and keeps the session for the answer', async () => {
    const two: HeraldDeviceInfo[] = [...devices, { id: 'pc2', label: 'Windows desktop', handsFree: false }];
    const { a, calls } = actions({ status: 'shown' }, { devices: () => two, selfId: () => 'ph' });
    expect(await runShowCommand({ target: 'out4', device: 'my pc' }, 'show me out4 on my pc', a)).toBe('ambiguous_device');
    expect(calls.requests).toHaveLength(0);
    expect(calls.said).toEqual(['Which one, Chrome on Windows or Windows desktop?']);
    expect(calls.clarify).toEqual([{
      candidates: ['Chrome on Windows', 'Windows desktop'],
      devices: [{ id: 'pc', label: 'Chrome on Windows' }, { id: 'pc2', label: 'Windows desktop' }],
      target: 'out4',
      until: 21_000,
    }]);
    expect(matchClarifyAnswer('the windows desktop', ['Chrome on Windows', 'Windows desktop'])).toBe('Windows desktop');
  });

  it('ambiguous: asks which one and waits for the answer', async () => {
    const { a, calls } = actions({ status: 'ambiguous', candidates: ['Out4', 'Docs'] });
    expect(await runShowCommand({ target: 'o', device: null }, 'open o', a)).toBe('ambiguous');
    expect(calls.said).toEqual(['Which one, Out4 or Docs?']);
    expect(calls.clarify).toEqual([{ candidates: ['Out4', 'Docs'], deviceId: undefined, until: 21_000 }]);
  });

  it('a name that matches no session goes to the brain as said', async () => {
    const { a, calls } = actions({ status: 'not_found' });
    expect(await runShowCommand({ target: 'pod bay doors', device: null }, 'Open the pod bay doors', a)).toBe('to_brain');
    expect(calls.brain).toEqual(['Open the pod bay doors']);
    expect(calls.said).toEqual([]);
  });

  it('nothing to show / no device', async () => {
    const n = actions({ status: 'nothing' });
    expect(await runShowCommand({ target: null, device: null }, 'show me', n.a)).toBe('nothing');
    expect(n.calls.said).toEqual(['Nothing to show right now.']);
    const d = actions({ status: 'no_device' });
    expect(await runShowCommand({ target: null, device: null }, 'show me', d.a)).toBe('no_device');
  });

  it('an older hub: unnamed "show me" opens locally; a named one goes to the brain', async () => {
    const old = actions(new Error('Unknown message type'));
    expect(await runShowCommand({ target: null, device: null }, 'show me', old.a)).toBe('shown_local');
    expect(old.calls.nav).toEqual(['out4']);
    expect(old.calls.acks).toEqual(["Here's Out4."]);
    const named = actions(new Error('nope'));
    expect(await runShowCommand({ target: 'docs', device: null }, 'show me docs', named.a)).toBe('to_brain');
  });

  it('a clarified answer reuses the device of the question', async () => {
    const { a, calls } = actions({ status: 'shown', session: out4, device: { id: 'ph', label: 'Phone' } });
    await runShowCommand({ target: 'Out4', device: null }, 'Out4', a, 'ph');
    expect(calls.requests).toEqual([{ session: 'Out4', device: 'ph' }]);
  });
});
