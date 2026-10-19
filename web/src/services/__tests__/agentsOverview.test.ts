import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../types';
import type { SubagentSummary } from '../../types/subagents';
import {
  agentsBadge,
  buildAgentsOverview,
  clipWords,
  MAX_ROWS,
  RECENT_MS,
  shortActivity,
  shortDuration,
  type OverviewServerInput,
} from '../agentsOverview';

const MIN = 60_000;
const NOW = 1_800_000_000_000;

function ag(p: Partial<SubagentSummary> & { agentId: string }): SubagentSummary {
  return {
    sessionId: 'conv-a',
    depth: 1,
    name: p.agentId,
    status: 'running',
    startedAt: NOW - 10 * MIN,
    lastEntryAt: NOW - 1 * MIN,
    toolCalls: 3,
    edits: 0,
    filesTouched: 0,
    tokens: 0,
    recent: [],
    version: 1,
    ...p,
  };
}

function srv(agents: SubagentSummary[], extra: Partial<OverviewServerInput> = {}): OverviewServerInput {
  return {
    serverId: 's1',
    serverName: 'hexi',
    agents,
    labels: {
      'conv-a': { session: 'companion', sessionId: 'companion', project: 'companion' },
      'conv-b': { session: 'out4', sessionId: 'out4', project: 'out4' },
      'conv-c': { session: 'dox', sessionId: 'dox' },
      'conv-x': { session: 'a session in scratch', project: 'scratch' },
    },
    ...extra,
  };
}

describe('shortDuration / clipWords', () => {
  it('formats compactly', () => {
    expect(shortDuration(5_000)).toBe('5s');
    expect(shortDuration(12 * MIN + 30_000)).toBe('12m');
    expect(shortDuration(125 * MIN)).toBe('2h 5m');
    expect(shortDuration(120 * MIN)).toBe('2h');
    expect(shortDuration(-1)).toBe('0s');
  });
  it('clips to six words with an ellipsis', () => {
    expect(clipWords('one two three')).toBe('one two three');
    expect(clipWords('one two three four five six seven eight')).toBe('one two three four five six…');
    expect(clipWords('  a\n b  ')).toBe('a b');
  });
});

describe('shortActivity', () => {
  it('names the file being edited / read, never the raw command', () => {
    expect(shortActivity(ag({ agentId: 'a', pendingTool: 'Edit', activity: '/home/x/daemon/src/watcher.ts' }), NOW)).toBe('editing watcher.ts');
    expect(shortActivity(ag({ agentId: 'a', pendingTool: 'Read', activity: 'src/a/b.tsx' }), NOW)).toBe('reading b.tsx');
    expect(shortActivity(ag({ agentId: 'a', pendingTool: 'Bash', activity: 'cd web && rm -rf node_modules && echo SECRET=1' }), NOW)).toBe('running a command');
    expect(shortActivity(ag({ agentId: 'a', pendingTool: 'Grep', activity: 'foo.*bar' }), NOW)).toBe('searching code');
  });
  it('tests and builds', () => {
    expect(shortActivity(ag({ agentId: 'a', pendingTool: 'Bash', activity: 'npx jest src/x' }), NOW)).toBe('running jest');
    expect(
      shortActivity(
        ag({ agentId: 'a', pendingTool: 'Bash', activity: 'npx vitest run', tests: { runs: 3, failed: 2, lastFailed: true, lastAt: NOW } }),
        NOW,
      ),
    ).toBe('vitest (2 failing)');
    expect(shortActivity(ag({ agentId: 'a', pendingTool: 'Bash', activity: 'npx tsc --noEmit' }), NOW)).toBe('typecheck');
  });
  it('stuck headline, waiting, checklist, quiet, finished states', () => {
    expect(
      shortActivity(ag({ agentId: 'a', stuck: { kind: 'repeated_failure', severity: 'high', headline: 'same test failing 4 times in a row again', summary: '', since: NOW } }), NOW),
    ).toBe('same test failing 4 times in…');
    expect(shortActivity(ag({ agentId: 'a', status: 'waiting_child' }), NOW)).toBe('waiting on subagents');
    expect(shortActivity(ag({ agentId: 'a', checklist: { done: 2, total: 5, source: 'todo' } }), NOW)).toBe('step 3/5');
    expect(shortActivity(ag({ agentId: 'a', lastEntryAt: NOW - 7 * MIN }), NOW)).toBe('quiet 7m');
    expect(shortActivity(ag({ agentId: 'a', status: 'done', endedAt: NOW }), NOW)).toBe('done');
    expect(shortActivity(ag({ agentId: 'a', status: 'failed', endedAt: NOW }), NOW)).toBe('failed');
  });
  it('is at most ~6 words for anything', () => {
    const s = shortActivity(ag({ agentId: 'a', pendingTool: 'SomeVeryLongTool' }), NOW);
    expect(s.split(' ').length).toBeLessThanOrEqual(6);
  });
});

