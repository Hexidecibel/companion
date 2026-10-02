/**
 * "I keep marking as reviewed but they just show on all of my sessions":
 * after a mark, a session's summary drops to 0 until NEW edits land, other
 * sessions sharing the repo are unaffected, and unattributed / foreign repo
 * changes neither count as the session's own nor survive a mark.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ReviewService } from '../service';
import { ReviewStore } from '../store';
import { GitRunner } from '../git-runner';
import { prompt, toolUse, toolResult, editResult, jsonl, tmpDir, initRepo, commitAll, fakeWatcher } from './helpers';

const T0 = Date.now() - 60 * 60 * 1000;
const oneLine = (from: string, to: string) => [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`-${from}`, `+${to}`] }];

function edit(id: string, abs: string, at: number, from: string, to: string): unknown[] {
  return [toolUse(id, 'Edit', { file_path: abs }, at), toolResult(id, editResult(abs, oneLine(from, to)), at + 1)];
}

function setup() {
  const repo = initRepo();
  for (const f of ['a.ts', 'b.ts', 'c.ts']) fs.writeFileSync(path.join(repo, f), `${f}\n`);
  commitAll(repo);
  const dir = tmpDir();
  const conv1 = path.join(dir, 's1.jsonl');
  const conv2 = path.join(dir, 's2.jsonl');
  // s1 edits a.ts, s2 (same repo) edits b.ts, a shell command changes c.ts.
  fs.writeFileSync(path.join(repo, 'a.ts'), 'A\n');
  fs.writeFileSync(conv1, jsonl([prompt('t1', 'edit a', T0), ...edit('e1', path.join(repo, 'a.ts'), T0 + 1000, 'a.ts', 'A')]));
  fs.writeFileSync(path.join(repo, 'b.ts'), 'B\n');
  fs.writeFileSync(conv2, jsonl([prompt('u1', 'edit b', T0), ...edit('f1', path.join(repo, 'b.ts'), T0 + 1500, 'b.ts', 'B')]));
  fs.writeFileSync(path.join(repo, 'c.ts'), 'C from a shell\n');
  const svc = new ReviewService({
    watcher: fakeWatcher([
      { id: 's1', projectPath: repo, files: [conv1] },
      { id: 's2', projectPath: repo, files: [conv2] },
    ]),
    gitEnabled: () => true,
    excludeDirs: [],
    runner: new GitRunner(),
    store: new ReviewStore(tmpDir(), 5),
    throttleMs: 0,
    debounceMs: 0,
  });
  return { repo, conv1, conv2, svc };
}

describe('mark reviewed sticks', () => {
  it('unattributed changes are reported separately; foreign sessions are never unattributed', async () => {
    const { svc } = setup();
    await svc.summaryList(); // both ledgers known
    const r = await svc.get({ sessionId: 's1', scope: 'since_checkpoint', view: 'files' });
    expect(r.files.map((f) => f.path)).toEqual(['a.ts']);
    // b.ts belongs to s2: not this session's pile.
    expect(r.unattributed.map((f) => f.path)).toEqual(['c.ts']);
    const s1 = (await svc.summary('s1'))!;
    expect(s1).toMatchObject({ unreviewedFiles: 1, unattributedFiles: 1 });
    expect(typeof s1.computedAt).toBe('number');
  });

  it('after a mark the summary is 0 until new edits; the other session is unaffected', async () => {
    const { repo, conv1, svc } = setup();
    await svc.summaryList();
    await svc.get({ sessionId: 's1', scope: 'since_checkpoint', view: 'files' });
    const before = (await svc.summary('s1'))!;
    const m = await svc.markReviewed('s1', before.computedAt!, 'Desk');
    expect(m.summary).toMatchObject({ unreviewedFiles: 0, unreviewedTurns: 0 });
    expect(m.summary.unattributedFiles).toBeUndefined();
    // A rescan (turn end / drawer open) finds nothing new.
    const again = await svc.get({ sessionId: 's1', scope: 'since_checkpoint', view: 'files' });
    expect(again.files).toEqual([]);
    expect(again.unattributed).toEqual([]);
    expect((await svc.summary('s1'))!).toMatchObject({ unreviewedFiles: 0 });
    expect((await svc.summary('s1'))!.unattributedFiles).toBeUndefined();
    // s2 still has its own unreviewed edit and no checkpoint.
    expect((await svc.summary('s2'))!).toMatchObject({ unreviewedFiles: 1, reviewedThrough: 0 });

    // New work after the mark shows up again.
    const t = Date.now();
    fs.writeFileSync(path.join(repo, 'a.ts'), 'AA\n');
    fs.appendFileSync(conv1, jsonl([prompt('t2', 'more', t), ...edit('e2', path.join(repo, 'a.ts'), t + 1, 'A', 'AA')]));
    expect((await svc.summary('s1'))!).toMatchObject({ unreviewedFiles: 1, unreviewedTurns: 1 });
  });

  it('only unattributed left: a mark at lastChangeAt (older clients) still clears them', async () => {
    const { repo, svc } = setup();
    await svc.summaryList();
    const first = await svc.markReviewed('s1', Date.now(), 'Desk');
    expect(first.summary.unreviewedFiles).toBe(0);
    // A shell command changes another file after the mark.
    fs.writeFileSync(path.join(repo, 'c.ts'), 'C again\n');
    await svc.get({ sessionId: 's1', scope: 'since_checkpoint', view: 'files' });
    const s = (await svc.summary('s1'))!;
    expect(s).toMatchObject({ unreviewedFiles: 0, unattributedFiles: 1 });
    // lastChangeAt is older than reviewedThrough: the time cannot move, but the
    // device showed everything the transcript claims, so the base is re-taken.
    expect(s.lastChangeAt!).toBeLessThan(s.reviewedThrough);
    const m = await svc.markReviewed('s1', s.lastChangeAt!, 'Phone');
    expect(m.summary.unattributedFiles).toBeUndefined();
    const r = await svc.get({ sessionId: 's1', scope: 'since_checkpoint', view: 'files' });
    expect(r.unattributed).toEqual([]);
  });

  it('a stale mark (older than unseen edits) does not swallow them', async () => {
    const { svc } = setup();
    await svc.summaryList();
    await svc.get({ sessionId: 's1', scope: 'since_checkpoint', view: 'files' });
    const m = await svc.markReviewed('s1', T0, 'Phone');
    expect(m.summary).toMatchObject({ unreviewedFiles: 1, unreviewedTurns: 1 });
  });
});
