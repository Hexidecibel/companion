import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  encodeProjectDir,
  findClaudePid,
  identityChanged,
  parsePaneInfo,
  sanitizeIdentity,
  SessionIdentity,
} from '../session-identity';

describe('encodeProjectDir (Claude Code project dir names)', () => {
  it.each([
    ['/home/hexi/local/src/companion', '-home-hexi-local-src-companion'],
    ['/home/hexi/.cache/companion-herald', '-home-hexi--cache-companion-herald'],
    ['/tmp/foo_bar/v1.2', '-tmp-foo-bar-v1-2'],
    ['/Users/a b/x', '-Users-a-b-x'],
  ])('%s -> %s', (input, out) => {
    expect(encodeProjectDir(input)).toBe(out);
  });
});

describe('parsePaneInfo', () => {
  it('reads path, creation time and pane pid', () => {
    expect(parsePaneInfo('/home/u/.cache/x\t1700000000\t4242\n')).toEqual({
      workingDir: '/home/u/.cache/x',
      created: '1700000000',
      panePid: 4242,
    });
  });
  it('tolerates a bare path (unknown identity)', () => {
    expect(parsePaneInfo('/home/u/p\n')).toEqual({
      workingDir: '/home/u/p',
      created: '',
      panePid: 0,
    });
  });
});

describe('identityChanged', () => {
  const base: SessionIdentity = { created: '100', panePid: 10, encodedPath: '-a', claudePid: 20 };
  it('same session, same claude -> kept', () => {
    expect(identityChanged(base, { ...base })).toBe(false);
  });
  it('no previous identity (older mapping file) -> kept', () => {
    expect(identityChanged(undefined, base)).toBe(false);
  });
  it('session created again with the same name -> stale', () => {
    expect(identityChanged(base, { ...base, created: '200' })).toBe(true);
    expect(identityChanged(base, { ...base, panePid: 11 })).toBe(true);
  });
  it('new claude process in the same session -> stale', () => {
    expect(identityChanged(base, { ...base, claudePid: 21 })).toBe(true);
  });
  it('claude not running right now, or unknown fields -> not a change', () => {
    expect(identityChanged(base, { ...base, claudePid: null })).toBe(false);
    expect(identityChanged({ ...base, claudePid: null }, base)).toBe(false);
    expect(
      identityChanged({ ...base, created: '' }, { ...base, created: '300', panePid: 10 })
    ).toBe(false);
  });
  it('a cwd change alone is not a change', () => {
    expect(identityChanged(base, { ...base, encodedPath: '-b' })).toBe(false);
  });
  it('sanitizes persisted identities', () => {
    expect(sanitizeIdentity({ created: '1', panePid: 'x', claudePid: 5 })).toEqual({
      created: '1',
      panePid: 0,
      encodedPath: '',
      claudePid: 5,
    });
    expect(sanitizeIdentity(null)).toBeUndefined();
  });
});

describe('findClaudePid (fake /proc)', () => {
  function fakeProc(tree: Record<number, { cmd: string[]; children?: number[] }>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fakeproc-'));
    for (const [pid, p] of Object.entries(tree)) {
      fs.mkdirSync(path.join(root, pid, 'task', pid), { recursive: true });
      fs.writeFileSync(path.join(root, pid, 'cmdline'), p.cmd.join('\0') + '\0');
      fs.writeFileSync(path.join(root, pid, 'task', pid, 'children'), (p.children || []).join(' '));
    }
    return root;
  }

  it('finds the native claude binary under the shell', async () => {
    const root = fakeProc({
      10: { cmd: ['-bash'], children: [11] },
      11: { cmd: ['/home/u/.local/bin/claude', '--resume'], children: [12] },
      12: { cmd: ['bash', '-c', 'npm test'] },
    });
    expect(await findClaudePid(10, root)).toBe(11);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finds a node-launched claude cli', async () => {
    const root = fakeProc({
      10: { cmd: ['fish'], children: [11] },
      11: { cmd: ['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'] },
    });
    expect(await findClaudePid(10, root)).toBe(11);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('null without claude, without /proc, or without a pid', async () => {
    const root = fakeProc({
      10: { cmd: ['bash'], children: [11] },
      11: { cmd: ['vim', 'claude.md'] },
    });
    expect(await findClaudePid(10, root)).toBeNull();
    expect(await findClaudePid(10, path.join(root, 'nope'))).toBeNull();
    expect(await findClaudePid(0, root)).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
