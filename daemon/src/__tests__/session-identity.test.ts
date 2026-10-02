import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  bornAfter,
  processStartMs,
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

describe('bornAfter / processStartMs', () => {
  it('a transcript created before the session started is not claimable', () => {
    expect(bornAfter({ birthtimeMs: 5_000, mtimeMs: 99_000 }, 50_000)).toBe(false);
    expect(bornAfter({ birthtimeMs: 60_000, mtimeMs: 60_000 }, 50_000)).toBe(true);
    // No birthtime on this filesystem: fall back to mtime.
    expect(bornAfter({ birthtimeMs: 0, mtimeMs: 60_000 }, 50_000)).toBe(true);
  });

  it('reads a process start time from /proc', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fakeproc-'));
    fs.mkdirSync(path.join(root, '42'));
    // comm with spaces and parens; starttime (field 22) = 250 ticks = 2.5 s after boot
    const fields = Array.from({ length: 40 }, () => '0');
    fields[18] = '250'; // fields start at field 4
    fs.writeFileSync(path.join(root, '42', 'stat'), `42 (my (odd) proc) S ${fields.join(' ')}`);
    fs.writeFileSync(path.join(root, 'stat'), 'cpu 1 2 3\nbtime 1700000000\n');
    expect(await processStartMs(42, root)).toBe(1700000000 * 1000 + 2500);
    expect(await processStartMs(43, root)).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('matches the real /proc for this process (Linux)', async () => {
    if (!fs.existsSync('/proc/self/stat')) return;
    const t = await processStartMs(process.pid);
    expect(t).not.toBeNull();
    expect(Math.abs(Date.now() - process.uptime() * 1000 - (t as number))).toBeLessThan(5000);
  });
});
