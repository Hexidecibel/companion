import { computeTurnStats } from '../turn-stats';
import type { ConversationHighlight, ToolCall } from '../types';

const tool = (name: string, input: Record<string, unknown>, status = 'completed'): ToolCall =>
  ({ id: `${name}-${Math.random()}`, name, input, status }) as ToolCall;
const user = (timestamp: number, content = 'go'): ConversationHighlight =>
  ({ id: `u${timestamp}`, type: 'user', content, timestamp }) as ConversationHighlight;
const asst = (timestamp: number, toolCalls: ToolCall[]): ConversationHighlight =>
  ({
    id: `a${timestamp}`,
    type: 'assistant',
    content: '',
    timestamp,
    toolCalls,
  }) as ConversationHighlight;

describe('computeTurnStats', () => {
  it('counts only since the last user message, files once each', () => {
    const t = computeTurnStats([
      user(1),
      asst(2, [tool('Edit', { file_path: '/old.ts' })]),
      user(10),
      asst(11, [tool('Edit', { file_path: '/a.ts' }), tool('Edit', { file_path: '/a.ts' })]),
      asst(12, [tool('Write', { file_path: '/b.ts' }), tool('Read', { file_path: '/c.ts' })]),
    ]);
    expect(t).toEqual({ startedAt: 10, endedAt: 12, tools: 4, files: 2 });
  });

  it('counts a Codex patch, skips failed and unfinished edits', () => {
    const t = computeTurnStats([
      user(1),
      asst(2, [
        tool('apply_patch', { files: ['a.ts', 'b.ts'] }),
        tool('exec_command', { command: 'ls' }),
        tool('apply_patch', { files: ['c.ts'] }, 'running'),
        { ...tool('Edit', { file_path: '/d.ts' }), isError: true },
      ]),
    ]);
    expect(t).toMatchObject({ tools: 4, files: 2 });
  });

  it('an interrupt marker is not a new turn; no user message = unknown', () => {
    const t = computeTurnStats([user(1), asst(2, []), user(3, '[Request interrupted by user]')]);
    expect(t?.startedAt).toBe(1);
    expect(computeTurnStats([asst(2, [])])).toBeUndefined();
  });
});
