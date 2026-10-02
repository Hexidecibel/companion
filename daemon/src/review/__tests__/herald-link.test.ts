import * as fs from 'fs';
import * as path from 'path';
import { ReviewService, alertHeadline, ReviewHeraldLink } from '../service';
import { ReviewStore } from '../store';
import { GitRunner } from '../git-runner';
import { prompt, toolUse, toolResult, editResult, writeCreate, assistantText, jsonl, tmpDir, fakeWatcher } from './helpers';

describe('alertHeadline', () => {
  it.each([
    [[{ path: '.github/workflows/deploy.yml', kind: 'ci', reason: 'CI workflow' }], 'Out4 changed a CI workflow: deploy.yml'],
    [[{ path: 'bin/deploy', kind: 'ci', reason: 'deploy script' }], 'Out4 changed the deploy script: deploy'],
    [[{ path: 'src/x.ts', kind: 'secrets', reason: 'adds what looks like a secret' }], 'Out4 added what looks like a secret to x.ts'],
    [
      [
        { path: 'src/old.ts', kind: 'deleted', reason: 'deletes the file (140 lines)' },
        { path: 'migrations/003_users.sql', kind: 'deleted', reason: 'deletes the file (200 lines)' },
        { path: 'migrations/003_users.sql', kind: 'migration', reason: 'database migration' },
      ],
      'Out4 deleted 2 files including migrations/003_users.sql',
    ],
    [
      [
        { path: 'a.ts', kind: 'deleted', reason: 'x' },
        { path: 'b.ts', kind: 'deleted', reason: 'x' },
      ],
      'Out4 deleted 2 files including a.ts',
    ],
  ])('%j', (items, expected) => {
    expect(alertHeadline('Out4', items as never)).toBe(expected);
  });
});

function mk() {
  const conv = path.join(tmpDir(), 'c.jsonl');
  const now = Date.now();
  fs.writeFileSync(conv, jsonl([prompt('t1', 'set up ci', now - 5000), assistantText('Starting.', now - 4900)]));
  const alerts: any[] = [];
  const resolved: string[] = [];
  const polishCalls: any[] = [];
  const herald: ReviewHeraldLink = {
    featureEnabled: true,
    relayAsk: async () => ({ askId: 'x' }),
    addReviewAlert: (a) => alerts.push(a),
    resolveReviewAlerts: (id) => resolved.push(id),
    polishGists: async (items) => {
      polishCalls.push(items);
      return new Map(items.map((i) => [i.id, 'Set up the CI pipeline']));
    },
  };
  const svc = new ReviewService({
    watcher: fakeWatcher([{ id: 'out4', projectPath: '/proj', files: [conv] }]),
    gitEnabled: () => false,
    runner: new GitRunner({ enabled: () => false }),
    store: new ReviewStore(tmpDir(), 5),
    sessionName: () => 'Out4',
    alertWindowMs: 20,
    debounceMs: 0,
    throttleMs: 0,
  });
  svc.setHerald(herald);
  return { svc, conv, alerts, resolved, polishCalls, now };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('risk alerts', () => {
  it('coalesces high-risk edits into one alert, dedupes, resolves on mark', async () => {
    const { svc, conv, alerts, resolved, now } = mk();
    await svc.refresh('out4'); // initial build: old edits never alert
    fs.appendFileSync(
      conv,
      jsonl([
        toolUse('w1', 'Write', { file_path: '/proj/.github/workflows/deploy.yml' }, now - 3000),
        toolResult('w1', writeCreate('/proj/.github/workflows/deploy.yml', 'on: push\n'), now - 2900),
        toolUse('e2', 'Edit', { file_path: '/proj/src/plain.ts' }, now - 2800),
        toolResult('e2', editResult('/proj/src/plain.ts', [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }]), now - 2700),
      ])
    );
    await svc.refresh('out4');
    fs.appendFileSync(
      conv,
      jsonl([
        toolUse('w2', 'Write', { file_path: '/proj/db/migrations/003_users.sql' }, now - 2000),
        toolResult('w2', writeCreate('/proj/db/migrations/003_users.sql', 'create table x;\n'), now - 1900),
        toolUse('w3', 'Edit', { file_path: '/proj/.github/workflows/deploy.yml' }, now - 1800),
        toolResult('w3', editResult('/proj/.github/workflows/deploy.yml', [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-on: push', '+on: [push]'] }]), now - 1700),
      ])
    );
    await svc.refresh('out4');
    await wait(60);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ sessionId: 'out4', level: 'high', headline: 'Out4 made 2 risky changes including db/migrations/003_users.sql' });
    expect(alerts[0].kinds.sort()).toEqual(['ci', 'migration']);
    await svc.markReviewed('out4', Date.now());
    expect(resolved).toEqual(['out4']);
  });
});

describe('polish + digest', () => {
  it('polishes finished turns once (cached), then reports source llm', async () => {
    const { svc, conv, polishCalls, now } = mk();
    fs.appendFileSync(
      conv,
      jsonl([
        toolUse('e1', 'Edit', { file_path: '/proj/src/a.ts' }, now - 3000),
        toolResult('e1', editResult('/proj/src/a.ts', [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }]), now - 2900),
        assistantText('Done.', now - 2800),
      ])
    );
    const r1 = await svc.polish('out4', ['t1']);
    expect(r1.turns).toEqual([{ id: 't1', gist: 'Set up the CI pipeline', summary: 'Set up the CI pipeline: 1 file, +1 -1' }]);
    await svc.polish('out4', ['t1']);
    expect(polishCalls).toHaveLength(1);
    const g = await svc.get({ sessionId: 'out4', scope: 'all', view: 'turns' });
    expect(g.turns[0].summarySource).toBe('llm');
  });

  it('digest is grounded and capped', async () => {
    const { svc, conv, now } = mk();
    const entries: unknown[] = [];
    for (let i = 0; i < 15; i++) {
      const f = `/proj/src/f${i}.ts`;
      entries.push(toolUse(`e${i}`, 'Edit', { file_path: f }, now - 3000 + i), toolResult(`e${i}`, editResult(f, [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }]), now - 2900 + i));
    }
    entries.push(toolUse('ci', 'Write', { file_path: '/proj/.github/workflows/ci.yml' }, now - 2000), toolResult('ci', writeCreate('/proj/.github/workflows/ci.yml', 'x\n'), now - 1990));
    entries.push(assistantText('I added CI and touched 15 files.', now - 1000));
    fs.appendFileSync(conv, jsonl(entries));
    const d: any = await svc.digest('out4', 'since_last_look');
    expect(d.session).toBe('Out4');
    expect(d.unreviewed).toEqual({ files: 16, turns: 1, additions: 16, deletions: 15 });
    expect(d.turns).toEqual([{ n: 1, summary: 'Added CI and touched 15 files: 16 files, +16 -15', ago: expect.stringMatching(/ago$/), risk: 'high' }]);
    expect(d.files).toHaveLength(12);
    expect(d.files[0]).toMatchObject({ path: '.github/workflows/ci.yml', risks: ['CI workflow'] });
    expect(d.note).toBe('4 more changed files are not listed.');
    expect(d.last_looked_ago).toBe('never');
  });
});
