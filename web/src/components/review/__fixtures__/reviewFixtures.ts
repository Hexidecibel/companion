/**
 * Review fixtures built with the exact contract types. Used by unit tests and
 * the dev preview harness while the daemon side lands.
 */
import type {
  ReviewCheckpoint, ReviewEdit, ReviewFileChange, ReviewGetResponse, ReviewSummary, ReviewTurn,
} from '../../../types/review';

export const T0 = 1_790_000_000_000;
const MIN = 60_000;

export const fxSummary = (over: Partial<ReviewSummary> = {}): ReviewSummary => ({
  sessionId: 'sess-1',
  version: 7,
  unreviewedFiles: 5,
  unreviewedTurns: 2,
  unreviewedAdditions: 142,
  unreviewedDeletions: 38,
  totalFiles: 9,
  totalTurns: 12,
  riskLevel: 'high',
  topRisks: [
    { kind: 'ci', level: 'high', reason: 'CI workflow', path: '.github/workflows/deploy.yml' },
    { kind: 'config', level: 'medium', reason: 'Build config', path: 'web/vite.config.ts' },
  ],
  lastChangeAt: T0 - 2 * MIN,
  live: false,
  reviewedThrough: T0 - 30 * MIN,
  mode: 'git',
  ...over,
});

export const fxCheckpoint: ReviewCheckpoint = {
  reviewedThrough: T0 - 30 * MIN,
  approvedTurnIds: [],
  snapshots: [{ repoRoot: '/home/u/proj', tree: 'abc123' }],
  updatedAt: T0 - 30 * MIN,
  updatedBy: 'Desktop',
};

export const fxEdits: ReviewEdit[] = [
  {
    id: 'toolu_01', turnId: 'turn-11', tool: 'Edit', path: 'daemon/src/herald/echoGuard.ts',
    absPath: '/home/u/proj/daemon/src/herald/echoGuard.ts', kind: 'update', at: T0 - 9 * MIN,
    additions: 4, deletions: 2, risks: [],
    hunks: [{
      id: 'toolu_01#0', oldStart: 40, oldLines: 8, newStart: 40, newLines: 10,
      section: 'export function isEcho(text: string, recent: string[]): boolean {',
      lines: [
        '   const norm = normalize(text);',
        '   if (!norm) return false;',
        '-  const window = recent.slice(-3);',
        '-  return window.some((r) => similarity(r, norm) > 0.8);',
        '+  // Compare against the last five utterances, not three.',
        '+  const window = recent.slice(-5);',
        '+  const threshold = norm.length < 12 ? 0.9 : 0.75;',
        '+  return window.some((r) => similarity(r, norm) > threshold);',
        ' }',
        ' ',
      ],
    }],
  },
  {
    id: 'toolu_02', turnId: 'turn-11', tool: 'Write', path: 'daemon/src/herald/__tests__/echoGuard.test.ts',
    absPath: '/home/u/proj/daemon/src/herald/__tests__/echoGuard.test.ts', kind: 'create', at: T0 - 8 * MIN,
    additions: 9, deletions: 0, risks: [],
    hunks: [{
      id: 'toolu_02#0', oldStart: 0, oldLines: 0, newStart: 1, newLines: 9,
      lines: [
        "+import { isEcho } from '../echoGuard';",
        '+',
        "+describe('isEcho', () => {",
        "+  it('treats a short repeat as an echo', () => {",
        "+    expect(isEcho('stop', ['play music', 'stop'])).toBe(true);",
        '+  });',
        "+  it('ignores unrelated speech', () => {",
        "+    expect(isEcho('what time is it', ['stop'])).toBe(false);",
        '+  });',
      ],
    }],
  },
  {
    id: 'toolu_03', turnId: 'turn-12', tool: 'Edit', path: '.github/workflows/deploy.yml',
    absPath: '/home/u/proj/.github/workflows/deploy.yml', kind: 'update', at: T0 - 3 * MIN,
    additions: 3, deletions: 1,
    risks: [{ kind: 'ci', level: 'high', reason: 'CI workflow' }],
    hunks: [{
      id: 'toolu_03#0', oldStart: 18, oldLines: 6, newStart: 18, newLines: 8,
      section: 'jobs:',
      lines: [
        '     runs-on: ubuntu-latest',
        '     steps:',
        '       - uses: actions/checkout@v4',
        '-      - run: npm ci && npm run build',
        '+      - run: npm ci',
        '+      - run: npm run build',
        '+      - run: bin/deploy --prod',
        '       - uses: actions/upload-artifact@v4',
      ],
    }],
  },
  {
    id: 'toolu_04', turnId: 'turn-12', tool: 'Edit', path: 'web/vite.config.ts',
    absPath: '/home/u/proj/web/vite.config.ts', kind: 'update', at: T0 - 2 * MIN,
    additions: 1, deletions: 1,
    risks: [{ kind: 'config', level: 'medium', reason: 'Build config' }],
    hunks: [{
      id: 'toolu_04#0', oldStart: 9, oldLines: 3, newStart: 9, newLines: 3,
      lines: [
        '   build: {',
        "-    target: 'es2020',",
        "+    target: 'es2022',",
        '   },',
      ],
    }],
  },
];

