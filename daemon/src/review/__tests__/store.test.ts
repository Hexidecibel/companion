import * as fs from 'fs';
import * as path from 'path';
import { ReviewStore, sanitizeReviewState, compactApprovals, emptyCheckpoint } from '../store';
import { tmpDir } from './helpers';

const TREE = 'a'.repeat(40);

describe('ReviewStore', () => {
  it('sanitizes, prunes unseen sessions, drops bad trees', () => {
    const now = Date.parse('2026-10-01T00:00:00Z');
    const s = sanitizeReviewState(
      {
        sessions: {
          ok: {
            projectPath: '/p',
            reviewedThrough: 5,
            approvedTurnIds: ['t', 3],
            snapshots: [
              { repoRoot: '/p', tree: TREE },
              { repoRoot: '/p', tree: 'nope' },
            ],
            updatedAt: now,
            seenAt: now,
          },
          old: {
            projectPath: '/p',
            reviewedThrough: 5,
            approvedTurnIds: [],
            snapshots: [],
            updatedAt: 1,
            seenAt: 1,
          },
          bad: { reviewedThrough: 'x' },
        },
        polish: { k: { gist: 'G', at: now } },
      },
      now
    );
    expect(Object.keys(s.sessions)).toEqual(['ok']);
    expect(s.sessions.ok.approvedTurnIds).toEqual(['t']);
    expect(s.sessions.ok.snapshots).toHaveLength(1);
    expect(s.polish.k.gist).toBe('G');
  });

  it('moves a corrupt file aside and starts fresh; round-trips atomically with 0600', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'state.json'), '{not json');
    const st = new ReviewStore(dir, 5);
    await st.load();
    expect(fs.readdirSync(dir).some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);
    st.put('s1', { ...emptyCheckpoint('/p', Date.now()), reviewedThrough: 42 });
    await st.flush();
    const mode = fs.statSync(path.join(dir, 'state.json')).mode & 0o777;
    expect(mode).toBe(0o600);
    const st2 = new ReviewStore(dir, 5);
    await st2.load();
    expect(st2.get('s1', '/p').reviewedThrough).toBe(42);
    // Project mismatch resets.
    expect(st2.get('s1', '/other').reviewedThrough).toBe(0);
  });

  it('compacts contiguous approvals into reviewedThrough', () => {
    const c = {
      ...emptyCheckpoint('/p', 0),
      reviewedThrough: 10,
      approvedTurnIds: ['t2', 't3', 't5'],
    };
    const turns = [
      { id: 't1', lastEditAt: 5 },
      { id: 't2', lastEditAt: 20 },
      { id: 't3', lastEditAt: 30 },
      { id: 't4', lastEditAt: 40 },
      { id: 't5', lastEditAt: 50 },
    ];
    const out = compactApprovals(c, turns);
    expect(out.reviewedThrough).toBe(30);
    expect(out.approvedTurnIds).toEqual(['t5']);
  });

  it('never folds past an edit still in flight', () => {
    const c = { ...emptyCheckpoint('/p', 0), approvedTurnIds: ['t1'] };
    const out = compactApprovals(c, [{ id: 't1', lastEditAt: 10, open: true }]);
    expect(out.reviewedThrough).toBe(0);
    expect(out.approvedTurnIds).toEqual(['t1']);
  });
});
