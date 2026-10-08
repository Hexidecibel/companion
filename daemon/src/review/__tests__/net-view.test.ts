import * as fs from 'fs';
import * as path from 'path';
import { ReviewService } from '../service';
import { ReviewStore } from '../store';
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
  git,
  fakeWatcher,
} from './helpers';

const T0 = Date.now() - 60 * 60 * 1000;

function setup() {
  const repo = initRepo();
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(repo, 'old-name.ts'), 'keep\nkeep2\nkeep3\nkeep4\n');
  fs.writeFileSync(path.join(repo, 'run.sh'), 'echo hi\n');
  fs.writeFileSync(path.join(repo, 'doomed.ts'), 'bye\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n');
  commitAll(repo);
  const conv = path.join(tmpDir(), 'c.jsonl');
  const entries: unknown[] = [prompt('t1', 'work', T0)];
  const add = (id: string, tool: string, abs: string, tur: unknown, at: number) => {
    entries.push(toolUse(id, tool, { file_path: abs }, at));
    entries.push(toolResult(id, tur, at + 1));
  };
  // Edit tracked file.
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'one\nTWO\nthree\n');
  add(
    'e1',
    'Edit',
    path.join(repo, 'src', 'a.ts'),
    editResult(path.join(repo, 'src', 'a.ts'), [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [' one', '-two', '+TWO', ' three'],
      },
    ]),
    T0 + 1000
  );
  // Create untracked file.
  fs.writeFileSync(path.join(repo, 'src', 'new.ts'), 'fresh\n');
  add(
    'e2',
    'Write',
    path.join(repo, 'src', 'new.ts'),
    writeCreate(path.join(repo, 'src', 'new.ts'), 'fresh\n'),
    T0 + 2000
  );
  // Gitignored file.
  fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=abc\n');
  add(
    'e3',
    'Write',
    path.join(repo, '.env'),
    writeCreate(path.join(repo, '.env'), 'TOKEN=abc\n'),
    T0 + 3000
  );
  fs.writeFileSync(conv, jsonl(entries));
  // Bash-made changes (unattributed): rename, chmod, delete.
  git(repo, 'mv', 'old-name.ts', 'new-name.ts');
  fs.chmodSync(path.join(repo, 'run.sh'), 0o755);
  fs.unlinkSync(path.join(repo, 'doomed.ts'));
  const runner = new GitRunner();
  const svc = new ReviewService({
    watcher: fakeWatcher([{ id: 's1', projectPath: repo, files: [conv] }]),
    gitEnabled: () => true,
    excludeDirs: [],
    runner,
    store: new ReviewStore(tmpDir(), 5),
  });
  return { repo, conv, svc, runner, entries, add };
}

