import { describe, expect, it } from 'vitest';
import { InboxChimeTracker } from '../heraldSpeech';
import { toneKindOf } from '../tonePolicy';
import type { HeraldInboxItem } from '../../../types/herald';

const item = (id: string, kind: 'group_done' | 'failed' | 'stuck'): HeraldInboxItem => ({
  id,
  serverId: 's',
  sessionId: 'out4',
  sessionName: 'Out4',
  priority: 'finished',
  headline: 'h',
  createdAt: 1,
  heard: false,
  subagents: { kind, agentIds: ['a1'], names: ['Bob'], total: 1, failed: kind === 'failed' ? 1 : 0 },
});

describe('subagent inbox tones', () => {
  it('group done = finished, failed = error, stuck = the stuck tone', () => {
    expect(toneKindOf(item('g', 'group_done'))).toBe('finished');
    expect(toneKindOf(item('f', 'failed'))).toBe('error');
    expect(toneKindOf(item('s', 'stuck'))).toBe('stuck');
  });

  it('a stuck agent plays the stuck chime once per item', () => {
    const t = new InboxChimeTracker();
    t.handleEvent({ kind: 'inbox', inbox: [] }, 'push');
    expect(t.handleEvent({ kind: 'inbox', inbox: [item('s', 'stuck')] }, 'push')).toBe('stuck');
    expect(t.handleEvent({ kind: 'inbox', inbox: [item('s', 'stuck')] }, 'push')).toBeNull();
    expect(t.handleEvent({ kind: 'inbox', inbox: [item('g', 'group_done')] }, 'push')).toBe('finished');
  });
});
