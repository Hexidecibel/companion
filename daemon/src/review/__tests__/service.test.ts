import * as fs from 'fs';
import * as path from 'path';
import { ReviewService } from '../service';
import { ReviewStore } from '../store';
import { GitRunner } from '../git-runner';
import { registerReviewHandlers } from '../../handlers/review';
import { prompt, toolUse, toolResult, editResult, writeCreate, assistantText, jsonl, tmpDir, fakeWatcher } from './helpers';

const T0 = Date.parse('2026-09-30T08:00:00Z');
const hunk = (n: number) => [{ oldStart: n, oldLines: 1, newStart: n, newLines: 2, lines: [' ctx', `+line ${n}`] }];

function scenario() {
  const dir = tmpDir();
  const conv = path.join(dir, 'c.jsonl');
  const entries = [
    prompt('t1', 'fix the guard', T0),
    toolUse('e1', 'Edit', { file_path: '/proj/src/guard.ts' }, T0 + 1000),
    toolResult('e1', editResult('/proj/src/guard.ts', hunk(1)), T0 + 2000),
    assistantText("I've fixed the guard.", T0 + 3000),
    prompt('t2', 'add a workflow', T0 + 10_000),
    toolUse('e2', 'Write', { file_path: '/proj/.github/workflows/ci.yml' }, T0 + 11_000),
    toolResult('e2', writeCreate('/proj/.github/workflows/ci.yml', 'on: push\n'), T0 + 12_000),
    toolUse('e3', 'Edit', { file_path: '/tmp/claude-1000/x/scratchpad/notes.md' }, T0 + 12_500),
    toolResult('e3', editResult('/tmp/claude-1000/x/scratchpad/notes.md', hunk(1)), T0 + 12_600),
    assistantText('Added the CI workflow.', T0 + 13_000),
  ];
  fs.writeFileSync(conv, jsonl(entries));
  const broadcasts: Array<{ type: string; payload: any }> = [];
  let now = T0 + 60_000;
  const svc = new ReviewService({
    watcher: fakeWatcher([{ id: 'sess', projectPath: '/proj', files: [conv] }]),
    gitEnabled: () => false,
    runner: new GitRunner({ enabled: () => false }),
    store: new ReviewStore(tmpDir(), 5, () => now),
    broadcast: (type, payload) => broadcasts.push({ type, payload }),
    now: () => now,
    throttleMs: 0,
    debounceMs: 0,
  });
  return { svc, conv, broadcasts, setNow: (n: number) => (now = n) };
}

