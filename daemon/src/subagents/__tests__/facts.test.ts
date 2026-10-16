import { buildFacts, projectLabelOf } from '../facts';
import type { SubagentSummary } from '../protocol';

const T0 = Date.parse('2026-10-14T10:00:00.000Z');
const MIN = 60_000;

function sum(p: Partial<SubagentSummary>): SubagentSummary {
  return {
    agentId: 'a0',
    sessionId: 'c1',
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

const label = (c: string) =>
  c === 'c1' ? { session: 'Out4', sessionId: 'out4' } : { session: 'a session in app' };

describe('subagent facts', () => {
  const now = T0 + 10 * MIN;

  it('groups per conversation, active (stuck first) before finished, with deterministic lines', () => {
    const f = buildFacts(
      [
        sum({
          agentId: 'd',
          name: 'Docs',
          status: 'done',
          endedAt: T0 + 5 * MIN,
          notifySummary: 'Agent "Docs" completed',
        }),
        sum({
          agentId: 'r',
          name: 'Runner',
          pendingTool: 'Bash',
          pendingSince: now - 30_000,
          activity: 'npx jest',
          lastEntryAt: now - 30_000,
          tests: { runs: 3, failed: 2, lastFailed: true, lastAt: now },
        }),
        sum({
          agentId: 's',
          name: 'Looper',
          lastEntryAt: now - MIN,
          stuck: {
            kind: 'loop',
            severity: 'medium',
            headline: 'same command 5 times',
            summary: 'x',
            since: now - MIN,
          },
          checklist: { done: 2, total: 5, source: 'steps' },
        }),
        sum({
          agentId: 'o',
          sessionId: 'c2',
          name: 'Other',
          status: 'failed',
          endedAt: T0 + 9 * MIN,
        }),
      ],
      now,
      { label }
    );
    expect(f.running).toBe(2);
    expect(f.total).toBe(4);
    expect(f.sessions.map((s) => s.session)).toEqual(['Out4', 'a session in app']);
    const out4 = f.sessions[0];
    expect(out4).toMatchObject({
      sessionId: 'out4',
      conversationId: 'c1',
      running: 2,
      total: 3,
      failed: 0,
      more: 0,
    });
    expect(out4.rollup).toMatch(/^1 of 3 done, 2 running\./);
    expect(out4.agents.map((a) => a.agentId)).toEqual(['s', 'r', 'd']);
    expect(out4.agents[0]).toMatchObject({ stuck: 'same command 5 times', checklist: '2/5' });
    expect(out4.agents[1]).toMatchObject({
      line: expect.stringMatching(/^Runner is running tests \(2 failing runs/),
      tests: { runs: 3, failed: 2, lastFailed: true },
      activity: 'npx jest',
    });
    expect(out4.agents[2]).toMatchObject({
      status: 'done',
      elapsedMs: 5 * MIN,
      summary: 'Agent "Docs" completed',
    });
    expect(out4.agents[2].activity).toBeUndefined();
    expect(f.sessions[1].sessionId).toBeUndefined();
  });

  it('redacts secrets, leaves out old finished agents (fleet view) and applies limits', () => {
    const many = Array.from({ length: 12 }, (_, i) => sum({ agentId: `a${i}`, name: `Job ${i}` }));
    const f = buildFacts(
      [
        ...many,
        sum({
          agentId: 'x',
          name: 'use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 now',
          activity: 'TOKEN=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
        }),
        sum({ agentId: 'old', status: 'done', endedAt: T0 - 5 * 60 * MIN }),
      ],
      T0 + MIN,
      { label, maxAgents: 8 }
    );
    expect(JSON.stringify(f)).not.toContain('sk-ant-api03');
    expect(f.total).toBe(13);
    expect(f.sessions[0].agents).toHaveLength(8);
    expect(f.sessions[0].more).toBe(5);
    // A session filter keeps every retained agent.
    const all = buildFacts(
      [sum({ agentId: 'old', status: 'done', endedAt: T0 - 5 * 60 * MIN })],
      T0,
      { label, finishedWithinMs: 0 }
    );
    expect(all.total).toBe(1);
    expect(buildFacts([], T0, { label }).rollup).toBe('No subagents.');
  });

  it('project labels from the encoded transcript dir', () => {
    expect(projectLabelOf('-home-hexi-local-src-claude-conversation-parser', '/home/hexi')).toBe(
      'claude-conversation-parser'
    );
    expect(projectLabelOf('-home-hexi-notes', '/home/hexi')).toBe('notes');
    expect(projectLabelOf('-srv-app', '/home/hexi')).toBe('srv-app');
  });
});
