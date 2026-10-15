import * as fs from 'fs';
import * as path from 'path';
import { SubagentTracker } from '../tracker';
import { SubagentDiscovery } from '../discover';
import { SubagentHub } from '../hub';
import { rollupText } from '../rollup';
import type { SubagentSummary, SubagentUpdateEvent } from '../protocol';
import { SubAgentWatcher, resolveSubagentMode } from '../../subagent-watcher';
import {
  T0,
  CONV,
  tmpProjects,
  prompt,
  toolUse,
  text,
  result,
  notification,
  meta,
  agentFile,
  append,
} from './fixtures';

const MIN = 60_000;

async function waitFor(fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

function sum(p: Partial<SubagentSummary>): SubagentSummary {
  return {
    agentId: 'a0',
    sessionId: 'c',
    depth: 1,
    name: 'Agent',
    status: 'running',
    startedAt: T0,
    lastEntryAt: T0 + 4 * MIN,
    toolCalls: 0,
    edits: 0,
    filesTouched: 0,
    tokens: 0,
    recent: [],
    version: 1,
    ...p,
  };
}

describe('rollupText', () => {
  const now = T0 + 4 * MIN;
  it('golden cases', () => {
    expect(rollupText([], now)).toBe('No subagents.');
    expect(
      rollupText(
        [
          sum({
            agentId: '1',
            name: 'Bob',
            pendingTool: 'Bash',
            pendingSince: now - 20_000,
            activity: 'Bash: npx jest api',
            tests: { runs: 3, failed: 2, lastFailed: true, lastAt: now },
          }),
          sum({
            agentId: '2',
            name: 'Ann',
            pendingTool: 'Bash',
            pendingSince: now - 6 * MIN,
            activity: 'Bash: sleep 999',
            lastEntryAt: now - 6 * MIN,
          }),
          sum({ agentId: '3', name: 'Cy', status: 'done', endedAt: T0 + MIN }),
          sum({ agentId: '4', name: 'Di', status: 'done', endedAt: T0 + MIN }),
          sum({ agentId: '5', name: 'Ed', status: 'done', endedAt: T0 + MIN }),
        ],
        now
      )
    ).toBe(
      '3 of 5 done, 2 running. Bob is running tests (2 failing runs, 4 min). Ann is idle 6 min on a Bash call (4 min).'
    );
    expect(rollupText([sum({ name: 'Solo', status: 'failed', endedAt: T0 + 2 * MIN })], now)).toBe(
      'Solo failed after 2 min.'
    );
    expect(
      rollupText(
        [
          sum({ agentId: '1', name: 'A', status: 'done', endedAt: T0 + MIN }),
          sum({ agentId: '2', name: 'B', status: 'failed', endedAt: T0 + MIN }),
        ],
        now
      )
    ).toBe('All 2 finished, 1 failed. B failed after 1 min.');
    expect(
      rollupText(
        [
          sum({
            agentId: '1',
            name: 'Loopy',
            stuck: {
              kind: 'loop',
              severity: 'medium',
              headline: 'repeating the same command 6 times',
              summary: '',
              since: T0,
            },
          }),
          sum({ agentId: '2', name: 'Fine', checklist: { done: 1, total: 4, source: 'steps' } }),
        ],
        now
      )
    ).toBe(
      '0 of 2 done, 2 running. Loopy looks stuck: repeating the same command 6 times (4 min). Fine is working (step 2/4, 4 min).'
    );
  });
});

describe('SubagentHub', () => {
  it('coalesces bursts to one event per second per watcher, only to watchers, filtered by session', () => {
    jest.useFakeTimers();
    let now = 1000;
    const sent: Array<{ id: string; p: SubagentUpdateEvent }> = [];
    const hub = new SubagentHub({
      summary: (id) => sum({ agentId: id, sessionId: id.startsWith('x') ? 'convX' : 'convY' }),
      resolve: (k) => (k === 'tmuxX' ? ['convX'] : k ? [k] : null),
      send: (id, p) => {
        sent.push({ id, p });
        return true;
      },
      now: () => now,
    });
    hub.onChanged(['x1']); // nobody watching: nothing
    hub.watch('c1', 'tmuxX', true);
    hub.watch('c2', null, true);
    for (let i = 0; i < 10; i++) hub.onChanged([`x${i % 3}`, 'y1']);
    jest.advanceTimersByTime(0);
    expect(sent.filter((s) => s.id === 'c1')).toHaveLength(1);
    expect(
      sent
        .find((s) => s.id === 'c1')!
        .p.agents.map((a) => a.agentId)
        .sort()
    ).toEqual(['x0', 'x1', 'x2']);
    expect(sent.find((s) => s.id === 'c1')!.p.sessionId).toBe('tmuxX');
    expect(sent.find((s) => s.id === 'c2')!.p.agents).toHaveLength(4);
    for (let i = 0; i < 10; i++) hub.onChanged(['x1']);
    jest.advanceTimersByTime(500);
    expect(sent).toHaveLength(2);
    now += 1000;
    jest.advanceTimersByTime(600);
    expect(sent).toHaveLength(4);
    hub.watch('c1', 'tmuxX', false);
    hub.onChanged(['x1']);
    now += 2000;
    jest.advanceTimersByTime(2000);
    expect(sent.filter((s) => s.id === 'c1')).toHaveLength(2);
    jest.useRealTimers();
  });

  it('drops a client whose socket is gone', () => {
    jest.useFakeTimers();
    const hub = new SubagentHub({
      summary: (id) => sum({ agentId: id }),
      resolve: () => null,
      send: () => false,
    });
    hub.watch('c1', null, true);
    hub.onChanged(['a']);
    jest.advanceTimersByTime(10);
    expect(hub.watcherCount).toBe(0);
    jest.useRealTimers();
  });
});

describe('SubagentDiscovery (real fs.watch)', () => {
  it('finds an agent dir created after the conversation, follows appends; startup skips old conversations', async () => {
    const { root, proj } = tmpProjects();
    fs.rmSync(path.join(proj, CONV), { recursive: true });
    // An old conversation with an agent: not loaded at startup.
    const oldConv = '00000000-1111-2222-3333-444444444444';
    const oldSub = path.join(proj, oldConv, 'subagents');
    fs.mkdirSync(oldSub, { recursive: true });
    fs.writeFileSync(path.join(proj, `${oldConv}.jsonl`), '');
    fs.writeFileSync(agentFile(oldSub, 'a0000000000000old'), prompt('a0000000000000old', T0));
    const past = (Date.now() - 48 * 60 * MIN) / 1000;
    fs.utimesSync(path.join(proj, `${oldConv}.jsonl`), past, past);
    fs.utimesSync(agentFile(oldSub, 'a0000000000000old'), past, past);

    const tracker = new SubagentTracker({ passDelayMs: 20 });
    const disc = new SubagentDiscovery(path.join(root, ''), tracker);
    await disc.start();
    expect(tracker.agents.size).toBe(0);
    const conv = path.join(proj, `${CONV}.jsonl`);
    append(conv, '{"type":"user"}\n');
    const sub = path.join(proj, CONV, 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    const id = 'a1230000000000001';
    fs.writeFileSync(agentFile(sub, id), prompt(id, Date.now()));
    meta(sub, id, { description: 'Watch me', toolUseId: 'toolu_w' });
    // The conversation's next write makes discovery look for the subagents dir.
    await new Promise((r) => setTimeout(r, 2100));
    append(conv, '{"type":"user"}\n');
    await waitFor(() => !!tracker.get(id));
    await waitFor(() => tracker.get(id)!.entries === 1);
    append(agentFile(sub, id), toolUse(id, Date.now(), 'm', 't1', 'Bash', { command: 'ls' }));
    await waitFor(() => tracker.get(id)!.pendingCount === 1);
    append(conv, notification(id, Date.now() + 5000));
    append(
      agentFile(sub, id),
      result(id, Date.now(), 't1', 'ok') + text(id, Date.now(), 'm2', 'fin', 'end_turn')
    );
    await waitFor(() => tracker.get(id)!.status === 'done');
    expect(tracker.summary(tracker.get(id)!).name).toBe('Watch me');
    expect(tracker.get('a0000000000000old')).toBeUndefined();
    expect(disc.watchCounts().conversations).toBe(1);
    disc.stop();
    tracker.stop();
  }, 15000);
});

describe('SubAgentWatcher facade', () => {
  it('mode switch', () => {
    expect(resolveSubagentMode(undefined, {})).toBe('watch');
    expect(resolveSubagentMode('legacy', {})).toBe('legacy');
    expect(resolveSubagentMode('watch', { COMPANION_SUBAGENTS: 'legacy' })).toBe('legacy');
  });

  it('keeps the legacy get_agent_tree / get_agent_detail shapes (fields only added)', async () => {
    const { root, subDir, convPath } = tmpProjects();
    const w = new SubAgentWatcher(root, { mode: 'watch' });
    const t = w.tracker!;
    const a = 'a7770000000000001';
    const b = 'a7770000000000002';
    const now = Date.now();
    fs.writeFileSync(
      agentFile(subDir, a),
      prompt(a, now - 1000) +
        text(a, now - 900, 'm', 'Looking at it.') +
        toolUse(a, now - 800, 'm', 't', 'Bash', { command: 'npm test' })
    );
    fs.writeFileSync(
      agentFile(subDir, b),
      prompt(b, now - 1000) + text(b, now - 900, 'm', 'Result text.', 'end_turn')
    );
    append(convPath, notification(b, now - 500, 'failed'));
    t.register(agentFile(subDir, a), { mtimeMs: now });
    t.register(agentFile(subDir, b), { mtimeMs: now });
    await t.pass();
    await t.pass();
    const tree = w.getAgentTree([CONV]);
    expect(tree.totalAgents).toBe(2);
    expect(tree.runningCount).toBe(1);
    const ra = tree.agents.find((x) => x.agentId === a)!;
    expect(ra).toMatchObject({ status: 'running', state: 'running', sessionId: CONV, depth: 1 });
    expect(ra.currentActivity).toBe('Bash: npm test');
    expect(typeof ra.messageCount).toBe('number');
    expect(tree.agents.find((x) => x.agentId === b)).toMatchObject({
      status: 'error',
      state: 'failed',
    });
    expect(w.getAgentTree(['other-conv']).totalAgents).toBe(0);
    const detail = await w.getAgentDetail(a);
    expect(detail!.agent.agentId).toBe(a);
    expect(detail!.highlights.length).toBeGreaterThan(0);
    expect(await w.getAgentDetail('nope')).toBeNull();
    const list = w.listSummaries([CONV]);
    expect(list.running).toBe(1);
    expect(list.rollup).toMatch(/^0 of 2 done, 1 running, 1 failed\./);
    w.stop();
  });

  it('off mode answers empty', async () => {
    const w = new SubAgentWatcher('/nonexistent', { mode: 'off' });
    w.start();
    expect(w.getAgentTree().totalAgents).toBe(0);
    expect(await w.getAgentDetail('x')).toBeNull();
    w.stop();
  });

  it('a meta for the agent dir is honoured (meta helper sanity)', () => {
    const { subDir } = tmpProjects();
    meta(subDir, 'ax', { agentType: 'Plan' });
    expect(
      JSON.parse(fs.readFileSync(path.join(subDir, 'agent-ax.meta.json'), 'utf-8')).agentType
    ).toBe('Plan');
  });
});
