import { describe, it, expect } from 'vitest';
import type { ConversationHighlight, SessionStatus, ToolCall } from '../../types';
import {
  buildStatusLine,
  commandLabel,
  endingQuestion,
  formatDuration,
  formatElapsed,
  pickTurn,
  recentSteps,
  shortPath,
  throttleLine,
  toolLabel,
  turnFromHighlights,
  type StatusLine,
} from '../sessionStatusLine';

let id = 0;
const tool = (name: string, input: Record<string, unknown>, status: ToolCall['status'] = 'completed', extra: Partial<ToolCall> = {}): ToolCall => ({
  id: `t${id++}`, name, input, status, ...extra,
});
const user = (timestamp: number, content = 'go'): ConversationHighlight => ({ id: `u${id++}`, type: 'user', content, timestamp });
const asst = (timestamp: number, toolCalls: ToolCall[] = [], content = ''): ConversationHighlight => ({
  id: `a${id++}`, type: 'assistant', content, timestamp, toolCalls,
});
const working: SessionStatus = { isRunning: true, isWaitingForInput: false, lastActivity: 0, currentActivity: 'Processing...' };
const waiting: SessionStatus = { isRunning: true, isWaitingForInput: true, lastActivity: 0 };
const T0 = 1_000_000_000_000;

describe('durations', () => {
  it('formats elapsed time', () => {
    expect(formatElapsed(42_000)).toBe('42s');
    expect(formatElapsed(252_000)).toBe('4m 12s');
    expect(formatElapsed(4_320_000)).toBe('1h 12m');
    expect(formatElapsed(-5000)).toBe('0s');
  });
  it('formats a finished turn more quietly', () => {
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(360_000)).toBe('6m');
    expect(formatDuration(4_320_000)).toBe('1h 12m');
  });
});

describe('labels', () => {
  it('says what a command does, cut short', () => {
    expect(commandLabel('npm test')).toBe('Running tests');
    expect(commandLabel('cd web && NODE_ENV=x npx vitest run foo')).toBe('Running tests');
    expect(commandLabel('source ~/.nvm/nvm.sh; bin/test')).toBe('Running tests');
    expect(commandLabel('npx tsc --noEmit')).toBe('Type checking');
    expect(commandLabel('npm run build')).toBe('Building');
    expect(commandLabel('git status\necho x')).toBe('Running git status');
    const long = commandLabel(`grep -r ${'x'.repeat(100)}`);
    expect(long.length).toBeLessThan(55);
    expect(long.endsWith('…')).toBe(true);
    expect(commandLabel('')).toBe('Running a command');
  });
  it('shortens paths', () => {
    expect(shortPath('/p/src/game/physics.ts', '/p')).toBe('src/game/physics.ts');
    expect(shortPath('/other/player.ts', '/p')).toBe('player.ts');
    expect(shortPath('/p/player.ts')).toBe('player.ts');
    expect(shortPath(`/p/${'d/'.repeat(30)}x.ts`, '/p')).toBe('x.ts');
  });
  it('words Claude tools', () => {
    expect(toolLabel(tool('Edit', { file_path: '/p/src/a.ts' }), '/p')).toBe('Editing src/a.ts');
    expect(toolLabel(tool('Read', { file_path: '/x/player.ts' }))).toBe('Reading player.ts');
    expect(toolLabel(tool('Grep', { pattern: 'foo' }))).toBe('Searching for foo');
    expect(toolLabel(tool('WebFetch', { url: 'https://a.dev/b' }))).toBe('Fetching a.dev');
    expect(toolLabel(tool('Task', { description: 'Audit logs' }))).toBe('Agent: Audit logs');
    expect(toolLabel(tool('mcp__srv__do_thing', {}))).toBe('Using do_thing');
    expect(toolLabel(tool('Mystery', {}))).toBe('Using Mystery');
  });
  it('words Codex tools the same way', () => {
    expect(toolLabel(tool('exec_command', { command: 'cargo test' }))).toBe('Running tests');
    expect(toolLabel(tool('apply_patch', { files: ['/p/a.ts'] }), '/p')).toBe('Editing a.ts');
    expect(toolLabel(tool('apply_patch', { files: ['a.ts', 'b.ts', 'c.ts'] }))).toBe('Editing a.ts +2');
    expect(toolLabel(tool('update_plan', {}))).toBe('Updating the plan');
    expect(toolLabel(tool('web_search', { query: 'x' }))).toBe('Searching the web');
  });
});

describe('endingQuestion', () => {
  it('finds only a real closing question', () => {
    expect(endingQuestion('Done the work.\n\nShould I **deploy** it?')).toBe('Should I deploy it?');
    expect(endingQuestion('All fixed. Want me to commit?')).toBe('Want me to commit?');
    expect(endingQuestion('Is this ok? I went ahead.')).toBeNull();
    expect(endingQuestion('')).toBeNull();
  });
});