export const fxTurns: ReviewTurn[] = [
  {
    id: 'turn-11', index: 11, startedAt: T0 - 12 * MIN, endedAt: T0 - 7 * MIN,
    prompt: 'The echo guard keeps eating my short commands, fix it',
    gist: 'Fixed echo guard', summary: 'Fixed echo guard: 2 files, +13 -2', summarySource: 'reply',
    fileCount: 2, additions: 13, deletions: 2, riskLevel: null, approved: false, unreviewed: true,
    editIds: ['toolu_01', 'toolu_02'],
  },
  {
    id: 'turn-12', index: 12, startedAt: T0 - 5 * MIN, endedAt: T0 - 1 * MIN,
    prompt: 'Make the deploy workflow run bin/deploy after the build',
    gist: 'Split build and deploy steps', summary: 'Split build and deploy steps: 2 files, +4 -2', summarySource: 'reply',
    fileCount: 2, additions: 4, deletions: 2, riskLevel: 'high', approved: false, unreviewed: true,
    editIds: ['toolu_03', 'toolu_04'],
  },
];

const bigHunkLines = Array.from({ length: 260 }, (_, i) => (i % 7 === 3 ? `-  legacy(${i});` : i % 7 === 4 ? `+  modern(${i}, opts);` : `   step(${i});`));

export const fxFiles: ReviewFileChange[] = [
  {
    path: '.github/workflows/deploy.yml', absPath: '/home/u/proj/.github/workflows/deploy.yml', status: 'modified',
    additions: 3, deletions: 1, risks: [{ kind: 'ci', level: 'high', reason: 'CI workflow' }], heat: 82,
    source: 'git', turnIds: ['turn-12'], unreviewed: true, hunks: fxEdits[2].hunks,
  },
  {
    path: 'daemon/src/herald/echoGuard.ts', absPath: '/home/u/proj/daemon/src/herald/echoGuard.ts', status: 'modified',
    additions: 4, deletions: 2, risks: [], heat: 54, source: 'git', turnIds: ['turn-11'],
    alsoChangedBy: ['Out4'], unreviewed: true, hunks: fxEdits[0].hunks,
  },
  {
    path: 'daemon/src/pipeline/steps.ts', absPath: '/home/u/proj/daemon/src/pipeline/steps.ts', status: 'modified',
    additions: 38, deletions: 37, risks: [{ kind: 'large_rewrite', level: 'medium', reason: 'rewrites 62% of the file' }], heat: 71,
    source: 'git', turnIds: ['turn-11'], unreviewed: true,
    hunks: [{ id: 'gbig', oldStart: 1, oldLines: 223, newStart: 1, newLines: 223, lines: bigHunkLines }],
  },
  {
    path: 'daemon/src/herald/__tests__/echoGuard.test.ts', absPath: '/home/u/proj/daemon/src/herald/__tests__/echoGuard.test.ts',
    status: 'added', additions: 9, deletions: 0, risks: [], heat: 31, source: 'git', turnIds: ['turn-11'],
    unreviewed: true, hunks: fxEdits[1].hunks,
  },
  {
    path: 'web/vite.config.ts', absPath: '/home/u/proj/web/vite.config.ts', status: 'modified', additions: 1, deletions: 1,
    risks: [{ kind: 'config', level: 'medium', reason: 'Build config' }], heat: 40, source: 'git', turnIds: ['turn-12'],
    unreviewed: true, hunks: fxEdits[3].hunks,
  },
  {
    path: 'package-lock.json', absPath: '/home/u/proj/package-lock.json', status: 'modified', additions: 120, deletions: 44,
    risks: [{ kind: 'lockfile', level: 'low', reason: 'Lockfile' }], heat: 12, trivial: 'lockfile', source: 'git',
    turnIds: ['turn-12'], unreviewed: true, hunks: null, hunksOmitted: 'lazy',
  },
  {
    path: 'daemon/src/herald/inbox.ts', absPath: '/home/u/proj/daemon/src/herald/inbox.ts', status: 'modified', additions: 3, deletions: 3,
    risks: [], heat: 8, trivial: 'whitespace', source: 'git', turnIds: ['turn-11'], unreviewed: true, hunks: null, hunksOmitted: 'lazy',
  },
];

export const fxUnattributed: ReviewFileChange[] = [
  {
    path: 'migrations/003_users.sql', absPath: '/home/u/proj/migrations/003_users.sql', status: 'deleted',
    additions: 0, deletions: 140,
    risks: [{ kind: 'migration', level: 'high', reason: 'Database migration' }, { kind: 'deleted', level: 'high', reason: 'deletes 140 lines' }],
    heat: 95, source: 'git', turnIds: [], unreviewed: true, hunks: null, hunksOmitted: 'lazy',
  },
];

export function fxGet(view: 'turns' | 'files', over: Partial<ReviewGetResponse> = {}): ReviewGetResponse {
  return {
    sessionId: 'sess-1',
    scope: 'since_checkpoint',
    view,
    summary: fxSummary(),
    checkpoint: fxCheckpoint,
    turns: fxTurns,
    edits: view === 'turns' ? fxEdits : [],
    files: view === 'files' ? fxFiles : [],
    unattributed: view === 'files' ? fxUnattributed : [],
    repos: [{ root: '/home/u/proj', worktree: false, branch: 'main', head: 'fa09a6b' }],
    computedAt: T0,
    ...over,
  };
}
