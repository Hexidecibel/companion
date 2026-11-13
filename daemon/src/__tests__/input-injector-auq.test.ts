/**
 * InputInjector with a Claude Code AskUserQuestion box on screen (real
 * capture): choices go to the step-by-step driver and report the outcome;
 * free text is refused (digits / Enter would answer the box).
 */
import * as fs from 'fs';
import * as path from 'path';
import { InputInjector } from '../input-injector';

const mockTmux = jest.fn();
jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execFile: (
    file: string,
    args: string[],
    _options: unknown,
    callback: (err: Error | null, stdout: string, stderr: string) => void
  ) => {
    const res = mockTmux(file, args) as { status: number; stdout: string };
    const err = res.status === 0 ? null : Object.assign(new Error('failed'), { code: res.status });
    callback(err, res.stdout ?? '', '');
    return { on: () => {} };
  },
}));

const SINGLE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'cc-contract', 'auq-cc2.1.323-single-w120-s1.txt'),
  'utf8'
);
const GONE = '❯ \n──────\n  ? for shortcuts';

describe('InputInjector and the AskUserQuestion box', () => {
  let screen: string;
  let sent: string[][];
  let injector: InputInjector;

  beforeEach(() => {
    screen = SINGLE;
    sent = [];
    mockTmux.mockReset();
    mockTmux.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'capture-pane') return { status: 0, stdout: screen };
      if (args[0] === 'send-keys') {
        sent.push(args.slice(3));
        if (args.includes('2')) screen = GONE;
        return { status: 0, stdout: '' };
      }
      if (args[0] === 'display-message') return { status: 0, stdout: '' };
      return { status: 0, stdout: '' };
    });
    injector = new InputInjector('t', { sleep: async () => {} });
  });

  it('answers through the driver and reports the outcome', async () => {
    const r = await injector.sendChoiceDetailed([1], 3, false, undefined, 't');
    expect(r).toEqual({ ok: true, outcome: 'answered' });
    expect(sent).toEqual([['2']]);
  });

  it('reports choice_not_applied when the box does not react', async () => {
    mockTmux.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === 'capture-pane' ? { status: 0, stdout: SINGLE } : { status: 0, stdout: '' }
    );
    const r = await injector.sendChoiceDetailed([1], 3, false, undefined, 't');
    expect(r).toMatchObject({ ok: false, error: 'choice_not_applied' });
  });

  it('navigate with no question box on screen is prompt_gone, nothing typed', async () => {
    screen = GONE;
    const r = await injector.sendChoiceDetailed([], 0, false, undefined, 't', { navigate: 'back' });
    expect(r).toMatchObject({ ok: false, error: 'prompt_gone' });
    expect(sent).toEqual([]);
  });

  it('refuses free text while the box is up', async () => {
    const r = await injector.sendInputDetailed('hello', 't');
    expect(r.ok).toBe(false);
    expect(sent).toEqual([]);
  });
});