describe('buildStatusLine: working', () => {
  it('matches the agreed design', () => {
    const calls = Array.from({ length: 22 }, () => tool('Read', { file_path: '/p/a.ts' }));
    const line = buildStatusLine({
      status: working,
      highlights: [user(T0), asst(T0 + 1000, calls), asst(T0 + 2000, [tool('Edit', { file_path: '/p/src/game/physics.ts' }, 'running')])],
      runningAgents: 2,
      projectPath: '/p',
      now: T0 + 252_000,
    });
    expect(line).toEqual({ phase: 'working', activity: 'Editing src/game/physics.ts', meta: ['4m 12s', '23 tools', '2 agents'] });
  });
  it('leaves out empty fields', () => {
    const line = buildStatusLine({ status: working, highlights: [user(T0)], now: T0 + 5000 });
    expect(line).toEqual({ phase: 'working', activity: 'Thinking', meta: ['5s'] });
  });
  it('shows files changed, in the singular too', () => {
    const line = buildStatusLine({ status: working, highlights: [user(T0), asst(T0, [tool('Write', { file_path: '/a' })])], now: T0 });
    expect(line?.meta).toEqual(['0s', '1 tool', '1 file']);
  });
  it('thinks between tools', () => {
    const line = buildStatusLine({ status: working, highlights: [user(T0), asst(T0, [tool('Read', {})])], now: T0 });
    expect(line?.activity).toBe('Thinking');
  });
  it('uses the daemon totals when the turn starts before the loaded page', () => {
    const line = buildStatusLine({
      status: working,
      highlights: [asst(T0 + 100_000, [tool('Bash', { command: 'npm test' }, 'running')])],
      turn: { startedAt: T0, endedAt: T0 + 100_000, tools: 57, files: 4 },
      now: T0 + 120_000,
    });
    expect(line).toEqual({ phase: 'working', activity: 'Running tests', meta: ['2m 0s', '57 tools', '4 files'] });
  });
  it('omits time and counts when the start of the turn is unknown', () => {
    const line = buildStatusLine({ status: working, highlights: [asst(T0, [tool('Read', { file_path: '/a.ts' }, 'running')])], now: T0 });
    expect(line).toEqual({ phase: 'working', activity: 'Reading a.ts', meta: [] });
  });
  it('a Codex session reads the same', () => {
    const line = buildStatusLine({
      status: { ...working, currentActivity: 'Running: pytest' },
      highlights: [user(T0), asst(T0 + 1000, [tool('apply_patch', { files: ['/p/a.py', '/p/b.py'] })]), asst(T0 + 2000, [tool('exec_command', { command: 'pytest -q' }, 'running')])],
      projectPath: '/p',
      now: T0 + 60_000,
    });
    expect(line).toEqual({ phase: 'working', activity: 'Running tests', meta: ['1m 0s', '2 tools', '2 files'] });
  });
  it('falls back to the daemon text with no messages, never its placeholders', () => {
    expect(buildStatusLine({ status: { ...working, currentActivity: 'Reading file' }, now: T0 })?.activity).toBe('Reading file');
    expect(buildStatusLine({ status: { ...working, currentActivity: 'Working...' }, now: T0 })?.activity).toBe('Thinking');
  });
  it('shows nothing with no activity or status', () => {
    expect(buildStatusLine({ status: { ...working, currentActivity: undefined }, now: T0 })).toBeNull();
    expect(buildStatusLine({ status: null, now: T0 })).toBeNull();
  });
});

