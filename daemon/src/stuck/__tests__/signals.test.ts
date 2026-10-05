import { analyze, buildDigest, PaneTrack, StuckDigest } from '../signals';
import { STUCK_DEFAULTS, StuckSettings } from '../protocol';
import { readPane } from '../normalize';
import { Transcript, MIN, jestFail, jestPass, tscFail } from './fixtures';

const S: StuckSettings = { ...STUCK_DEFAULTS };
const HORIZON = 60 * MIN;

function digest(t: Transcript, now = t.t): StuckDigest {
  return buildDigest(t.messages(), now, HORIZON);
}

function run(t: Transcript, now = t.t, pane: PaneTrack | null = null, s: StuckSettings = S) {
  return analyze(digest(t, now), now, s, pane);
}

const ALIVE_PANE = [
  '⏺ Bash(curl -s http://localhost:9/slow)',
  '  ⎿  Running…',
  '',
  '✻ Simmering… (24m 3s · ↓ 1.2k tokens · esc to interrupt)',
  '',
  '────────────────────────────────',
  '❯ ',
  '────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

function pane(
  text: string,
  opts: { stableSince: number; checks: number; checkedAt: number; pendingId: string | null }
): PaneTrack {
  return {
    reading: readPane(text),
    stableSince: opts.stableSince,
    stableChecks: opts.checks,
    checkedAt: opts.checkedAt,
    pendingId: opts.pendingId,
  };
}

describe('repeated failure', () => {
  it('flags the same failing test recurring across edit/run cycles (exit 0 through | tail)', () => {
    const t = new Transcript().prompt('fix the retry test');
    for (let i = 0; i < 6; i++) {
      t.text('Let me adjust the backoff.').edit(
        '/home/u/proj/src/api.ts',
        `delay = ${i}`,
        `delay = ${i + 1}`
      );
      t.bash('cd /home/u/proj && npm test 2>&1 | tail -40', jestFail(i)).wait(150);
    }
    const out = run(t);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('repeated_failure');
    expect(out[0].summary).toMatch(/^Same test failing 6 times in \d+ min: retries › backs off$/);
    expect(out[0].headline).toBe('same test failing 6 times');
    expect(out[0].count).toBe(6);
    expect(out[0].evidence[0]).toMatch(/^\$ cd \/home\/u\/proj && npm test/);
  });

  it('flags the same compiler error with moving line numbers', () => {
    const t = new Transcript().prompt('make it build');
    for (let i = 0; i < 5; i++) {
      t.edit('/p/src/api.ts', `x${i}`, `x${i + 1}`)
        .bash('npx tsc --noEmit', tscFail(10 + i), { isError: true })
        .wait(120);
    }
    const out = run(t);
    expect(out.map((f) => f.kind)).toEqual(['repeated_failure']);
    expect(out[0].summary).toMatch(
      /^Same error 5 times in \d+ min: TS2345 in api\.ts: Argument of type/
    );
  });

  it('flags the same tool error (Edit string not found) recurring', () => {
    const t = new Transcript().prompt('rename it');
    for (let i = 0; i < 5; i++)
      t.read('/p/a.ts').edit('/p/a.ts', 'oldName()', 'newName()', { isError: true }).wait(60);
    const out = run(t);
    expect(out[0].kind).toBe('repeated_failure');
    expect(out[0].summary).toMatch(
      /^Edit failing the same way 5 times in \d+ min: a\.ts: String to replace not found/
    );
  });

  it('negative: TDD red -> green (3 failures, then a pass)', () => {
    const t = new Transcript().prompt('add retries, TDD');
    for (let i = 0; i < 3; i++)
      t.edit('/p/a.ts', `a${i}`, `a${i + 1}`)
        .bash('npm test', jestFail(i), { isError: true })
        .wait(120);
    t.edit('/p/a.ts', 'a3', 'a4').bash('npm test', jestPass());
    expect(run(t)).toEqual([]);
  });

  it('negative: five failures, then the same command passes', () => {
    const t = new Transcript().prompt('fix');
    for (let i = 0; i < 5; i++) t.bash('npm test 2>&1 | tail -20', jestFail(i)).wait(120);
    t.bash('npm test 2>&1 | tail -60', jestPass());
    expect(run(t)).toEqual([]);
  });

  it('negative: a burst within a minute is not a pattern', () => {
    const t = new Transcript().prompt('fix');
    for (let i = 0; i < 6; i++) t.bash('npm test', jestFail(i), { isError: true }).wait(1);
    expect(run(t)).toEqual([]);
  });

  it('negative: failures before the latest prompt do not count', () => {
    const t = new Transcript().prompt('fix');
    for (let i = 0; i < 6; i++) t.bash('npm test', jestFail(i), { isError: true }).wait(120);
    t.prompt('ok, try a different approach');
    t.bash('npm test', jestFail(9), { isError: true });
    expect(run(t)).toEqual([]);
  });

  it('negative: the session finished its turn (idle)', () => {
    const t = new Transcript().prompt('fix');
    for (let i = 0; i < 6; i++) t.bash('npm test', jestFail(i), { isError: true }).wait(120);
    t.text('I could not fix the retry test; here is what I found.');
    expect(digest(t).phase).toBe('idle');
    expect(run(t)).toEqual([]);
  });

  it('negative: stopped recurring a while ago', () => {
    const t = new Transcript().prompt('fix');
    for (let i = 0; i < 6; i++) t.bash('npm test', jestFail(i), { isError: true }).wait(120);
    t.read('/p/a.ts');
    expect(run(t, t.t + 20 * MIN)).toEqual([]);
  });

  it('a user rejection is not a failure', () => {
    const t = new Transcript().prompt('deploy');
    for (let i = 0; i < 6; i++)
      t.use('Bash', { command: 'bin/deploy' })
        .result("The user doesn't want to proceed with this tool use. The tool use was rejected.", {
          isError: true,
        })
        .wait(120);
    expect(run(t)).toEqual([]);
  });
});

describe('loop', () => {
  it('flags re-reading the same file with nothing changing', () => {
    const t = new Transcript().prompt('find the bug');
    for (let i = 0; i < 6; i++) t.read('/p/src/watcher.ts').wait(30);
    const out = run(t);
    expect(out.map((f) => f.kind)).toEqual(['loop']);
    expect(out[0].summary).toMatch(
      /^Read the same file 6 times in \d+ min with no edits: watcher\.ts$/
    );
  });

  it('flags the same command with the same result', () => {
    const t = new Transcript().prompt('why is it failing');
    for (let i = 0; i < 5; i++)
      t.bash('git diff --stat', ' src/a.ts | 2 +-\n 1 file changed').wait(40);
    const out = run(t);
    expect(out[0].kind).toBe('loop');
    expect(out[0].summary).toMatch(
      /^Ran the same command 5 times in \d+ min with the same result: git diff --stat$/
    );
  });

  it('negative: repeated reads during a refactor (edits in between)', () => {
    const t = new Transcript().prompt('refactor');
    for (let i = 0; i < 8; i++)
      t.read('/p/src/watcher.ts').edit('/p/src/watcher.ts', `f${i}`, `g${i}`);
    expect(run(t)).toEqual([]);
  });

  it('negative: paging through a file (different ranges)', () => {
    const t = new Transcript().prompt('read it');
    for (let i = 0; i < 8; i++) t.read('/p/big.ts', 'same text', { offset: 1 + i * 200 });
    expect(run(t)).toEqual([]);
  });

  it('negative: polling CI on purpose', () => {
    const t = new Transcript().prompt('wait for CI');
    for (let i = 0; i < 8; i++)
      t.bash('sleep 60 && gh run view 123 --json status', '{"status":"in_progress"}').wait(60);
    expect(run(t)).toEqual([]);
  });
});

describe('oscillation', () => {
  it('flags an edit and its undo, back and forth', () => {
    const t = new Transcript().prompt('fix the race');
    const A = 'await lock.acquire();';
    const B = 'lock.acquire();';
    t.edit('/p/src/queue.ts', A, B)
      .bash('npm test', 'ok')
      .edit('/p/src/queue.ts', B, A)
      .bash('npm test', 'ok2');
    t.edit('/p/src/queue.ts', A, B).bash('npm test', 'ok3').edit('/p/src/queue.ts', B, A);
    const out = run(t);
    expect(out.map((f) => f.kind)).toEqual(['oscillation']);
    expect(out[0].summary).toMatch(
      /^Flip-flopping the same change in queue\.ts: 4 edits back and forth in \d+ min$/
    );
  });

  it('flags Write flipping between two contents', () => {
    const t = new Transcript().prompt('config');
    for (let i = 0; i < 5; i++) t.write('/p/cfg.json', i % 2 ? '{"a":1}' : '{"a":2}').wait(30);
    expect(run(t).map((f) => f.kind)).toEqual(['oscillation']);
  });

  it('negative: an Edit/Write sequence that converges', () => {
    const t = new Transcript().prompt('polish');
    const states = ['v0', 'v1', 'v2', 'v3', 'v4', 'v5'];
    for (let i = 0; i < states.length - 1; i++) t.edit('/p/a.ts', states[i], states[i + 1]);
    t.write('/p/b.ts', 'one').write('/p/b.ts', 'two').write('/p/b.ts', 'three');
    expect(run(t)).toEqual([]);
  });

  it('negative: one revert, then moving on', () => {
    const t = new Transcript().prompt('try');
    t.edit('/p/a.ts', 'A', 'B').edit('/p/a.ts', 'B', 'A').edit('/p/a.ts', 'A', 'C');
    expect(run(t)).toEqual([]);
  });
});

describe('no progress', () => {
  it('flags a long silence while working (Claude alive on screen)', () => {
    const t = new Transcript().prompt('investigate');
    t.text('Looking.').read('/p/a.ts');
    const now = t.t + 34 * MIN;
    const p = pane(ALIVE_PANE.replace('Bash(curl -s http://localhost:9/slow)', 'Read(a.ts)'), {
      stableSince: now - 3 * MIN,
      checks: 2,
      checkedAt: now,
      pendingId: null,
    });
    const out = run(t, now, p);
    expect(out.map((f) => f.kind)).toEqual(['no_progress']);
    expect(out[0].summary).toMatch(/^No edits or new text for 3[45] min$/);
  });

  it('negative: no pane reading yet (alive unknown)', () => {
    const t = new Transcript().prompt('investigate');
    t.text('Looking.').read('/p/a.ts');
    expect(run(t, t.t + 40 * MIN, null)).toEqual([]);
  });

  it('negative: Claude is not on screen (exited / crashed)', () => {
    const t = new Transcript().prompt('investigate');
    t.text('Looking.').read('/p/a.ts');
    const now = t.t + 40 * MIN;
    const p = pane('user@host:~/proj$ ', {
      stableSince: now - 10 * MIN,
      checks: 3,
      checkedAt: now,
      pendingId: null,
    });
    expect(run(t, now, p)).toEqual([]);
  });

  it('negative: a long legit build/test run', () => {
    const t = new Transcript().prompt('run the full suite');
    t.text('Running the full e2e suite; this takes a while.').use('Bash', {
      command: 'npm run test:e2e 2>&1 | tail -50',
    });
    const id = t.lastId;
    const now = t.t + 60 * MIN;
    const stable = pane(ALIVE_PANE, {
      stableSince: now - 30 * MIN,
      checks: 10,
      checkedAt: now,
      pendingId: id,
    });
    expect(run(t, now, stable)).toEqual([]);
  });

  it('negative: a pending Bash whose screen keeps changing', () => {
    const t = new Transcript().prompt('migrate');
    t.text('Running the migration.').use('Bash', { command: 'node scripts/migrate.js' });
    const id = t.lastId;
    const now = t.t + 15 * MIN;
    const p = pane(ALIVE_PANE, {
      stableSince: now - 1 * MIN,
      checks: 1,
      checkedAt: now,
      pendingId: id,
    });
    expect(run(t, now, p, { ...S, noProgressMin: 10 })).toEqual([]);
  });

  it('negative: a subagent is working (up to the long cap)', () => {
    const t = new Transcript().prompt('big job');
    t.text('Dispatching.').use('Task', {
      description: 'audit',
      prompt: 'audit everything',
      subagent_type: 'general-purpose',
    });
    const now = t.t + 60 * MIN;
    const p = pane(ALIVE_PANE, {
      stableSince: now - 30 * MIN,
      checks: 10,
      checkedAt: now,
      pendingId: t.lastId,
    });
    expect(run(t, now, p)).toEqual([]);
  });
});

describe('stalled tool', () => {
  it('flags a Bash call pending long with an unchanged screen', () => {
    const t = new Transcript().prompt('check the service');
    t.text('Querying it.').use('Bash', { command: 'curl -s http://localhost:9/slow' });
    const id = t.lastId;
    const now = t.t + 25 * MIN;
    const p = pane(ALIVE_PANE, {
      stableSince: now - 6 * MIN,
      checks: 3,
      checkedAt: now,
      pendingId: id,
    });
    const out = run(t, now, p);
    expect(out.map((f) => f.kind)).toEqual(['stalled_tool']);
    expect(out[0].summary).toBe(
      'Bash has been running 25 min with no screen change: curl -s http://localhost:9/slow'
    );
    expect(out[0].severity).toBe('high');
  });

  it('negative: an approval prompt on screen is blocked, not stuck', () => {
    const t = new Transcript().prompt('check');
    t.text('Querying it.').use('Bash', { command: 'curl -s http://localhost:9/slow' });
    const id = t.lastId;
    const now = t.t + 25 * MIN;
    const box = [
      '╭──────────────────────────────╮',
      '│ Bash command                 │',
      '│   curl -s http://localhost:9 │',
      '│ Do you want to proceed?      │',
      '│ ❯ 1. Yes                     │',
      "│   2. Yes, and don't ask again │",
      '│   3. No, and tell Claude     │',
      '╰──────────────────────────────╯',
    ].join('\n');
    const p = pane(box, { stableSince: now - 20 * MIN, checks: 5, checkedAt: now, pendingId: id });
    expect(p.reading.prompt).toBe(true);
    expect(run(t, now, p)).toEqual([]);
  });

  it('negative: only one capture so far', () => {
    const t = new Transcript().prompt('check');
    t.use('Bash', { command: 'curl -s http://localhost:9/slow' });
    const now = t.t + 25 * MIN;
    const p = pane(ALIVE_PANE, {
      stableSince: now,
      checks: 1,
      checkedAt: now,
      pendingId: t.lastId,
    });
    expect(run(t, now, p).map((f) => f.kind)).not.toContain('stalled_tool');
  });
});

describe('digest', () => {
  it('reads phases', () => {
    const t = new Transcript().prompt('go');
    expect(digest(t).phase).toBe('working');
    t.use('AskUserQuestion', {
      questions: [
        {
          question: 'Which?',
          header: 'Pick',
          options: [
            { label: 'a', description: '' },
            { label: 'b', description: '' },
          ],
          multiSelect: false,
        },
      ],
    });
    expect(digest(t).phase).toBe('waiting');
    const t2 = new Transcript().prompt('go').bash('ls', 'a').interrupted();
    expect(digest(t2).phase).toBe('idle');
  });

  it('marks is_error tool results with status error (parser)', () => {
    const t = new Transcript().prompt('go').bash('false', 'Exit code 1', { isError: true });
    const msgs = t.messages();
    const tc = msgs.flatMap((m) => m.toolCalls || [])[0];
    expect(tc.isError).toBe(true);
    expect(tc.status).toBe('error');
  });
});
