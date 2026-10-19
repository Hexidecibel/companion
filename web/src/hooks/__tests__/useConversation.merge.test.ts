import { describe, it, expect } from 'vitest';
import { mergeTail } from '../useConversation';
import type { ConversationHighlight } from '../../types';

const h = (id: string, content = id, extra: Partial<ConversationHighlight> = {}): ConversationHighlight => ({
  id, type: 'assistant', content, timestamp: 1, isWaitingForChoice: false, ...extra,
});
// Fresh objects with the same data, as a refetch returns them.
const clone = (list: ConversationHighlight[]) => list.map((x) => JSON.parse(JSON.stringify(x)) as ConversationHighlight);

describe('mergeTail (useConversation merge by stable id)', () => {
  it('returns prev itself when a refetch is identical', () => {
    const prev = [h('a'), h('b'), h('c')];
    expect(mergeTail(prev, clone(prev))).toBe(prev);
  });

  it('keeps object identity for unchanged messages and appends new ones', () => {
    const prev = [h('a'), h('b'), h('c')];
    const next = mergeTail(prev, [...clone(prev).slice(1), h('d')])!;
    expect(next.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(next[0]).toBe(prev[0]); // older, outside the tail: kept
    expect(next[1]).toBe(prev[1]);
    expect(next[2]).toBe(prev[2]);
  });

  it('replaces only the message that changed', () => {
    const prev = [h('a'), h('b'), h('c', 'streaming')];
    const next = mergeTail(prev, [h('b'), h('c', 'streaming done')])!;
    expect(next[0]).toBe(prev[0]);
    expect(next[1]).toBe(prev[1]);
    expect(next[2]).not.toBe(prev[2]);
    expect(next[2].content).toBe('streaming done');
  });

  it('notices changes highlightEqual alone would miss (tool call details)', () => {
    const prev = [h('a', 'x', { toolCalls: [{ id: 't', name: 'Bash', input: {}, status: 'completed', output: 'one' }] as never })];
    const next = mergeTail(prev, [h('a', 'x', { toolCalls: [{ id: 't', name: 'Bash', input: {}, status: 'completed', output: 'two' }] as never })])!;
    expect(next).not.toBe(prev);
  });

  it('keeps older loaded pages when a reconnect refetches only the tail', () => {
    const prev = Array.from({ length: 120 }, (_, i) => h(`m${i}`));
    const tail = clone(prev.slice(70));
    const next = mergeTail(prev, tail)!;
    expect(next).toBe(prev);
  });

  it('reports a gap (null) when the tail does not overlap at all', () => {
    expect(mergeTail([h('a'), h('b')], [h('x'), h('y')])).toBeNull();
  });

  it('accepts a wider page that starts before the current list', () => {
    const prev = [h('c'), h('d')];
    const next = mergeTail(prev, [h('a'), h('b'), ...clone(prev)])!;
    expect(next.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(next[2]).toBe(prev[0]);
  });
});