describe('buildStatusLine: finished', () => {
  it('done, quietly', () => {
    const line = buildStatusLine({
      status: waiting,
      highlights: [user(T0), asst(T0 + 1000, [tool('Edit', { file_path: '/a' }), tool('Edit', { file_path: '/b' }), tool('Write', { file_path: '/c' })]), asst(T0 + 360_000, [], 'All finished.')],
      now: T0 + 9_000_000,
    });
    expect(line).toEqual({ phase: 'done', activity: 'Done', meta: ['6m', '3 files changed'] });
  });
  it('done with nothing changed leaves the field out', () => {
    const line = buildStatusLine({ status: waiting, highlights: [user(T0), asst(T0 + 5000, [], 'Hi.')], now: T0 + 60_000 });
    expect(line).toEqual({ phase: 'done', activity: 'Done', meta: ['5s'] });
  });
  it('a closing question waits on you', () => {
    const line = buildStatusLine({ status: waiting, highlights: [user(T0), asst(T0 + 5000, [], 'Tests pass.\n\nShall I commit?')], now: T0 });
    expect(line).toEqual({ phase: 'waiting', activity: 'Waiting on you: Shall I commit?', meta: [] });
  });
  it('a choice box waits on you, even while reading as working', () => {
    const box: ConversationHighlight = {
      ...asst(T0, [], 'Pick'), isWaitingForChoice: true,
      questions: [{ question: 'Which DB?', header: '', options: [], multiSelect: false }],
    };
    expect(buildStatusLine({ status: working, highlights: [user(T0), box], now: T0 })?.activity).toBe('Waiting on you: Which DB?');
  });
  it('approvals wait on you', () => {
    expect(buildStatusLine({ status: { ...waiting, currentActivity: 'Approve? rm -rf x' }, now: T0 })?.activity).toBe('Waiting on you: Approve? rm -rf x');
    expect(buildStatusLine({ status: { ...waiting, currentActivity: 'Waiting for approval' }, now: T0 })?.activity).toBe('Waiting on you: approval');
    const line = buildStatusLine({ status: waiting, highlights: [user(T0), asst(T0, [tool('Bash', { command: 'npm test' }, 'pending')])], now: T0 });
    expect(line?.activity).toBe('Waiting on you: Approve: Running tests');
  });
  it('a new session just waits for input', () => {
    expect(buildStatusLine({ status: waiting, highlights: [], now: T0 })).toEqual({ phase: 'waiting', activity: 'Waiting for input', meta: [] });
    expect(buildStatusLine({ status: waiting, now: T0 })?.activity).toBe('Waiting for input');
  });
  it('keeps the background-work state', () => {
    const line = buildStatusLine({
      status: { ...working, backgroundWork: { agents: 2, shells: 1 } },
      highlights: [user(T0), asst(T0, [], 'ok')],
      now: T0 + 30_000,
    });
    expect(line).toEqual({ phase: 'background', activity: 'Agents working · 2 running · 1 shell', meta: ['30s'] });
  });
});

describe('turn bookkeeping', () => {
  it('a just-sent message starts a new turn over older daemon totals', () => {
    const old = { startedAt: T0, endedAt: T0 + 5, tools: 9, files: 2 };
    const local = turnFromHighlights([user(T0 + 100)]);
    expect(pickTurn(local, old)?.startedAt).toBe(T0 + 100);
    expect(pickTurn(local, old)?.tools).toBe(0);
  });
  it('same turn takes the higher count; the older side loses', () => {
    const a = { startedAt: T0, endedAt: 5, tools: 3, files: 3 };
    const b = { startedAt: T0, endedAt: 9, tools: 7, files: 1 };
    expect(pickTurn(a, b)).toEqual({ startedAt: T0, endedAt: 9, tools: 7, files: 3 });
    expect(pickTurn(undefined, b)).toBe(b);
    expect(pickTurn(a, null)).toBe(a);
  });
  it('recent steps: last 5 of this turn, oldest first', () => {
    const calls = ['a', 'b', 'c', 'd', 'e', 'f'].map((f) => tool('Read', { file_path: `/${f}` }));
    const steps = recentSteps([user(T0 - 9), asst(T0 - 8, [tool('Read', { file_path: '/old' })]), user(T0), asst(T0 + 1, calls)]);
    expect(steps.map((s) => s.label)).toEqual(['Reading b', 'Reading c', 'Reading d', 'Reading e', 'Reading f']);
    expect(recentSteps([user(T0), asst(T0 - 8, [tool('Read', {})]), user(T0 + 1)])).toEqual([]);
  });
  it('recent steps carry failure and duration', () => {
    const [ok, bad] = recentSteps([user(T0), asst(T0, [
      tool('Read', {}, 'completed', { startedAt: 1000, completedAt: 3000 }),
      tool('Bash', { command: 'false' }, 'completed', { isError: true }),
    ])]);
    expect(ok.durationMs).toBe(2000);
    expect(bad.status).toBe('error');
  });
});

describe('throttleLine', () => {
  const w = (activity: string): StatusLine => ({ phase: 'working', activity, meta: [] });
  it('holds fast changes for about a second, then takes the newest', () => {
    let s = throttleLine(null, 'k', w('a'), 0);
    s = throttleLine(s, 'k', w('b'), 100);
    s = throttleLine(s, 'k', w('c'), 900);
    expect(s.line?.activity).toBe('a');
    s = throttleLine(s, 'k', w('c'), 1000);
    expect(s.line?.activity).toBe('c');
    expect(s.at).toBe(1000);
  });
  it('a phase change or another session shows at once', () => {
    const s = throttleLine(null, 'k', w('a'), 0);
    const done: StatusLine = { phase: 'done', activity: 'Done', meta: [] };
    expect(throttleLine(s, 'k', done, 10).line).toBe(done);
    expect(throttleLine(s, 'other', w('b'), 10).line?.activity).toBe('b');
    expect(throttleLine(s, 'k', null, 10).line).toBeNull();
  });
  it('never holds a finished state', () => {
    const d = (a: string): StatusLine => ({ phase: 'waiting', activity: a, meta: [] });
    const s = throttleLine(null, 'k', d('x'), 0);
    expect(throttleLine(s, 'k', d('y'), 10).line?.activity).toBe('y');
  });
});