describe('buildAgentsOverview', () => {
  it('empty: no agents in the last 2 hours', () => {
    const o = buildAgentsOverview([srv([])], NOW);
    expect(o.groups).toEqual([]);
    expect(o.idle).toBe(true);
    expect(o.emptyLine).toBe('No agents in the last 2 hours.');
    expect(agentsBadge(o)).toBeNull();
  });

  it('empty: agents older than 2 h are ignored', () => {
    const old = ag({ agentId: 'old', status: 'done', endedAt: NOW - RECENT_MS - 1 });
    const o = buildAgentsOverview([srv([old])], NOW);
    expect(o.groups).toEqual([]);
    expect(o.emptyLine).toBe('No agents in the last 2 hours.');
  });

  it('idle with recent history: last batch line + finished-only fold', () => {
    const o = buildAgentsOverview(
      [
        srv([
          ag({ agentId: 'd1', sessionId: 'conv-c', status: 'done', endedAt: NOW - 14 * MIN }),
          ag({ agentId: 'd2', sessionId: 'conv-c', status: 'done', endedAt: NOW - 20 * MIN }),
          ag({ agentId: 'd3', sessionId: 'conv-a', status: 'done', endedAt: NOW - 50 * MIN }),
        ]),
      ],
      NOW,
    );
    expect(o.emptyLine).toBe('Nothing running. Last batch finished 14 min ago in dox.');
    expect(o.groups[0].cards).toEqual([]);
    expect(o.groups[0].finishedOnly.map((c) => [c.title, c.total])).toEqual([
      ['dox', 2],
      ['companion', 1],
    ]);
  });

  it('an agent finished exactly inside the window is kept, a running one is always kept', () => {
    const o = buildAgentsOverview(
      [
        srv([
          ag({ agentId: 'edge', status: 'done', endedAt: NOW - RECENT_MS }),
          ag({ agentId: 'ancient-runner', sessionId: 'conv-b', startedAt: NOW - 10 * 60 * MIN, lastEntryAt: NOW - 9 * 60 * MIN }),
        ]),
      ],
      NOW,
    );
    expect(o.running).toBe(1);
    expect(o.groups[0].cards.map((c) => c.title)).toEqual(['out4']);
    expect(o.groups[0].finishedOnly.map((c) => c.title)).toEqual(['companion']);
  });

  it('orders cards attention > running (newest activity first) and pins attention items', () => {
    const o = buildAgentsOverview(
      [
        srv([
          ag({ agentId: 'r-old', sessionId: 'conv-a', lastEntryAt: NOW - 5 * MIN }),
          ag({ agentId: 'r-new', sessionId: 'conv-x', lastEntryAt: NOW - 10_000 }),
          ag({
            agentId: 'stuck1',
            sessionId: 'conv-b',
            name: 'test-runner',
            lastEntryAt: NOW - 20 * MIN,
            stuck: { kind: 'repeated_failure', severity: 'high', headline: 'same test failing 4x', summary: 'x', since: NOW - 6 * MIN },
          }),
          ag({ agentId: 'f1', sessionId: 'conv-c', status: 'failed', endedAt: NOW - 3 * MIN, notifySummary: 'Agent "x" failed' }),
          ag({ agentId: 'f1-done', sessionId: 'conv-c', status: 'done', endedAt: NOW - 4 * MIN }),
        ]),
      ],
      NOW,
    );
    const titles = o.groups[0].cards.map((c) => c.title);
    // Attention cards (newest first: failed dox 3 min ago, then the stuck out4) before running ones.
    expect(titles.slice(0, 2).sort()).toEqual(['dox', 'out4']);
    expect(titles.slice(2)).toEqual(['scratch', 'companion']);
    expect(o.attention.map((a) => [a.kind, a.sessionTitle, a.name, a.chip, a.detail])).toEqual([
      ['stuck', 'out4', 'test-runner', 'STUCK 6m', 'same test failing 4x'],
      ['failed', 'dox', 'f1', 'FAILED', 'Agent "x" failed'],
    ]);
    expect(o.attention[0].openSessionId).toBe('out4');
    expect(o.running).toBe(3);
    expect(o.stuck).toBe(1);
    expect(o.failed).toBe(1);
    expect(o.idle).toBe(false);
    expect(o.emptyLine).toBeUndefined();
    expect(agentsBadge(o)).toEqual({ count: 3, alert: true });
    // A not-a-Companion conversation has no session to open.
    expect(o.groups[0].cards.find((c) => c.title === 'scratch')!.openSessionId).toBeUndefined();
  });

  it('badge: red with zero running when only a failure is left', () => {
    const o = buildAgentsOverview([srv([ag({ agentId: 'f', status: 'failed', endedAt: NOW - MIN })])], NOW);
    expect(agentsBadge(o)).toEqual({ count: 0, alert: true });
    // Failed-only session is an attention card, not folded into the finished line.
    expect(o.groups[0].cards.map((c) => c.title)).toEqual(['companion']);
    expect(o.groups[0].finishedOnly).toEqual([]);
  });

  it('nests children under their parent with an indent, folds finished, counts done/total', () => {
    const o = buildAgentsOverview(
      [
        srv([
          ag({ agentId: 'parent', name: 'perf-batch', pendingTool: 'Edit', activity: 'src/watcher.ts' }),
          ag({ agentId: 'child', name: 'tests', parentAgentId: 'parent', depth: 2, startedAt: NOW - 3 * MIN }),
          ag({ agentId: 'grandchild', name: 'deep', parentAgentId: 'child', depth: 3 }),
          ag({ agentId: 'other', name: 'other-root', lastEntryAt: NOW - 30 * MIN }),
          ag({ agentId: 'done1', status: 'done', endedAt: NOW - 2 * MIN }),
          ag({ agentId: 'done2', status: 'done_unconfirmed', endedAt: NOW - 1 * MIN }),
          ag({ agentId: 'stopped', status: 'stopped', endedAt: NOW - 1 * MIN }),
        ]),
      ],
      NOW,
    );
    const card = o.groups[0].cards[0];
    expect(card.rows.map((r) => [r.name, r.indent])).toEqual([
      ['perf-batch', 0],
      ['tests', 1],
      ['deep', 2],
      ['other-root', 0],
    ]);
    expect(card.rows[0]).toMatchObject({ elapsed: '10m', activity: 'editing watcher.ts', tone: 'running' });
    expect(card.rows[1].elapsed).toBe('3m');
    expect(card.done).toBe(2);
    expect(card.total).toBe(7);
    expect(card.running).toBe(4);
    expect(card.finished.map((r) => r.agentId)).toEqual(['done2', 'stopped', 'done1']);
    expect(card.subtitle).toBeUndefined();
  });

  it('caps visible rows at MAX_ROWS and puts the rest behind +N more', () => {
    const agents = Array.from({ length: MAX_ROWS + 3 }, (_, i) => ag({ agentId: `a${i}`, lastEntryAt: NOW - i * 1000 }));
    const card = buildAgentsOverview([srv(agents)], NOW).groups[0].cards[0];
    expect(card.rows).toHaveLength(MAX_ROWS);
    expect(card.moreRows.map((r) => r.agentId)).toEqual(['a5', 'a6', 'a7']);
    expect(card.rows[0].agentId).toBe('a0');
  });

  it('stuck agents sort first inside a card', () => {
    const card = buildAgentsOverview(
      [
        srv([
          ag({ agentId: 'fresh', lastEntryAt: NOW }),
          ag({ agentId: 'stk', lastEntryAt: NOW - 30 * MIN, stuck: { kind: 'loop', severity: 'medium', headline: 'loop', summary: '', since: NOW - MIN } }),
        ]),
      ],
      NOW,
    ).groups[0].cards[0];
    expect(card.rows.map((r) => [r.agentId, r.chip])).toEqual([
      ['stk', 'STUCK 1m'],
      ['fresh', undefined],
    ]);
  });

  it('links cards to the app session list and uses its activity as the one-line rollup', () => {
    const sessions: SessionSummary[] = [
      { id: 'companion', name: 'companion', friendlyName: 'Companion', projectPath: '/x', status: 'working', lastActivity: NOW, currentActivity: 'Batch A perf fixes across the daemon watcher and parser now', tmuxSessionName: 'companion' },
    ];
    const card = buildAgentsOverview([srv([ag({ agentId: 'a' })], { sessions })], NOW).groups[0].cards[0];
    expect(card.title).toBe('Companion');
    expect(card.openSessionId).toBe('companion');
    expect(card.subtitle).toBe('Batch A perf fixes across the daemon watcher…');
  });

  it('degrades without labels (older daemon): short conversation id, nothing to open', () => {
    const card = buildAgentsOverview([srv([ag({ agentId: 'a', sessionId: '1234567890abcdef' })], { labels: undefined })], NOW).groups[0].cards[0];
    expect(card.title).toBe('session 12345678');
    expect(card.openSessionId).toBeUndefined();
  });

  it('groups per server; server headings only when more than one has something', () => {
    const one = buildAgentsOverview([srv([ag({ agentId: 'a' })]), { serverId: 's2', serverName: 'mac', agents: [] }], NOW);
    expect(one.groups).toHaveLength(1);
    expect(one.multiServer).toBe(false);
    const two = buildAgentsOverview(
      [srv([ag({ agentId: 'a' })]), { serverId: 's2', serverName: 'mac', agents: [ag({ agentId: 'b', sessionId: 'zz' })] }],
      NOW,
    );
    expect(two.multiServer).toBe(true);
    expect(two.groups.map((g) => g.serverName)).toEqual(['hexi', 'mac']);
    expect(two.running).toBe(2);
  });
});

describe('tidyProject', () => {
  it('drops a home prefix the daemon could not strip', async () => {
    const { tidyProject } = await import('../agentsOverview');
    expect(tidyProject('home-hexi-local-src-out4')).toBe('out4');
    expect(tidyProject('Users-chris-src-app')).toBe('app');
    expect(tidyProject('mnt-hexinas-apps')).toBe('mnt-hexinas-apps');
    expect(tidyProject(undefined)).toBeUndefined();
  });
});
