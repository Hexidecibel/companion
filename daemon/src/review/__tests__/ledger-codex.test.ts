import * as fs from 'fs';
import * as path from 'path';
import { SessionLedger } from '../ledger';
import { tmpDir } from './helpers';
import {
  parsePatchEnvelope,
  parseUnifiedHunks,
  fileChangeEdits,
  codexEdits,
} from '../../agents/codex/edits';

const FIXTURE = path.join(
  __dirname,
  '..',
  '..',
  'agents',
  '__tests__',
  'fixtures',
  'codex',
  'parity-edits.jsonl'
);
const ROLLOUT = 'rollout-2026-10-28T20-02-40-01a1859c-1206-7690-b142-5335c20e0f1d.jsonl';

function copyAsRollout(content: string): string {
  const dir = tmpDir('ledger-codex-');
  const f = path.join(dir, ROLLOUT);
  fs.writeFileSync(f, content);
  return f;
}

async function load(file: string): Promise<SessionLedger> {
  const led = new SessionLedger('cdx', '/work/repo');
  led.setChain([file], []);
  await led.update();
  return led;
}

describe('Codex apply_patch helpers', () => {
  it('parses the envelope (add / update / delete / move)', () => {
    const ops = parsePatchEnvelope(
      '*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+y\n*** Add File: b.txt\n+n\n*** Delete File: c.txt\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n-o\n+p\n*** End Patch'
    );
    expect(ops).toEqual([
      { file: 'a.txt', op: 'update' },
      { file: 'b.txt', op: 'add' },
      { file: 'c.txt', op: 'delete' },
      { file: 'old.txt', op: 'update', moveTo: 'new.txt' },
    ]);
  });

  it('parses unified hunks with default counts', () => {
    expect(parseUnifiedHunks('@@ -1 +1 @@\n-a\n+b\n')).toEqual([
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] },
    ]);
    expect(parseUnifiedHunks('nothing')).toBeNull();
  });

  it('FileChange item -> edits (move lands on the destination)', () => {
    const edits = fileChangeEdits({
      changes: {
        '/r/a': { type: 'update', unified_diff: '@@ -2,1 +2,1 @@\n-x\n+y\n', move_path: '/r/b' },
        '/r/c': { type: 'delete', content: 'z\n' },
      },
    });
    expect(edits[0]).toMatchObject({ file: '/r/b', movedFrom: '/r/a', kind: 'update' });
    expect(edits[1].hunks![0].lines).toEqual(['-z']);
  });

  it('generic extractor returns the first file', () => {
    expect(
      codexEdits.editStart('apply_patch', { patch: '*** Begin Patch\n*** Add File: x\n+1\n' })
    ).toEqual({ file: 'x', kind: 'create' });
    expect(codexEdits.editStart('exec_command', { command: 'ls' })).toBeNull();
  });
});

describe('SessionLedger on a real Codex rollout (sanitized)', () => {
  let led: SessionLedger;
  beforeAll(async () => {
    led = await load(copyAsRollout(fs.readFileSync(FIXTURE, 'utf8')));
  });

  it('opens one turn for the typed prompt (harness context skipped)', () => {
    expect(led.turns).toHaveLength(1);
    expect(led.turns[0].prompt).toMatch(/^Do exactly these steps/);
    expect(led.turns[0].lastAssistantText).toBe('done');
  });

  it('marks the turn usedBash (sed -i ran in the same exec)', () => {
    expect(led.turns[0].usedBash).toBe(true);
  });

  it('turns the FileChange into exact edits', () => {
    const edits = Array.from(led.edits.values());
    const by = (p: string) => edits.filter((e) => e.absPath === p);
    const a = by('/work/repo/a.txt')[0];
    expect(a.pending).toBeFalsy();
    expect(a.tool).toBe('apply_patch');
    expect(a.kind).toBe('update');
    expect(a.hunks.map((h) => h.oldStart)).toEqual([2, 7]);
    expect(a.additions).toBe(2);
    expect(a.deletions).toBe(2);
    const b = by('/work/repo/b.txt')[0];
    expect(b.kind).toBe('create');
    expect(b.hunks[0].lines).toEqual(['+new file']);
    const gone = by('/work/repo/gone.txt')[0];
    expect(gone.deletions).toBe(1);
    const renamed = by('/work/repo/renamed.txt')[0];
    expect(renamed.hunks[0].lines).toEqual(['-old name', '+new name']);
    const old = by('/work/repo/old.txt')[0];
    expect(old.patchUnavailable).toBe(true);
    expect(edits.every((e) => !e.pending && !e.failed)).toBe(true);
    expect(edits.every((e) => e.turnId === led.turns[0].id)).toBe(true);
    expect(edits).toHaveLength(5);
  });

  it('pending edits from the envelope fail when no FileChange came', async () => {
    const lines = fs
      .readFileSync(FIXTURE, 'utf8')
      .split('\n')
      .filter((l) => l && !l.includes('"FileChange"'));
    const l2 = await load(copyAsRollout(lines.join('\n') + '\n'));
    const edits = Array.from(l2.edits.values());
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.every((e) => e.failed)).toBe(true);
  });

  it('streams: envelope first = pending, FileChange later = completed', async () => {
    const all = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);
    const cut = all.findIndex((l) => l.includes('"FileChange"'));
    const f = copyAsRollout(all.slice(0, cut).join('\n') + '\n');
    const l3 = new SessionLedger('cdx', '/work/repo');
    l3.setChain([f], []);
    await l3.update();
    const pend = Array.from(l3.edits.values());
    expect(pend.length).toBe(5);
    expect(pend.every((e) => e.pending)).toBe(true);
    fs.appendFileSync(f, all.slice(cut).join('\n') + '\n');
    await l3.update();
    expect(Array.from(l3.edits.values()).every((e) => !e.pending && !e.failed)).toBe(true);
    expect(l3.edits.size).toBe(5);
  });
});

