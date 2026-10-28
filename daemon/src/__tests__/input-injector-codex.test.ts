/**
 * InputInjector driving a Codex pane: keys come from the session's adapter
 * (bracketed paste + Enter, Esc to interrupt, digits only on a live box).
 */
import * as fs from 'fs';
import * as path from 'path';

const mockTmux = jest.fn();
jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execFile: (
    _file: string,
    args: string[],
    _options: unknown,
    callback: (err: Error | null, stdout: string, stderr: string) => void
  ) => {
    const res = mockTmux(args) as { status: number; stdout: string };
    const err = res.status === 0 ? null : Object.assign(new Error('fail'), { code: res.status });
    callback(err, res.stdout, '');
    return { on: () => {} };
  },
}));

import { InputInjector } from '../input-injector';
import { claudeAdapter, codexAdapter } from '../agents';

const FIX = path.join(__dirname, '..', 'agents', '__tests__', 'fixtures', 'codex');
const IDLE = fs.readFileSync(path.join(FIX, 'live-idle.ansi'), 'utf-8');
const APPROVAL = fs.readFileSync(path.join(FIX, 'live-approval-exec.txt'), 'utf-8');

describe('InputInjector with a Codex pane', () => {
  let pane = IDLE;
  const sleep = jest.fn(async () => {});
  const make = () => {
    const inj = new InputInjector('s', { sleep });
    inj.setAgentResolver((name) => (name === 'cdx' ? codexAdapter : claudeAdapter));
    return inj;
  };
  const calls = () => mockTmux.mock.calls.map((c) => c[0] as string[]);
  const sends = () => calls().filter((a) => ['send-keys', 'set-buffer', 'paste-buffer'].includes(a[0]));

  beforeEach(() => {
    pane = IDLE;
    mockTmux.mockReset();
    mockTmux.mockImplementation((args: string[]) => {
      if (args[0] === 'capture-pane') return { status: 0, stdout: pane };
      if (args[0] === 'list-clients') return { status: 0, stdout: '' };
      return { status: 0, stdout: '' };
    });
  });

  it('sends text as one bracketed paste, then Enter', async () => {
    const r = await make().sendInputDetailed('line one\nline two', 'cdx');
    expect(r.ok).toBe(true);
    const s = sends();
    expect(s[0].slice(0, 2)).toEqual(['set-buffer', '-b']);
    expect(s[0].slice(-2)).toEqual(['--', 'line one\nline two']);
    const buffer = s[0][2];
    expect(s[1]).toEqual(['paste-buffer', '-p', '-d', '-b', buffer, '-t', 'cdx']);
    expect(s[2]).toEqual(['send-keys', '-t', 'cdx', 'Enter']);
    expect(s).toHaveLength(3);
  });

  it('refuses when the composer holds a draft', async () => {
    pane = IDLE.replace(/\x1b\[2mAsk Codex to do anything\x1b\[0m/, 'my own words');
    const r = await make().sendInputDetailed('hello', 'cdx');
    expect(r).toMatchObject({ ok: false, reason: 'draft' });
    expect(sends()).toHaveLength(0);
  });

  it('interrupts with Esc (never Ctrl+C), also for a literal Ctrl+C character', async () => {
    expect(await make().cancelInput('cdx')).toBe(true);
    expect(sends()).toEqual([['send-keys', '-t', 'cdx', 'Escape']]);
    mockTmux.mockClear();
    expect((await make().sendInputDetailed('\x03', 'cdx')).ok).toBe(true);
    expect(sends()).toEqual([['send-keys', '-t', 'cdx', 'Escape']]);
  });

  it('answers the approval box with the digit only while it is on screen', async () => {
    pane = IDLE;
    expect(await make().sendChoice([0], 3, false, undefined, 'cdx')).toBe(false);
    expect(sends()).toHaveLength(0);
    pane = APPROVAL;
    expect(await make().sendChoice([1], 3, false, undefined, 'cdx')).toBe(true);
    expect(sends()).toEqual([['send-keys', '-t', 'cdx', '2']]);
  });

  it('Claude panes keep typed text + Enter and Ctrl+C', async () => {
    pane = '';
    expect((await make().sendInputDetailed('hi', 'cl')).ok).toBe(true);
    expect(sends()).toEqual([
      ['send-keys', '-t', 'cl', '-l', '--', 'hi'],
      ['send-keys', '-t', 'cl', 'Enter'],
    ]);
    mockTmux.mockClear();
    await make().cancelInput('cl');
    expect(sends()).toEqual([['send-keys', '-t', 'cl', 'C-c']]);
  });
});