describe('net files view (temp git repos)', () => {
  it('claims tracked + untracked + gitignored files; Bash changes are unattributed', async () => {
    const { repo, svc } = setup();
    const r = await svc.get({ sessionId: 's1', scope: 'all', view: 'files' });
    const by = (p: string) => r.files.find((f) => f.path === p);
    expect(by('src/a.ts')).toMatchObject({
      source: 'git',
      status: 'modified',
      additions: 1,
      deletions: 1,
      turnIds: ['t1'],
      unreviewed: true,
    });
    expect(by('src/a.ts')!.hunks![0].id).toMatch(/^g/);
    expect(by('src/new.ts')).toMatchObject({ source: 'git', status: 'added', additions: 1 });
    const env = by('.env')!;
    expect(env.source).toBe('transcript');
    expect(env.risks.map((x) => x.kind)).toContain('env');
    const un = new Map(r.unattributed.map((f) => [f.path, f]));
    expect(un.get('new-name.ts')).toMatchObject({
      status: 'renamed',
      oldPath: 'old-name.ts',
      turnIds: [],
    });
    expect(un.get('run.sh')).toMatchObject({ status: 'mode_changed' });
    expect(un.get('run.sh')!.risks.map((x) => x.kind)).toContain('permissions');
    expect(un.get('doomed.ts')).toMatchObject({ status: 'deleted' });
    expect(r.repos[0]).toMatchObject({ root: repo, worktree: false, branch: 'main' });
    // Never touched the user's index.
    expect(git(repo, 'status', '--porcelain')).toContain('R  old-name.ts -> new-name.ts');
    expect(git(repo, 'status', '--porcelain')).toContain('?? src/new.ts');
  });

  it('mark reviewed snapshots the tree; later changes are the only ones since the checkpoint', async () => {
    const { repo, svc, conv } = setup();
    const m = await svc.markReviewed('s1', Date.now(), 'Desk');
    expect(m.checkpoint.snapshots).toHaveLength(1);
    expect(m.checkpoint.snapshots[0].repoRoot).toBe(repo);
    const t = Date.now();
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'one\nTWO\nthree\nfour\n');
    fs.appendFileSync(
      conv,
      jsonl([
        prompt('t2', 'more', t),
        toolUse('e9', 'Edit', { file_path: path.join(repo, 'src', 'a.ts') }, t + 1),
        toolResult(
          'e9',
          editResult(path.join(repo, 'src', 'a.ts'), [
            { oldStart: 3, oldLines: 1, newStart: 3, newLines: 2, lines: [' three', '+four'] },
          ]),
          t + 2
        ),
      ])
    );
    const r = await svc.get({ sessionId: 's1', scope: 'since_checkpoint', view: 'files' });
    expect(r.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(r.files[0]).toMatchObject({ additions: 1, deletions: 0, turnIds: ['t2'] });
    expect(r.unattributed).toEqual([]);
  });

  it('review_get_file returns full hunks; get_edits returns chips + missing', async () => {
    const { repo, svc } = setup();
    const f = await svc.getFile({
      sessionId: 's1',
      absPath: path.join(repo, 'src', 'a.ts'),
      scope: 'all',
    });
    expect(f.file.hunks).toHaveLength(1);
    expect(f.truncated).toBe(false);
    await expect(
      svc.getFile({ sessionId: 's1', absPath: path.join(repo, 'nope.ts'), scope: 'all' })
    ).rejects.toMatchObject({ code: 'not_found' });
    const e = await svc.getEdits('s1', ['e1', 'zzz']);
    expect(e.edits.map((x) => x.id)).toEqual(['e1']);
    expect(e.missing).toEqual(['zzz']);
  });

  it('worktree repo resolves with its own index', async () => {
    const { repo } = setup();
    commitAll(repo, 'all');
    const wt = path.join(tmpDir(), 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'feat', wt);
    const wtReal = fs.realpathSync(wt);
    fs.writeFileSync(path.join(wtReal, 'src', 'a.ts'), 'changed in worktree\n');
    const conv = path.join(tmpDir(), 'w.jsonl');
    const t = Date.now();
    fs.writeFileSync(
      conv,
      jsonl([
        prompt('w1', 'wt', t),
        toolUse('we', 'Edit', { file_path: path.join(wtReal, 'src', 'a.ts') }, t + 1),
        toolResult(
          'we',
          editResult(path.join(wtReal, 'src', 'a.ts'), [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ['-one', '+changed in worktree'],
            },
          ]),
          t + 2
        ),
      ])
    );
    const svc = new ReviewService({
      watcher: fakeWatcher([{ id: 'w', projectPath: wtReal, files: [conv] }]),
      gitEnabled: () => true,
      excludeDirs: [],
      store: new ReviewStore(tmpDir(), 5),
    });
    const r = await svc.get({ sessionId: 'w', scope: 'all', view: 'files' });
    expect(r.repos[0]).toMatchObject({ root: wtReal, worktree: true, branch: 'feat' });
    expect(r.files[0]).toMatchObject({ path: 'src/a.ts', source: 'git' });
    // Main checkout untouched.
    expect(fs.readFileSync(path.join(repo, 'src', 'a.ts'), 'utf8')).toBe('one\nTWO\nthree\n');
  });

  it('non-git project: per-edit transcript files', async () => {
    const dir = fs.realpathSync(tmpDir());
    const conv = path.join(tmpDir(), 'n.jsonl');
    const t = Date.now();
    fs.writeFileSync(
      conv,
      jsonl([
        prompt('n1', 'x', t),
        toolUse('ne', 'Edit', { file_path: path.join(dir, 'a.txt') }, t + 1),
        toolResult(
          'ne',
          editResult(path.join(dir, 'a.txt'), [
            { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] },
          ]),
          t + 2
        ),
      ])
    );
    const svc = new ReviewService({
      watcher: fakeWatcher([{ id: 'n', projectPath: dir, files: [conv] }]),
      gitEnabled: () => true,
      excludeDirs: [],
      store: new ReviewStore(tmpDir(), 5),
    });
    const r = await svc.get({ sessionId: 'n', scope: 'all', view: 'files' });
    expect(r.files[0]).toMatchObject({ path: 'a.txt', source: 'transcript' });
    expect(r.files[0].hunks![0].id).toBe('ne#0');
    expect((await svc.summary('n'))!.mode).toBe('transcript');
  });
});
