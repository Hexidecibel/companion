import { GitError, GitRunner, ExecFileFn, hardenArgs, pathspecStdin } from '../git-runner';

type Call = { args: string[]; opts: any; cb: (err: any, out: Buffer, errb: Buffer) => void; stdin: Array<string | Buffer | undefined> };

function fakeExec() {
  const calls: Call[] = [];
  const fn: ExecFileFn = (_file, args, opts, cb) => {
    const call: Call = { args, opts, cb, stdin: [] };
    calls.push(call);
    return { stdin: { end: (d?: string | Buffer) => call.stdin.push(d), on: () => undefined } };
  };
  return { calls, fn };
}
const ok = (c: Call, out = 'x') => c.cb(null, Buffer.from(out), Buffer.from(''));
const flush = () => new Promise((r) => setImmediate(r));

describe('GitRunner', () => {
  it('dedupes two concurrent identical calls into one spawn', async () => {
    const { calls, fn } = fakeExec();
    const r = new GitRunner({ execFileFn: fn });
    const a = r.run({ cwd: '/r', args: ['status'] });
    const b = r.run({ cwd: '/r', args: ['status'] });
    expect(calls).toHaveLength(1);
    ok(calls[0], 'same');
    expect((await a).stdout).toBe('same');
    expect((await b).stdout).toBe('same');
  });

  it('uses execFile options: SIGKILL, timeout per kind, maxBuffer, safety env + flags', async () => {
    const { calls, fn } = fakeExec();
    const r = new GitRunner({ execFileFn: fn });
    const p = r.run({ cwd: '/r', args: ['diff', 'HEAD'], kind: 'diff' });
    const c = calls[0];
    expect(c.opts.killSignal).toBe('SIGKILL');
    expect(c.opts.timeout).toBe(8000);
    expect(c.opts.maxBuffer).toBe(8 * 1024 * 1024);
    expect(c.opts.env.GIT_OPTIONAL_LOCKS).toBe('0');
    expect(c.opts.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(c.opts.env.LC_ALL).toBe('C');
    expect(c.args.slice(0, 6)).toEqual(['-c', 'core.quotepath=off', '-c', 'color.ui=never', '-c', 'core.fsmonitor=false']);
    expect(c.args).toEqual(expect.arrayContaining(['--no-ext-diff', '--no-textconv']));
    ok(c);
    await p;
  });

  it('timeout (killed by SIGKILL) -> GitError timeout', async () => {
    const { calls, fn } = fakeExec();
    const r = new GitRunner({ execFileFn: fn });
    const p = r.run({ cwd: '/r', args: ['status'] });
    calls[0].cb(Object.assign(new Error('t'), { killed: true, signal: 'SIGKILL' }), Buffer.from(''), Buffer.from(''));
    await expect(p).rejects.toMatchObject({ code: 'timeout' });
  });

  it('non-zero exit resolves with the code', async () => {
    const { calls, fn } = fakeExec();
    const r = new GitRunner({ execFileFn: fn });
    const p = r.run({ cwd: '/r', args: ['diff', '--quiet'] });
    calls[0].cb(Object.assign(new Error('x'), { code: 1 }), Buffer.from(''), Buffer.from(''));
    expect((await p).code).toBe(1);
  });

  it('maxBuffer overflow -> too_large', async () => {
    const { calls, fn } = fakeExec();
    const r = new GitRunner({ execFileFn: fn });
    const p = r.run({ cwd: '/r', args: ['diff'] });
    calls[0].cb(Object.assign(new Error('x'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), Buffer.from(''), Buffer.from(''));
    await expect(p).rejects.toMatchObject({ code: 'too_large' });
  });

  it('runs at most 3 at once and rejects busy past a queue of 20', async () => {
    const { calls, fn } = fakeExec();
    const r = new GitRunner({ execFileFn: fn });
    const ps: Promise<unknown>[] = [];
    for (let i = 0; i < 23; i++) ps.push(r.run({ cwd: '/r', args: ['show', String(i)] }).catch((e) => e));
    expect(calls).toHaveLength(3);
    expect(r.stats().queued).toBe(20);
    const busy = await r.run({ cwd: '/r', args: ['show', 'x'] }).catch((e) => e);
    expect(busy).toBeInstanceOf(GitError);
    expect(busy.code).toBe('busy');
    ok(calls[0]);
    await flush();
    await flush();
    expect(calls).toHaveLength(4);
    for (let i = 1; i < 23; i++) {
      while (calls.length <= i) await flush();
      ok(calls[i]);
    }
    await Promise.all(ps);
    expect(calls).toHaveLength(23);
  });

  it('breaker trips after 3 timeouts in 60 s and recovers after 5 min', async () => {
    let now = 1000;
    const { calls, fn } = fakeExec();
    const r = new GitRunner({ execFileFn: fn, now: () => now });
    for (let i = 0; i < 3; i++) {
      const p = r.run({ cwd: '/r', repoKey: '/repo', args: ['status', String(i)] });
      calls[i].cb(Object.assign(new Error('t'), { killed: true, signal: 'SIGKILL' }), Buffer.from(''), Buffer.from(''));
      await expect(p).rejects.toMatchObject({ code: 'timeout' });
    }
    expect(r.isDegraded('/repo')).toBe(true);
    await expect(r.run({ cwd: '/r', repoKey: '/repo', args: ['status'] })).rejects.toMatchObject({ code: 'degraded' });
    expect(calls).toHaveLength(3);
    now += 5 * 60_000 + 1;
    expect(r.isDegraded('/repo')).toBe(false);
  });

  it('pathspecs go through stdin, never argv', async () => {
    const { calls, fn } = fakeExec();
    const r = new GitRunner({ execFileFn: fn });
    await expect(r.run({ cwd: '/r', args: ['diff', '--', 'a.ts'] })).rejects.toMatchObject({ code: 'bad_args' });
    const ps = pathspecStdin(['a b.ts', 'c.ts']);
    const p = r.run({ cwd: '/r', args: ['add', '-A', ...ps.args], stdin: ps.stdin, kind: 'write' });
    expect(calls[0].args).not.toContain('a b.ts');
    expect(calls[0].stdin[0]).toBe(':(literal)a b.ts\0:(literal)c.ts');
    ok(calls[0]);
    await p;
  });

  it('git disabled -> never execs', async () => {
    const { calls, fn } = fakeExec();
    const r = new GitRunner({ execFileFn: fn, enabled: () => false });
    await expect(r.run({ cwd: '/r', args: ['status'] })).rejects.toMatchObject({ code: 'git_disabled' });
    expect(calls).toHaveLength(0);
  });

  it('hardenArgs leaves non-diff commands alone', () => {
    expect(hardenArgs(['status'])).toEqual(['status']);
    expect(hardenArgs(['diff', '--no-ext-diff'])).toEqual(['diff', '--no-textconv', '--no-ext-diff']);
  });
});
