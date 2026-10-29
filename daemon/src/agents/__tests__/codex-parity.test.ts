/**
 * Codex parity bits outside review / stuck: error events -> turn errors,
 * compaction markers + events, task_complete's final message, Herald phrases.
 */
import { CodexAccumulator, CODEX_ERROR_ID_PREFIX } from '../codex/parse';
import { detectTurnEndError, toolKind } from '../../turn-error';
import { plainToolAction } from '../../herald/text';

const T0 = Date.parse('2026-10-28T20:00:00Z');
let t = T0;
const rec = (type: string, payload: Record<string, unknown>) => ({
  timestamp: new Date((t += 1000)).toISOString(),
  type,
  payload,
});
const user = (text: string) =>
  rec('response_item', {
    type: 'message',
    role: 'user',
    id: `u${t}`,
    content: [{ type: 'input_text', text }],
  });
const say = (text: string) =>
  rec('response_item', {
    type: 'message',
    role: 'assistant',
    id: `a${t}`,
    content: [{ type: 'output_text', text }],
  });
const execCall = (id: string, cmd: string) =>
  rec('response_item', {
    type: 'custom_tool_call',
    call_id: id,
    name: 'exec',
    input: `text(await tools.exec_command({cmd:${JSON.stringify(cmd)}}));`,
  });
const execOut = (id: string, exit: number, output: string) =>
  rec('response_item', {
    type: 'custom_tool_call_output',
    call_id: id,
    output: [
      { type: 'input_text', text: 'Script completed\n' },
      { type: 'input_text', text: JSON.stringify({ exit_code: exit, output }) },
    ],
  });

function parse(recs: unknown[]) {
  const acc = new CodexAccumulator();
  acc.append(recs);
  return { acc, messages: acc.messages() };
}

describe('Codex turn errors', () => {
  it('an error event that ends the turn escalates once (keyed by its message)', () => {
    const { messages } = parse([
      rec('event_msg', { type: 'task_started' }),
      user('do it'),
      rec('event_msg', {
        type: 'error',
        message: "You've hit your usage limit. Try again in 2 hours.",
      }),
      rec('event_msg', { type: 'task_complete', last_agent_message: null }),
    ]);
    const last = messages[messages.length - 1];
    expect(last.id.startsWith(CODEX_ERROR_ID_PREFIX)).toBe(true);
    expect(last.content).toMatch(/^Error: You've hit your usage limit/);
    const te = detectTurnEndError(messages)!;
    expect(te.tool).toBe('Codex');
    expect(te.toolId).toBe(last.id);
    expect(te.preview).toMatch(/^Codex: You've hit your usage limit/);
  });

  it('a failing exec_command the turn ended on is a turn error; a later success resolves it', () => {
    const failing = parse([
      rec('event_msg', { type: 'task_started' }),
      user('build'),
      execCall('c1', 'npm run build'),
      execOut('c1', 1, 'error TS2322: bad type'),
      say('The build fails with a type error.'),
      rec('event_msg', { type: 'task_complete' }),
    ]).messages;
    const te = detectTurnEndError(failing)!;
    expect(te.tool).toBe('exec_command');
    expect(te.line).toMatch(/TS2322/);
    const fixed = parse([
      rec('event_msg', { type: 'task_started' }),
      user('build'),
      execCall('c1', 'npm run build'),
      execOut('c1', 1, 'error TS2322: bad type'),
      execCall('c2', 'npm run build'),
      execOut('c2', 0, 'ok'),
      say('Built.'),
      rec('event_msg', { type: 'task_complete' }),
    ]).messages;
    expect(detectTurnEndError(fixed)).toBeNull();
    expect(
      toolKind({
        id: 'x',
        name: 'exec_command',
        input: { command: 'npm run build' },
        status: 'completed',
      })
    ).toBe('Bash:npm run build');
    expect(toolKind({ id: 'x', name: 'apply_patch', input: {}, status: 'completed' })).toBe('edit');
  });
});

describe('Codex compaction + final message', () => {
  it('compacted + context_compacted -> one marker and one compaction event', () => {
    const { acc, messages } = parse([
      rec('event_msg', { type: 'task_started' }),
      user('long job'),
      rec('compacted', { message: 'Summary of earlier work' }),
      rec('event_msg', { type: 'context_compacted' }),
    ]);
    const marks = messages.filter((m) => m.isCompaction);
    expect(marks).toHaveLength(1);
    expect(marks[0].content).toBe('Summary of earlier work');
    const ev = acc.compactionSince(0, 'cdx', 'cdx', '/p');
    expect(ev.event).toMatchObject({ sessionId: 'cdx', summary: 'Summary of earlier work' });
    expect(acc.compactionSince(ev.lastLine, 'cdx', 'cdx', '/p').event).toBeNull();
  });

  it('task_complete adds its last_agent_message only when the final text is missing', () => {
    const missing = parse([
      rec('event_msg', { type: 'task_started' }),
      user('x'),
      rec('event_msg', { type: 'task_complete', last_agent_message: 'All done.' }),
    ]).messages;
    expect(missing[missing.length - 1]).toMatchObject({
      type: 'assistant',
      content: 'All done.',
      stopReason: 'end_turn',
    });
    const present = parse([
      rec('event_msg', { type: 'task_started' }),
      user('x'),
      say('All done.'),
      rec('event_msg', { type: 'task_complete', last_agent_message: 'All done.' }),
    ]).messages;
    expect(present.filter((m) => m.content === 'All done.')).toHaveLength(1);
  });
});

describe('Herald phrases for Codex tools', () => {
  it('reads Codex tools plainly', () => {
    expect(plainToolAction('exec_command')).toBe('run a shell command');
    expect(plainToolAction('apply_patch')).toBe('edit files');
  });
});
