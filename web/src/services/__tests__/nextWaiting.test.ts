import { describe, expect, it } from 'vitest';
import type { ServerSummary, SessionSummary } from '../../types';
import { waitingSessions, nextWaiting } from '../nextWaiting';

const s = (p: Partial<SessionSummary> & { id: string }): SessionSummary => ({
  name: p.id, projectPath: `/p/${p.id}`, status: 'idle', lastActivity: 1000, ...p,
});
const server = (sessions: SessionSummary[]): ServerSummary => ({
  sessions, totalSessions: sessions.length,
  waitingCount: sessions.filter((x) => x.status === 'waiting').length, workingCount: 0,
});

describe('nextWaiting', () => {
  const summaries = new Map<string, ServerSummary>([
    ['a', server([
      s({ id: 'a1', status: 'waiting', waitingSince: 300 }),
      s({ id: 'a2', status: 'working' }),
      s({ id: 'a3', status: 'waiting', waitingSince: 100 }),
    ])],
    ['b', server([
      s({ id: 'b1', status: 'waiting', waitingSince: 200, friendlyName: 'Bee' }),
      s({ id: 'b2', status: 'idle' }),
    ])],
  ]);

  it('lists waiting sessions on all servers, oldest waitingSince first', () => {
    expect(waitingSessions(summaries).map((w) => w.sessionId)).toEqual(['a3', 'b1', 'a1']);
    expect(waitingSessions(summaries)[1]).toMatchObject({ serverId: 'b', name: 'Bee', waitingSince: 200 });
  });

  it('skips the current session', () => {
    expect(waitingSessions(summaries, { serverId: 'a', sessionId: 'a3' }).map((w) => w.sessionId)).toEqual(['b1', 'a1']);
    expect(nextWaiting(summaries, { serverId: 'a', sessionId: 'a3' })?.sessionId).toBe('b1');
  });

  it('same session id on another server is not the current one', () => {
    const m = new Map([['x', server([s({ id: 'same', status: 'waiting', waitingSince: 1 })])]]);
    expect(nextWaiting(m, { serverId: 'y', sessionId: 'same' })?.serverId).toBe('x');
  });

  it('falls back to lastActivity when waitingSince is absent (older daemons), and sorts those after timed ones', () => {
    const m = new Map([['x', server([
      s({ id: 'late', status: 'waiting', lastActivity: 900 }),
      s({ id: 'early', status: 'waiting', lastActivity: 100 }),
      s({ id: 'timed', status: 'waiting', waitingSince: 500 }),
    ])]]);
    expect(waitingSessions(m).map((w) => w.sessionId)).toEqual(['early', 'timed', 'late']);
  });

  it('ignores inactive sessions and returns null when nothing waits', () => {
    const m = new Map([['x', server([s({ id: 'gone', status: 'waiting', inactive: true }), s({ id: 'w', status: 'working' })])]]);
    expect(waitingSessions(m)).toEqual([]);
    expect(nextWaiting(m)).toBeNull();
  });

  it('counts only sessions that need the user, not ones that are done', () => {
    const m = new Map([['x', server([
      s({ id: 'asks', status: 'waiting', attention: 'needs_you', waitingSince: 300 }),
      s({ id: 'done', status: 'waiting', attention: 'done', waitingSince: 100 }),
      s({ id: 'old', status: 'waiting', waitingSince: 200 }),
    ])]]);
    expect(waitingSessions(m).map((w) => w.sessionId)).toEqual(['old', 'asks']);
    expect(nextWaiting(m)?.sessionId).toBe('old');
  });
});
