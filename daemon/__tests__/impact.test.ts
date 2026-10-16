import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ImpactRegistry, histQuantile, computeFlags } from '../src/impact/registry';
import { runSub, trySub, kindOfCommand, dedupeSub } from '../src/impact/sub';
import { impact } from '../src/impact/state';
import { classifyCmdline, readProcStat, readSwap } from '../src/impact/sampler';
import { TmuxSnapshotSource, parseListPanes, LIST_PANES_FORMAT } from '../src/tmux-snapshot';
import type { SubResult } from '../src/impact/sub';

describe('ImpactRegistry', () => {
  let t = Date.parse('2026-10-15T10:00:30Z');
  const now = () => t;

  it('aggregates subprocesses per kind with rates, p95, timeouts and concurrency peak', () => {
    const r = new ImpactRegistry({ now });
    r.subStart('tmux:list-panes');
    r.subStart('tmux:list-panes');
    r.subEnd('tmux:list-panes', 4);
    r.subEnd('tmux:list-panes', 6, { timedOut: true });
    for (let i = 0; i < 18; i++) r.recordSub('git:diff', 30);
    r.recordSub('git:diff', 900, { failed: true });
    r.recordSub('git:diff', 1200);
    const rep = r.report();
    const tmux = rep.recent.subprocesses.find((s) => s.kind === 'tmux:list-panes')!;
    expect(tmux.count).toBe(2);
    expect(tmux.timeouts).toBe(1);
    expect(tmux.inFlightPeak).toBe(2);
    const git = rep.recent.subprocesses.find((s) => s.kind === 'git:diff')!;
    expect(git.count).toBe(20);
    expect(git.failures).toBe(1);
    expect(git.p95Ms).toBe(1000); // 19th of 20 lands in the <=1000 slot
    expect(git.maxMs).toBe(1200);
    expect(rep.recent.subprocesses[0].kind).toBe('git:diff'); // sorted by count
    expect(rep.current.inFlight).toBe(0);
  });

  it('rolls minutes, keeps 24 h, and windows only count recent minutes', () => {
    t = Date.parse('2026-10-15T10:00:30Z');
    const r = new ImpactRegistry({ now });
    r.recordSub('a', 1);
    t += 20 * 60_000; // 20 min later
    r.recordSub('a', 1);
    r.recordSub('a', 1);
    const rep = r.report();
    expect(rep.recent.subprocesses[0].count).toBe(2);
    expect(rep.day.subprocesses[0].count).toBe(3);
    t += 25 * 3600_000; // a day later: everything older than 24 h dropped
    r.recordSub('b', 1);
    expect(r.report().day.subprocesses.map((s) => s.kind)).toEqual(['b']);
  });

  it('records loop lag, cpu, probe and counters; history buckets are 10 min', () => {
    t = Date.parse('2026-10-15T10:00:00Z');
    const r = new ImpactRegistry({ now });
    r.recordLoop(1, 20, 40);
    r.recordLoop(1, 150, 300);
    r.recordSelf(4, 100);
    r.recordSelf(6, 110);
    r.recordProbe(12);
    r.recordProbe(null);
    r.count('logLines', 5);
    r.recordTranscriptParse(1000, 3, true);
    r.recordTranscriptParse(10, 1, false);
    const rep = r.report();
    expect(rep.recent.loopP99Ms).toBe(150);
    expect(rep.recent.loopMaxMs).toBe(300);
    expect(rep.recent.cpuAvgPct).toBe(5);
    expect(rep.current.tmuxProbe).toEqual({ lastMs: null, avgMs: 12, maxMs: 12, failures: 1 });
    expect(rep.recent.counters).toMatchObject({
      logLines: 5,
      transcriptParses: 2,
      transcriptFullParses: 1,
      transcriptParseBytes: 1010,
    });
    expect(rep.history).toHaveLength(1);
    expect(rep.history[0]).toMatchObject({
      spanMin: 10,
      cpuPct: 5,
      rssMb: 110,
      logLines: 5,
      parses: 2,
    });
    expect(rep.flags.map((f) => f.id).sort()).toEqual(['loop_lag', 'tmux_slow']);
  });

  it('saves and loads history (only minutes before the current one)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-'));
    try {
      t = Date.parse('2026-10-15T10:00:00Z');
      const a = new ImpactRegistry({ now });
      a.recordSub('x', 5);
      t += 60_000;
      a.recordSub('x', 5);
      const file = path.join(dir, 'impact.json');
      a.save(file);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const b = new ImpactRegistry({ now });
      expect(b.load(file)).toBe(1); // the current minute is b's own
      expect(b.report().day.subprocesses[0].count).toBe(1);
      fs.writeFileSync(file, '{not json');
      expect(new ImpactRegistry({ now }).load(file)).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('histQuantile', () => {
    expect(histQuantile([0, 0, 0], 0.95, 0)).toBe(0);
    expect(histQuantile([10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 0.5, 9000)).toBe(1);
    expect(histQuantile([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3], 0.95, 9000)).toBe(9000);
  });

  it('flags each threshold', () => {
    const base = new ImpactRegistry({ now }).report();
    const flags = computeFlags(
      {
        ...base.current,
        procs: [{ name: 'daemon', pids: [1], cpuPct: 14, rssMb: 100, swapMb: 0 }],
        swap: { totalMb: 100, freeMb: 5, usedPct: 95 },
        tmuxProbe: { lastMs: 80, avgMs: 70, maxMs: 90, failures: 0 },
      },
      { ...base.recent, loopP99Ms: 120, cpuAvgPct: 14 },
      {
        ...base.day,
        subprocesses: [
          {
            kind: 'k',
            count: 1,
            perMin: 1,
            avgMs: 1,
            p95Ms: 1,
            maxMs: 1,
            timeouts: 2,
            failures: 0,
            inFlightPeak: 1,
          },
        ],
        counters: { ...base.day.counters, inputCollisions: 1 },
      }
    );
    expect(flags.map((f) => f.id).sort()).toEqual(
      ['daemon_cpu', 'loop_lag', 'sub_timeout', 'swap', 'tmux_slow', 'typing_collision'].sort()
    );
  });
});

describe('runSub / trySub', () => {
  it('runs without a shell, records the call and reports exit codes', async () => {
    const before =
      impact.report().recent.subprocesses.find((s) => s.kind === 'test:echo')?.count ?? 0;
    const r = await runSub('test:echo', 'echo', ['a b', '$HOME']);
    expect(r.stdout).toBe('a b $HOME\n'); // argv, no shell expansion
    const after = impact.report().recent.subprocesses.find((s) => s.kind === 'test:echo')!.count;
    expect(after).toBe(before + 1);
    await expect(runSub('test:false', 'false', [])).rejects.toBeTruthy();
    const f = await trySub('test:false', 'false', []);
    expect(f.code).toBe(1);
    expect(f.timedOut).toBe(false);
  });

  it('kills on timeout (SIGKILL) and counts it', async () => {
    const t0 = Date.now();
    const r = await trySub('test:sleep', 'sleep', ['5'], { timeoutMs: 150 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(
      impact.report().recent.subprocesses.find((s) => s.kind === 'test:sleep')!.timeouts
    ).toBeGreaterThan(0);
  });

  it('a missing binary is a failure, not a throw', async () => {
    const r = await trySub('test:missing', '/nonexistent/bin', []);
    expect(r.error).toBeTruthy();
    expect(r.code).toBe(-1);
  });

  it('dedupeSub shares an identical in-flight call', async () => {
    const [a, b] = await Promise.all([
      dedupeSub('test:d', 'echo', ['x']),
      dedupeSub('test:d', 'echo', ['x']),
    ]);
    expect(a).toBe(b);
  });

  it('kindOfCommand', () => {
    expect(kindOfCommand('tmux display-message -t "x" -p "#{pane_pid}"', 'w')).toBe(
      'tmux:display-message@w'
    );
    expect(kindOfCommand('git rev-parse --show-toplevel')).toBe('git:rev-parse');
    expect(kindOfCommand('/usr/bin/pstree -p 1')).toBe('pstree');
  });
});

describe('sampler helpers', () => {
  it('reads its own /proc stat and system swap', async () => {
    const st = await readProcStat('self');
    expect(st && st.ticks).toBeGreaterThanOrEqual(0);
    expect(st!.rssKb).toBeGreaterThan(0);
    const sw = await readSwap();
    expect(sw).not.toBeNull();
  });

  it('classifies voice / MCP processes', () => {
    expect(
      classifyCmdline(['/home/u/.local/share/herald-voice/venv/bin/python', '-m', 'herald_voice'])
    ).toBe('herald-voice');
    expect(classifyCmdline(['node', '/home/u/local/src/companion/mcp/dist/index.js'])).toBe('mcp');
    expect(classifyCmdline(['node', 'dist/index.js'])).toBeNull();
    expect(classifyCmdline(['vim', 'herald_voice.py'])).toBeNull();
  });
});

describe('TmuxSnapshotSource', () => {
  const row = (
    name: string,
    id: string,
    created: string,
    win: string,
    pane: string,
    cwd: string,
    pid = '100'
  ) => [name, id, created, '1', '2', win, pane, cwd, pid].join('\t');

  it('format has every field the parser reads', () => {
    expect(LIST_PANES_FORMAT.split('\t')).toHaveLength(9);
  });

  it("parseListPanes keeps each session's current pane", () => {
    const out = [
      row('a', '$1', '1700000000', '0', '1', '/other'),
      row('a', '$1', '1700000000', '1', '0', '/also-not'),
      row('a', '$1', '1700000000', '1', '1', '/cur', '42'),
      row('b', '$2', 'x', '1', '1', '/b'),
      'garbage',
    ].join('\n');
    const rows = parseListPanes(out);
    expect(rows).toEqual([
      {
        name: 'a',
        sessionId: '$1',
        created: '1700000000',
        attached: '1',
        windows: 2,
        workingDir: '/cur',
        panePid: 42,
      },
      {
        name: 'b',
        sessionId: '$2',
        created: '',
        attached: '1',
        windows: 2,
        workingDir: '/b',
        panePid: 100,
      },
    ]);
  });

  function fakeRunner(handler: (args: string[]) => Partial<SubResult>) {
    const calls: string[][] = [];
    const run = (async (args: string[]) => {
      calls.push(args);
      return {
        stdout: '',
        stderr: '',
        code: 0,
        timedOut: false,
        error: null,
        ...handler(args),
      } as SubResult;
    }) as unknown as ConstructorParameters<typeof TmuxSnapshotSource>[0] extends infer O
      ? O extends { run?: infer R }
        ? R
        : never
      : never;
    return { run, calls };
  }

  it('caches the listing, shares in-flight calls, and get(0) is always fresh', async () => {
    let t = 1_000_000;
    const { run, calls } = fakeRunner(() => ({ stdout: row('a', '$1', '1', '1', '1', '/a') }));
    const src = new TmuxSnapshotSource({ run, now: () => t });
    const [x, y] = await Promise.all([src.get(), src.get()]);
    expect(x).toBe(y);
    expect(calls).toHaveLength(1);
    await src.get();
    expect(calls).toHaveLength(1);
    t += 2500;
    await src.get();
    expect(calls).toHaveLength(2);
    await src.get(0);
    expect(calls).toHaveLength(3);
    src.invalidate();
    await src.get();
    expect(calls).toHaveLength(4);
  });

  it('no server = ok with no sessions; a timeout = not ok, keeping the last sessions', async () => {
    let mode: 'ok' | 'noserver' | 'timeout' = 'ok';
    const { run } = fakeRunner(() =>
      mode === 'ok'
        ? { stdout: row('a', '$1', '1', '1', '1', '/a') }
        : mode === 'noserver'
          ? {
              error: new Error('x'),
              code: 1,
              stderr: 'no server running on /tmp/tmux-1000/default',
            }
          : { error: new Error('killed'), timedOut: true }
    );
    const src = new TmuxSnapshotSource({ run });
    expect((await src.get(0)).sessions).toHaveLength(1);
    mode = 'timeout';
    const t = await src.get(0);
    expect(t.ok).toBe(false);
    expect(t.sessions).toHaveLength(1);
    mode = 'noserver';
    expect(await src.get(0)).toMatchObject({ ok: true, sessions: [] });
  });

  it('tag cache: re-checks young sessions, caches older ones, invalidates by name', async () => {
    let t = 2_000_000_000;
    let tagged = false;
    const { run, calls } = fakeRunner(() => ({
      stdout: tagged ? 'COMPANION_APP=1\n' : '-COMPANION_APP\n',
    }));
    const src = new TmuxSnapshotSource({ run, now: () => t });
    const young = { name: 'y', sessionId: '$1', created: String(Math.floor(t / 1000) - 5) };
    const old = { name: 'o', sessionId: '$2', created: String(Math.floor(t / 1000) - 3600) };
    expect(await src.isTagged(young)).toBe(false);
    tagged = true;
    expect(await src.isTagged(young)).toBe(true); // young: never cached
    tagged = false;
    expect(await src.isTagged(old)).toBe(false);
    tagged = true;
    expect(await src.isTagged(old)).toBe(false); // cached (30 s for untagged)
    src.invalidateTag('o');
    expect(await src.isTagged(old)).toBe(true);
    const n = calls.length;
    expect(await src.isTagged(old)).toBe(true);
    expect(calls.length).toBe(n); // tagged cached
    t += 61_000;
    await src.isTagged(old);
    expect(calls.length).toBe(n + 1);
  });
});