describe('ReviewService (transcript mode)', () => {
  it('summary counts unreviewed work, risk, excludes scratchpads', async () => {
    const { svc } = scenario();
    const s = (await svc.summary('sess'))!;
    expect(s.unreviewedFiles).toBe(2);
    expect(s.unreviewedTurns).toBe(2);
    expect(s.unreviewedAdditions).toBe(2);
    expect(s.totalFiles).toBe(2);
    expect(s.riskLevel).toBe('high');
    expect(s.topRisks[0]).toMatchObject({ kind: 'ci', path: '.github/workflows/ci.yml' });
    expect(s.mode).toBe('transcript');
    expect(s.live).toBe(false);
  });

  it('turns view: gists, edits with stable hunk ids, oldest first', async () => {
    const { svc } = scenario();
    const r = await svc.get({ sessionId: 'sess', scope: 'since_checkpoint', view: 'turns' });
    expect(r.turns.map((t) => t.summary)).toEqual(['Fixed the guard: 1 file, +1 -0', 'Added the CI workflow: 1 file, +1 -0']);
    expect(r.turns[1].riskLevel).toBe('high');
    expect(r.edits.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(r.edits[0].hunks[0].id).toBe('e1#0');
    expect(r.edits[0].path).toBe('src/guard.ts');
    expect(r.files).toEqual([]);
    expect(r.checkpoint.reviewedThrough).toBe(0);
  });

  it('mark reviewed is monotonic, clamps to now, and empties since_checkpoint', async () => {
    const { svc, broadcasts } = scenario();
    const m = await svc.markReviewed('sess', T0 + 2000, 'Phone');
    expect(m.checkpoint.reviewedThrough).toBe(T0 + 2000);
    expect(m.checkpoint.updatedBy).toBe('Phone');
    expect(m.summary.unreviewedTurns).toBe(1);
    const back = await svc.markReviewed('sess', 5, 'Phone');
    expect(back.checkpoint.reviewedThrough).toBe(T0 + 2000);
    const fut = await svc.markReviewed('sess', Number.MAX_SAFE_INTEGER);
    expect(fut.checkpoint.reviewedThrough).toBe(T0 + 60_000);
    const r = await svc.get({ sessionId: 'sess', scope: 'since_checkpoint', view: 'turns' });
    expect(r.turns).toEqual([]);
    const all = await svc.get({ sessionId: 'sess', scope: 'all', view: 'turns' });
    expect(all.turns).toHaveLength(2);
    // Global broadcasts carry sessionId in the payload.
    const sums = broadcasts.filter((b) => b.type === 'review_summary');
    expect(sums.length).toBeGreaterThan(0);
    expect(sums[sums.length - 1].payload.summary.sessionId).toBe('sess');
    const versions = sums.map((b) => b.payload.summary.version);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
  });

  it('approving the oldest turn compacts into reviewedThrough', async () => {
    const { svc } = scenario();
    const a = await svc.approveTurn('sess', 't2', true);
    expect(a.checkpoint.approvedTurnIds).toEqual(['t2']);
    expect(a.summary.unreviewedTurns).toBe(1);
    const b = await svc.approveTurn('sess', 't1', true);
    expect(b.checkpoint.approvedTurnIds).toEqual([]);
    expect(b.checkpoint.reviewedThrough).toBe(T0 + 12_000);
    expect(b.summary.unreviewedFiles).toBe(0);
  });

  it('new edits after a mark show up again (incremental)', async () => {
    const { svc, conv } = scenario();
    await svc.markReviewed('sess', T0 + 59_000);
    fs.appendFileSync(
      conv,
      jsonl([prompt('t3', 'more', T0 + 70_000), toolUse('e4', 'Edit', { file_path: '/proj/src/a.ts' }, T0 + 71_000), toolResult('e4', editResult('/proj/src/a.ts', hunk(3)), T0 + 72_000)])
    );
    const s = (await svc.refresh('sess'))!;
    expect(s.unreviewedTurns).toBe(1);
    expect(s.unreviewedFiles).toBe(1);
  });
});

describe('review handlers', () => {
  function ctxFor(svc: ReviewService | null) {
    const sent: any[] = [];
    const ctx: any = { review: svc, send: (_ws: unknown, r: unknown) => sent.push(r), watcher: { getActiveSessionId: () => null } };
    return { handlers: registerReviewHandlers(ctx), sent, client: { ws: {} } as any };
  }

  it('unknown session -> {code: unknown_session}', async () => {
    const { svc } = scenario();
    const { handlers, sent, client } = ctxFor(svc);
    await handlers.review_get(client, { sessionId: 'nope', scope: 'all', view: 'turns' }, 'r1');
    expect(sent[0]).toMatchObject({ type: 'review_get', success: false, payload: { code: 'unknown_session' }, requestId: 'r1' });
  });

  it('bad request + success shapes', async () => {
    const { svc } = scenario();
    const { handlers, sent, client } = ctxFor(svc);
    await handlers.review_mark_reviewed(client, { sessionId: 'sess' }, 'r2');
    expect(sent[0].payload.code).toBe('bad_request');
    await handlers.review_summary_list(client, {}, 'r3');
    expect(sent[1]).toMatchObject({ type: 'review_summary_list', success: true });
    expect(sent[1].payload.summaries[0].sessionId).toBe('sess');
  });

  it('no service -> unavailable', async () => {
    const { handlers, sent, client } = ctxFor(null);
    await handlers.review_summary_list(client, {}, 'r');
    expect(sent[0].payload.code).toBe('unavailable');
  });
});

describe('isExcludedPath', () => {
  const svc = new ReviewService({ watcher: fakeWatcher([]), gitEnabled: () => false, store: new ReviewStore(tmpDir(), 5) });
  it('excludes scratchpads always, temp dirs only outside the project', () => {
    expect(svc.isExcludedPath('/tmp/claude-1000/x/scratchpad/a.md', '/tmp/claude-1000/x')).toBe(true);
    expect(svc.isExcludedPath('/tmp/notes.txt', '/home/u/proj')).toBe(true);
    expect(svc.isExcludedPath('/tmp/proj/a.ts', '/tmp/proj')).toBe(false);
    expect(svc.isExcludedPath('/home/u/proj/a.ts', '/home/u/proj')).toBe(false);
  });
});
