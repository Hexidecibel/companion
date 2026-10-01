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
    expect(resolveDevicePhrase('my phone', devices, 'pc', 'pc')).toMatchObject({ kind: 'device', id: 'ph', self: false });
    expect(resolveDevicePhrase('the mac', devices, 'pc', 'pc')).toMatchObject({ kind: 'device', id: 'mac' });
    expect(resolveDevicePhrase('work mac', devices, 'pc', 'pc')).toMatchObject({ kind: 'device', id: 'mac' });
    expect(resolveDevicePhrase('windows', devices, 'mac', 'mac')).toMatchObject({ kind: 'device', id: 'pc' });
    expect(resolveDevicePhrase('here', devices, 'ph', 'pc')).toMatchObject({ kind: 'device', id: 'ph', self: true });
  });

  it('"my computer" with two computers: the active one, else this one, else ask', () => {
    expect(resolveDevicePhrase('my computer', devices, 'ph', 'mac')).toMatchObject({ id: 'mac' });
    expect(resolveDevicePhrase('my computer', devices, 'pc', 'ph')).toMatchObject({ id: 'pc' });
    expect(resolveDevicePhrase('my computer', devices, 'ph', 'ph')).toEqual({
      kind: 'ambiguous',
      labels: ['Chrome on Windows', 'Work Mac'],
    });
  });

  it('a device that is not connected is offline, named the way it was said', () => {
    expect(resolveDevicePhrase('my phone', devices.slice(0, 2), 'pc', 'pc')).toEqual({ kind: 'offline', name: 'Your phone' });
    expect(resolveDevicePhrase('the ipad', devices, 'pc', 'pc')).toEqual({ kind: 'offline', name: 'Your iPad' });
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
    expect(calls.said).toEqual(["Your phone isn't connected."]);
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
