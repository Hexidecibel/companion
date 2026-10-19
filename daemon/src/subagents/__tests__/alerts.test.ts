import * as fs from 'fs';
import { SubagentAlerts, type SubagentAlert } from '../alerts';
import { SubagentTracker } from '../tracker';
import type { SubagentSummary } from '../protocol';
import { factsFor, sessionLabels } from '../links';
import {
  T0,
  CONV,
  tmpProjects,
  prompt,
  text,
  notification,
  agentFile,
  append,
  meta,
} from './fixtures';

const MIN = 60_000;

function sum(p: Partial<SubagentSummary>): SubagentSummary {
  return {
    agentId: 'a0',
    sessionId: 'conv1',
    depth: 1,
    name: 'Agent',
    status: 'running',
    startedAt: T0,
    lastEntryAt: T0,
    toolCalls: 0,
    edits: 0,
    filesTouched: 0,
    tokens: 0,
    recent: [],
    version: 1,
    ...p,
  };
}

function harness(opts: { settleMs?: number; minGroup?: number; label?: boolean } = {}) {
  const agents = new Map<string, SubagentSummary>();
  let now = T0;
  let quiet = false;
  const published: SubagentAlert[][] = [];
  const alerts = new SubagentAlerts({
    summary: (id) => agents.get(id),
    label: (conv) =>
      opts.label === false ? null : { sessionId: `tmux-${conv}`, sessionName: 'Out4' },
    quiet: () => quiet,
    publish: (l) => published.push(l),
    now: () => now,
    settleMs: opts.settleMs ?? 20_000,
    minGroup: opts.minGroup,
  });
  const set = (...list: Array<Partial<SubagentSummary> & { agentId: string }>) => {
    for (const p of list) agents.set(p.agentId, sum({ ...agents.get(p.agentId), ...p }));
    alerts.onChanged(list.map((p) => p.agentId));
  };
  return {
    alerts,
    agents,
    published,
    set,
    last: () => published[published.length - 1] ?? [],
    setNow: (n: number) => (now = n),
    setQuiet: (q: boolean) => (quiet = q),
  };
}

afterEach(() => jest.useRealTimers());