describe('ReviewService on a Codex session (temp git repo)', () => {
  // Late imports keep the pure tests above light.
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { ReviewService } = require('../service') as typeof import('../service');
  const { ReviewStore } = require('../store') as typeof import('../store');
  const { GitRunner } = require('../git-runner') as typeof import('../git-runner');
  const { initRepo, commitAll, fakeWatcher } = require('./helpers') as typeof import('./helpers');

  it('apply_patch edits are attributed; the sed -i change is unattributed; mark reviewed clears them', async () => {
    const repo = initRepo();
    const w = (f: string, c: string) => fs.writeFileSync(path.join(repo, f), c);
    w('a.txt', 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\n');
    w('old.txt', 'old name\n');
    w('gone.txt', 'remove me\n');
    w('s.txt', 'one\ntwo\n');
    commitAll(repo);
    // What Codex did (same as the recorded run).
    w('a.txt', 'alpha\nbeta\nGAMMA\ndelta\nepsilon\nzeta\neta\nTHETA\n');
    w('b.txt', 'new file\n');
    fs.unlinkSync(path.join(repo, 'gone.txt'));
    fs.unlinkSync(path.join(repo, 'old.txt'));
    w('renamed.txt', 'new name\n');
    w('s.txt', 'one\nTWO\n');
    const rollout = copyAsRollout(fs.readFileSync(FIXTURE, 'utf8').split('/work/repo').join(repo));
    const svc = new ReviewService({
      watcher: fakeWatcher([{ id: 'cdx', projectPath: repo, files: [rollout] }]),
      gitEnabled: () => true,
      excludeDirs: [],
      runner: new GitRunner(),
      store: new ReviewStore(tmpDir(), 5),
    });
    const r = await svc.get({ sessionId: 'cdx', scope: 'all', view: 'files' });
    const by = (p: string) => r.files.find((f) => f.path === p);
    expect(by('a.txt')).toMatchObject({ status: 'modified', additions: 2, deletions: 2 });
    expect(by('a.txt')!.turnIds).toHaveLength(1);
    expect(by('b.txt')).toMatchObject({ status: 'added' });
    expect(r.unattributed.map((f) => f.path)).toEqual(['s.txt']);
    const turns = await svc.get({ sessionId: 'cdx', scope: 'all', view: 'turns' });
    expect(turns.edits.find((e) => e.path === 'a.txt')!.tool).toBe('Edit');
    expect(turns.edits.find((e) => e.path === 'b.txt')!.tool).toBe('Write');
    // Mark reviewed -> nothing left since the checkpoint.
    await svc.markReviewed('cdx', Date.now(), 'Desk');
    const after = await svc.get({ sessionId: 'cdx', scope: 'since_checkpoint', view: 'files' });
    expect(after.files).toEqual([]);
    expect(after.unattributed).toEqual([]);
  });
});
