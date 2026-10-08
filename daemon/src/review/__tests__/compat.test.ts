import * as fs from 'fs';
import * as path from 'path';
import { ReviewService } from '../service';
import { GitRunner } from '../git-runner';
import {
  prompt,
  toolUse,
  toolResult,
  editResult,
  writeCreate,
  jsonl,
  tmpDir,
  initRepo,
  commitAll,
  fakeWatcher,
} from './helpers';

describe('get_session_diff compat (ledger + one bounded diff)', () => {
  it('includes tracked diffs AND untracked new files, with few git calls', async () => {
    const repo = initRepo();
    fs.mkdirSync(path.join(repo, 'src'));
    for (let i = 0; i < 10; i++)
      fs.writeFileSync(path.join(repo, 'src', `f${i}.ts`), `line ${i}\n`);
    commitAll(repo);
    const t0 = Date.parse('2026-09-30T08:00:00Z');
    const entries: unknown[] = [prompt('t1', 'edit all', t0)];
    for (let i = 0; i < 10; i++) {
      const p = path.join(repo, 'src', `f${i}.ts`);
      fs.writeFileSync(p, `line ${i}\nnew ${i}\n`);
      entries.push(toolUse(`e${i}`, 'Edit', { file_path: p }, t0 + 10 * i + 1));
      entries.push(
        toolResult(
          `e${i}`,
          editResult(p, [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 2,
              lines: [` line ${i}`, `+new ${i}`],
            },
          ]),
          t0 + 10 * i + 2
        )
      );
    }
    const created = path.join(repo, 'src', 'brand-new.ts');
    fs.writeFileSync(created, 'hello\n');
    entries.push(toolUse('w1', 'Write', { file_path: created, content: 'hello\n' }, t0 + 500));
    entries.push(toolResult('w1', writeCreate(created, 'hello\n'), t0 + 501));
    const convDir = tmpDir();
    const conv = path.join(convDir, 'c.jsonl');
    fs.writeFileSync(conv, jsonl(entries));

    const runner = new GitRunner();
    const svc = new ReviewService({
      watcher: fakeWatcher([{ id: 's1', projectPath: repo, files: [conv] }]),
      gitEnabled: () => true,
      excludeDirs: [],
      runner,
    });
    const out = await svc.compatSessionDiff('s1');
    expect(out).toHaveLength(11);
    const paths = out.map((f) => f.path);
    expect(paths).toContain(created);
    const nf = out.find((f) => f.path === created)!;
    expect(nf.action).toBe('write');
    expect(nf.diff).toContain('+hello');
    const f3 = out.find((f) => f.path.endsWith('f3.ts'))!;
    expect(f3.diff).toContain('+new 3');
    // rev-parse + diff + cat-file: not one shell per file.
    expect(runner.spawnCount).toBeLessThanOrEqual(4);
  });

  it('git disabled: transcript-only list, no subprocess', async () => {
    const convDir = tmpDir();
    const conv = path.join(convDir, 'c.jsonl');
    const t0 = Date.now();
    fs.writeFileSync(
      conv,
      jsonl([
        prompt('t1', 'x', t0),
        toolUse('e1', 'Edit', { file_path: '/nowhere/a.ts' }, t0 + 1),
        toolResult('e1', editResult('/nowhere/a.ts', []), t0 + 2),
      ])
    );
    const runner = new GitRunner({ enabled: () => false });
    const svc = new ReviewService({
      watcher: fakeWatcher([{ id: 's1', projectPath: '/nowhere', files: [conv] }]),
      gitEnabled: () => false,
      runner,
    });
    const out = await svc.compatSessionDiff('s1');
    expect(out.map((f) => f.path)).toEqual(['/nowhere/a.ts']);
    expect(runner.spawnCount).toBe(0);
  });

  it('unknown session -> empty', async () => {
    const svc = new ReviewService({ watcher: fakeWatcher([]), gitEnabled: () => true });
    expect(await svc.compatSessionDiff('nope')).toEqual([]);
  });
});
