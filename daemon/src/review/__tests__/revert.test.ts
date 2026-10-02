import * as fs from 'fs';
import * as path from 'path';
import { ReviewService } from '../service';
import { ReviewStore } from '../store';
import { registerReviewHandlers } from '../../handlers/review';
import { prompt, toolUse, toolResult, editResult, writeCreate, jsonl, tmpDir, initRepo, commitAll, git, fakeWatcher } from './helpers';

const T0 = Date.now() - 60 * 60 * 1000;

function setup(opts: { git?: boolean; noRepo?: boolean } = {}) {
  const repo = opts.noRepo ? fs.realpathSync(tmpDir('review-plain-')) : initRepo();
  const a = path.join(repo, 'a.ts');
  fs.writeFileSync(a, 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n');
  if (!opts.noRepo) commitAll(repo);
  // The session edits line 2 and later line 7, and creates new.ts.
  fs.writeFileSync(a, 'l1\nTWO\nl3\nl4\nl5\nl6\nSEVEN\nl8\n');
  const created = path.join(repo, 'new.ts');
  fs.writeFileSync(created, 'fresh\nfile\n');
  const conv = path.join(tmpDir(), 'c.jsonl');
  fs.writeFileSync(
    conv,
    jsonl([
      prompt('t1', 'edit', T0),
      toolUse('e1', 'Edit', { file_path: a }, T0 + 1),
      toolResult('e1', editResult(a, [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [' l1', '-l2', '+TWO', ' l3', ' l4'] }]), T0 + 2),
      toolUse('e2', 'Edit', { file_path: a }, T0 + 3),
      toolResult('e2', editResult(a, [{ oldStart: 6, oldLines: 3, newStart: 6, newLines: 3, lines: [' l6', '-l7', '+SEVEN', ' l8'] }]), T0 + 4),
      toolUse('w1', 'Write', { file_path: created }, T0 + 5),
      toolResult('w1', writeCreate(created, 'fresh\nfile\n'), T0 + 6),
    ])
  );
  const audit: any[] = [];
  const sent: string[] = [];
  const broadcasts: any[] = [];
  const svc = new ReviewService({
    watcher: fakeWatcher([{ id: 's1', projectPath: repo, files: [conv] }]),
    gitEnabled: () => opts.git !== false,
    store: new ReviewStore(tmpDir(), 5),
    excludeDirs: [],
    backupDir: path.join(tmpDir(), 'backups'),
    audit: (e) => audit.push(e),
    sendDirect: async (_id, text) => {
      sent.push(text);
      return true;
    },
    broadcast: (type, payload) => broadcasts.push({ type, payload }),
  });
  return { repo, a, created, conv, svc, audit, sent, broadcasts };
}