describe('subagent inbox alerts', () => {
  it('one group item when every agent of the dispatch has ended (after the settle), plus one per failure', () => {
    jest.useFakeTimers();
    const h = harness();
    h.set(
      { agentId: 'a1', name: 'Fix tests' },
      { agentId: 'a2', name: 'Docs' },
      { agentId: 'a3', name: 'Audit' }
    );
    expect(h.published).toHaveLength(0);
    h.set({ agentId: 'a1', status: 'done', endedAt: T0 + MIN });
    h.set({ agentId: 'a2', status: 'failed', endedAt: T0 + 2 * MIN });
    // The failure is news at once.
    expect(h.last()).toEqual([
      expect.objectContaining({
        kind: 'failed',
        headline: 'An agent failed in Out4: Docs',
        sessionId: 'tmux-conv1',
        agentIds: ['a2'],
      }),
    ]);
    h.set({ agentId: 'a3', status: 'done', endedAt: T0 + 3 * MIN });
    expect(h.last().filter((a) => a.kind === 'group_done')).toHaveLength(0);
    jest.advanceTimersByTime(20_000);
    const group = h.last().find((a) => a.kind === 'group_done')!;
    expect(group).toMatchObject({
      headline: '3 agents done in Out4: 2 finished, 1 failed',
      total: 3,
      failed: 1,
      names: ['Fix tests', 'Docs', 'Audit'],
    });
    // Repeats of the same facts change nothing (no second publish, same items).
    const n = h.published.length;
    h.set({ agentId: 'a1', status: 'done', endedAt: T0 + MIN });
    h.set({ agentId: 'a2', status: 'failed', endedAt: T0 + 2 * MIN });
    jest.advanceTimersByTime(60_000);
    expect(h.published).toHaveLength(n);
    expect(h.alerts.list()).toHaveLength(2);
  });

  it('all finished cleanly says so; a new agent within the settle joins the group', () => {
    jest.useFakeTimers();
    const h = harness();
    h.set({ agentId: 'a1' }, { agentId: 'a2' });
    h.set(
      { agentId: 'a1', status: 'done', endedAt: T0 + 1000 },
      { agentId: 'a2', status: 'done', endedAt: T0 + 2000 }
    );
    jest.advanceTimersByTime(10_000);
    // Sequential dispatch in the same turn: one more agent before the settle ends.
    h.set({ agentId: 'a3' });
    jest.advanceTimersByTime(30_000);
    expect(h.alerts.list()).toHaveLength(0);
    h.set({ agentId: 'a3', status: 'done', endedAt: T0 + 60_000 });
    jest.advanceTimersByTime(20_000);
    expect(h.alerts.list()).toEqual([
      expect.objectContaining({
        kind: 'group_done',
        headline: 'All 3 agents finished in Out4',
        total: 3,
      }),
    ]);
  });

  it('a single agent finishing is not news; a single failure is', () => {
    jest.useFakeTimers();
    const h = harness();
    h.set({ agentId: 'a1' });
    h.set({ agentId: 'a1', status: 'done', endedAt: T0 + 1000 });
    jest.advanceTimersByTime(60_000);
    expect(h.alerts.list()).toEqual([]);
    h.set({ agentId: 'b1' });
    h.set({ agentId: 'b1', status: 'failed', endedAt: T0 + 2000 });
    jest.advanceTimersByTime(60_000);
    expect(h.alerts.list().map((a) => a.kind)).toEqual(['failed']);
  });

  it('a resumed agent that fails again is a new fact; its earlier failure stays one item', () => {
    jest.useFakeTimers();
    const h = harness();
    h.set({ agentId: 'a1' });
    h.set({ agentId: 'a1', status: 'failed', endedAt: T0 + 1000 });
    h.set({ agentId: 'a1', status: 'running', endedAt: undefined });
    h.set({ agentId: 'a1', status: 'failed', endedAt: T0 + 5000 });
    h.set({ agentId: 'a1', status: 'failed', endedAt: T0 + 5000 });
    const failed = h.alerts.list().filter((a) => a.kind === 'failed');
    expect(failed).toHaveLength(2);
    expect(new Set(failed.map((a) => a.key)).size).toBe(2);
  });

  it('never replays history: agents first seen finished, or that ended before start, make nothing', () => {
    jest.useFakeTimers();
    const h = harness({ minGroup: 1 });
    h.set({ agentId: 'old', status: 'failed', endedAt: T0 - 60 * MIN });
    // Seen "running" for a moment while its transcript was read, then the old notification.
    h.set({ agentId: 'o1' }, { agentId: 'o2' });
    h.set(
      { agentId: 'o1', status: 'failed', endedAt: T0 - 10 * MIN },
      { agentId: 'o2', status: 'done', endedAt: T0 - 9 * MIN }
    );
    jest.advanceTimersByTime(60_000);
    expect(h.alerts.list()).toEqual([]);
  });

  it('stuck: one item per running agent, updated in place, gone when it recovers or ends', () => {
    const h = harness();
    const stuck = {
      kind: 'repeated_failure' as const,
      severity: 'medium' as const,
      headline: 'same test failing 6 times',
      summary: 's',
      since: T0 + 1000,
    };
    h.set({ agentId: 'a1', name: 'Fix tests', stuck });
    expect(h.last()).toEqual([
      expect.objectContaining({
        kind: 'stuck',
        headline: 'An agent in Out4 looks stuck: Fix tests, same test failing 6 times',
        stuckKind: 'repeated_failure',
      }),
    ]);
    const first = h.last()[0];
    h.set({ agentId: 'a1', stuck: { ...stuck, headline: 'same test failing 7 times' } });
    // Same kind + since: the same item (no re-publish).
    expect(h.last()[0].key).toBe(first.key);
    h.set({ agentId: 'a1', stuck: undefined });
    expect(h.last()).toEqual([]);
    h.set({ agentId: 'a1', stuck });
    h.set({ agentId: 'a1', status: 'done', endedAt: T0 + 5000, stuck: undefined });
    expect(h.alerts.list().filter((a) => a.kind === 'stuck')).toEqual([]);
  });

  it('quiet hours: no news is made and stuck items are withheld', () => {
    jest.useFakeTimers();
    const h = harness({ settleMs: 0 });
    h.setQuiet(true);
    h.set(
      { agentId: 'a1' },
      {
        agentId: 'a2',
        stuck: { kind: 'loop', severity: 'medium', headline: 'looping', summary: 's', since: 1 },
      }
    );
    expect(h.alerts.list()).toEqual([]);
    h.set(
      { agentId: 'a1', status: 'failed', endedAt: T0 + 1 },
      { agentId: 'a2', status: 'done', endedAt: T0 + 2, stuck: undefined }
    );
    expect(h.alerts.list()).toEqual([]);
    // Over: the same facts are not replayed later.
    h.setQuiet(false);
    h.set({ agentId: 'a1', status: 'failed', endedAt: T0 + 1 });
    expect(h.alerts.list()).toEqual([]);
  });

  it('nested agents form their own group; non-Companion sessions make no items', () => {
    jest.useFakeTimers();
    const h = harness({ settleMs: 0 });
    h.set(
      { agentId: 'p' },
      { agentId: 'c1', parentAgentId: 'p' },
      { agentId: 'c2', parentAgentId: 'p' }
    );
    h.set(
      { agentId: 'c1', status: 'done', endedAt: T0 + 1 },
      { agentId: 'c2', status: 'done', endedAt: T0 + 2 }
    );
    expect(h.alerts.list()).toEqual([
      expect.objectContaining({ kind: 'group_done', agentIds: ['c1', 'c2'] }),
    ]);
    h.set({ agentId: 'p', status: 'done', endedAt: T0 + 3 });
    // The top-level group is just `p`: below minGroup.
    expect(h.alerts.list()).toHaveLength(1);

    const u = harness({ settleMs: 0, label: false });
    u.set({ agentId: 'a1' }, { agentId: 'a2' });
    u.set(
      { agentId: 'a1', status: 'failed', endedAt: T0 + 1 },
      { agentId: 'a2', status: 'done', endedAt: T0 + 2 }
    );
    expect(u.alerts.list()).toEqual([]);
  });

  it('end to end with the tracker: two agents, notifications -> one group item; factsFor reads the same state', async () => {
    const env = tmpProjects();
    try {
      let now = T0;
      const tracker = new SubagentTracker({ now: () => now, passDelayMs: 1_000_000 });
      const out: SubagentAlert[][] = [];
      const alerts = new SubagentAlerts({
        summary: (id) => {
          const r = tracker.get(id);
          return r ? tracker.summary(r) : undefined;
        },
        label: (conv) => (conv === CONV ? { sessionId: 'out4', sessionName: 'Out4' } : null),
        publish: (l) => out.push(l),
        now: () => now,
        settleMs: 0,
      });
      tracker.on('changed', (ids: string[], removed: string[]) => alerts.onChanged(ids, removed));
      const ids = ['a1111111111111111', 'a2222222222222222'];
      for (const id of ids) {
        fs.writeFileSync(
          agentFile(env.subDir, id),
          prompt(id, T0 + 1000) + text(id, T0 + 2000, `m-${id}`, 'Working on it')
        );
        meta(env.subDir, id, { description: `Job ${id.slice(1, 2)}` });
        tracker.register(agentFile(env.subDir, id), { mtimeMs: T0 + 2000 });
        await tracker.loadMeta(tracker.get(id)!);
      }
      now = T0 + 3000;
      await tracker.pass();
      expect(ids.map((id) => tracker.get(id)!.status)).toEqual(['running', 'running']);
      const deps = {
        watcher: {
          getConversationInfo: () => null,
          getConversationIdsForSession: (k: string) => (k === 'out4' ? [CONV] : []),
          getTmuxSessionForConversation: (c: string) => (c === CONV ? 'out4' : null),
        },
        sessionName: () => 'Out4',
        tracker: () => tracker,
        now: () => now,
      };
      const facts = factsFor(deps, 'out4')!;
      const labels = sessionLabels(deps, [CONV, CONV, 'unknown-conv']);
      expect(labels[CONV]).toMatchObject({ session: 'Out4', sessionId: 'out4' });
      expect(labels['unknown-conv']).toEqual({ session: 'a session in a project' });
      expect(facts.sessions[0]).toMatchObject({
        session: 'Out4',
        sessionId: 'out4',
        running: 2,
        total: 2,
      });
      expect(facts.sessions[0].rollup).toMatch(/^0 of 2 done, 2 running/);
      append(
        env.convPath,
        notification(ids[0], T0 + 5000, 'completed') + notification(ids[1], T0 + 6000, 'failed')
      );
      tracker.markParentDirty(env.convPath);
      now = T0 + 7000;
      for (let i = 0; i < 5; i++) await tracker.pass();
      const list = alerts.list();
      expect(list.map((a) => a.kind).sort()).toEqual(['failed', 'group_done']);
      expect(list.find((a) => a.kind === 'group_done')!.headline).toBe(
        '2 agents done in Out4: 1 finished, 1 failed'
      );
      alerts.dispose();
      tracker.stop();
    } finally {
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  });
});