describe('revert (temp git repos)', () => {
  it('hunk revert: echo tier, tap applies, backup + audit + broadcast + notify', async () => {
    const { a, svc, audit, sent, broadcasts } = setup();
    const p = await svc.revertPreview({ sessionId: 's1', target: { kind: 'hunk', absPath: a, hunkId: 'e1#0', scope: 'all' } }, 'c1');
    expect(p.blocked).toBeNull();
    expect(p.tier).toBe('echo');
    expect(p.effect).toBe('patch');
    expect(p.patch).toContain('-TWO');
    expect(p.patch).toContain('+l2');
    const r = await svc.revert({ token: p.token!, confirm: 'tap', device: 'Phone' }, 'c1');
    expect(fs.readFileSync(a, 'utf8')).toBe('l1\nl2\nl3\nl4\nl5\nl6\nSEVEN\nl8\n');
    expect(r.effect).toBe('patch');
    expect(r.undoUntil).toBeGreaterThan(Date.now());
    await new Promise((res) => setImmediate(res));
    expect(audit.find((e) => e.action === 'review_revert')).toMatchObject({ result: { ok: true }, payload: { tier: 'echo', confirm: 'tap', device: 'Phone' } });
    expect(broadcasts.find((b) => b.type === 'review_reverted').payload).toMatchObject({ sessionId: 's1', absPath: a, undone: false, by: 'Phone' });
    expect(sent[0]).toBe('[Companion] I reverted a change in a.ts; re-read it before editing.');
    // Undo restores.
    await svc.revertUndo(r.backupId, 'c1');
    expect(fs.readFileSync(a, 'utf8')).toBe('l1\nTWO\nl3\nl4\nl5\nl6\nSEVEN\nl8\n');
    await expect(svc.revertUndo(r.backupId, 'c1')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('hunk revert refused after a later overlapping change', async () => {
    const { a, svc } = setup();
    fs.writeFileSync(a, 'l1\nTWO-again\nl3\nl4\nl5\nl6\nSEVEN\nl8\n');
    const p = await svc.revertPreview({ sessionId: 's1', target: { kind: 'hunk', absPath: a, hunkId: 'e1#0', scope: 'all' } }, 'c1');
    expect(p.token).toBeNull();
    expect(p.blocked).toMatchObject({ code: 'conflict' });
  });

  it('CAS: a change between preview and apply is refused', async () => {
    const { a, svc } = setup();
    const p = await svc.revertPreview({ sessionId: 's1', target: { kind: 'hunk', absPath: a, hunkId: 'e2#0', scope: 'all' } }, 'c1');
    fs.appendFileSync(a, 'appended\n');
    await expect(svc.revert({ token: p.token!, confirm: 'tap' }, 'c1')).rejects.toMatchObject({ code: 'blocked' });
    expect(fs.readFileSync(a, 'utf8')).toContain('appended');
  });

  it('created file -> delete (hard confirm), backup exists, undo restores', async () => {
    const { created, svc } = setup();
    const p = await svc.revertPreview({ sessionId: 's1', target: { kind: 'hunk', absPath: created, hunkId: 'w1#0', scope: 'all' } }, 'c1');
    expect(p.effect).toBe('delete');
    expect(p.tier).toBe('hard_confirm');
    await expect(svc.revert({ token: p.token!, confirm: 'tap' }, 'c1')).rejects.toMatchObject({ code: 'tier_mismatch' });
    const r = await svc.revert({ token: p.token!, confirm: 'hold' }, 'c1');
    expect(fs.existsSync(created)).toBe(false);
    expect(r.effect).toBe('delete');
    await svc.revertUndo(r.backupId, 'c1');
    expect(fs.readFileSync(created, 'utf8')).toBe('fresh\nfile\n');
  });

  it('file -> head: restore, hard_confirm; staged changes refused', async () => {
    const { repo, a, svc } = setup();
    const p = await svc.revertPreview({ sessionId: 's1', target: { kind: 'file', absPath: a, to: 'head' } }, 'c1');
    expect(p).toMatchObject({ effect: 'restore', tier: 'hard_confirm' });
    expect(p.reasons).toContain('reverts the whole file');
    await svc.revert({ token: p.token!, confirm: 'hold' }, 'c1');
    expect(git(repo, 'status', '--porcelain', 'a.ts')).toBe('');
    fs.writeFileSync(a, 'staged\n');
    git(repo, 'add', 'a.ts');
    const s = await svc.revertPreview({ sessionId: 's1', target: { kind: 'file', absPath: a, to: 'head' } }, 'c1');
    expect(s.blocked).toMatchObject({ code: 'staged_changes' });
  });

  it('file -> checkpoint without a checkpoint is refused', async () => {
    const { a, svc } = setup();
    const p = await svc.revertPreview({ sessionId: 's1', target: { kind: 'file', absPath: a, to: 'checkpoint' } }, 'c1');
    expect(p.blocked).toMatchObject({ code: 'no_checkpoint' });
  });

  it('hunk revert works in a non-git directory', async () => {
    const { a, svc } = setup({ noRepo: true });
    const p = await svc.revertPreview({ sessionId: 's1', target: { kind: 'hunk', absPath: a, hunkId: 'e2#0', scope: 'all' } }, 'c1');
    expect(p.blocked).toBeNull();
    await svc.revert({ token: p.token!, confirm: 'tap' }, 'c1');
    expect(fs.readFileSync(a, 'utf8')).toBe('l1\nTWO\nl3\nl4\nl5\nl6\nl7\nl8\n');
  });

  it('sandbox and git-disabled are refused', async () => {
    const { a, svc } = setup();
    process.env.COMPANION_SANDBOX = '1';
    try {
      const p = await svc.revertPreview({ sessionId: 's1', target: { kind: 'hunk', absPath: a, hunkId: 'e1#0', scope: 'all' } }, 'c1');
      expect(p.blocked).toMatchObject({ code: 'sandbox' });
    } finally {
      delete process.env.COMPANION_SANDBOX;
    }
    const off = setup({ git: false });
    const q = await off.svc.revertPreview({ sessionId: 's1', target: { kind: 'hunk', absPath: off.a, hunkId: 'e1#0', scope: 'all' } }, 'c1');
    expect(q.blocked).toMatchObject({ code: 'git_disabled' });
  });

  it('tokens are bound to the connection and expire', async () => {
    const { a, svc } = setup();
    const p = await svc.revertPreview({ sessionId: 's1', target: { kind: 'hunk', absPath: a, hunkId: 'e1#0', scope: 'all' } }, 'c1');
    await expect(svc.revert({ token: p.token!, confirm: 'tap' }, 'other-client')).rejects.toMatchObject({ code: 'expired' });
    await expect(svc.revert({ token: 'deadbeef', confirm: 'tap' }, 'c1')).rejects.toMatchObject({ code: 'expired' });
  });

  it('handlers: expired token code, origin credential needs write capability', async () => {
    const { svc } = setup();
    const sent: any[] = [];
    const ctx: any = {
      review: svc,
      send: (_ws: unknown, r: unknown) => sent.push(r),
      requireRemoteCapability: () => 'capability_disabled',
      watcher: { getActiveSessionId: () => null },
    };
    const h = registerReviewHandlers(ctx);
    await h.review_revert({ id: 'c1', ws: {} } as any, { token: 'nope', confirm: 'tap' }, 'r1');
    expect(sent[0]).toMatchObject({ type: 'review_revert', success: false, payload: { code: 'expired' } });
    await h.review_revert({ id: 'c1', ws: {}, originCredential: { token: 'x' } } as any, { token: 'nope', confirm: 'tap' }, 'r2');
    expect(sent[1].payload.code).toBe('blocked');
  });
});
