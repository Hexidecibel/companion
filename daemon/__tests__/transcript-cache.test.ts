/**
 * Incremental transcript parsing must give EXACTLY what a full parse gives:
 * parseConversationFile (messages), extractTasks (tasks) and detectCompaction
 * (compaction events with the watcher's lastLine bookkeeping), for every way a
 * file can grow: line by line, split writes mid-line (also mid UTF-8 sequence),
 * many tiny appends, big batches, plus rewrites / truncation / replacement.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseConversationFile,
  extractTasks,
  detectCompaction,
  ConversationAccumulator,
  parseJsonlLines,
} from '../src/parser';
import { TranscriptCache, consumeLines } from '../src/transcript-cache';

let tick = Date.parse('2026-10-15T10:00:00.000Z');
const ts = () => new Date((tick += 1000)).toISOString();
let uid = 0;
const u = () => `u-${++uid}`;

const L = (o: Record<string, unknown>) => JSON.stringify({ timestamp: ts(), uuid: u(), ...o });
const user = (content: unknown) => L({ type: 'user', message: { role: 'user', content } });
const asst = (content: unknown, stop?: string) =>
  L({
    type: 'assistant',
    message: { role: 'assistant', content, ...(stop ? { stop_reason: stop } : {}) },
  });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const toolResult = (id: string, content: unknown, isError = false) =>
  user([{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }]);

/** A transcript exercising every parser feature that depends on other lines. */
function buildTranscript(): string[] {
  return [
    user('Please fix the failing test in api.ts — ünïcödé ✓ 日本語'),
    asst([{ type: 'text', text: 'Looking at it.' }]),
    asst([toolUse('t1', 'Bash', { command: 'npm test -- api' })]),
    toolResult('t1', 'FAIL api.test.ts\n  expected 1, got 2', true),
    asst([toolUse('t2', 'Edit', { file_path: '/x/api.ts', old_string: 'a', new_string: 'b' })]),
    '{"type":"user","message":{"content":"broken json',
    toolResult('t2', [{ type: 'text', text: 'Edited' }]),
    asst([
      toolUse('task1', 'TaskCreate', {
        subject: 'Fix api',
        description: 'd',
        activeForm: 'Fixing api',
      }),
    ]),
    toolResult('task1', 'Task created with ID: 1'),
    asst([toolUse('task2', 'TaskCreate', { subject: 'Ship', description: 'd2' })]),
    toolResult('task2', 'Task created with ID: 2'),
    asst([toolUse('tu1', 'TaskUpdate', { taskId: '1', status: 'in_progress' })]),
    toolResult('tu1', 'ok'),
    '',
    '   ',
    'null',
    '42',
    user(
      '<command-name>/review</command-name><command-message>review</command-message><command-args></command-args>'
    ),
    user('Expanded skill body: review the diff carefully.'),
    asst([{ type: 'text', text: 'Reviewing.' }, toolUse('sk1', 'Skill', { skill: 'commit' })]),
    toolResult('sk1', 'Launching skill'),
    user('Skill expansion text for commit'),
    asst([
      toolUse('q1', 'AskUserQuestion', {
        questions: [
          {
            question: 'Which approach?',
            header: 'Approach',
            options: [
              { label: 'Fast', description: 'quick' },
              { label: 'Safe', description: 'careful' },
            ],
            multiSelect: false,
          },
        ],
      }),
    ]),
    toolResult('q1', 'User answered: Safe'),
    L({ type: 'system', subtype: 'compact_boundary' }),
    user('This session is being continued from a previous conversation. Summary: we fixed api.ts'),
    asst([{ type: 'text', text: 'Continuing.' }], 'end_turn'),
    L({ type: 'summary', summary: 'Legacy summary of earlier work' }),
    asst([toolUse('tu2', 'TaskUpdate', { taskId: '1', status: 'completed' })]),
    toolResult('tu2', 'ok'),
    asst([toolUse('tu3', 'TaskUpdate', { taskId: '2', status: 'deleted' })]),
    L({ type: 'queue-operation', operation: 'enqueue', content: 'x' }),
    user('Pick one:\n\n❯ 1. Yes\n  2. No\n\nEsc to cancel'),
    asst([
      { type: 'text', text: 'Do you want to proceed?\n❯ 1. Yes\n  2. No' },
      toolUse('t3', 'Write', { file_path: '/x/new.ts', content: 'export {}' }),
    ]),
    L({ type: 'system', subtype: 'compact_boundary' }),
    asst([
      toolUse('q2', 'AskUserQuestion', {
        questions: [
          {
            question: 'Deploy now?',
            header: 'Deploy',
            options: [
              { label: 'Yes', description: '' },
              { label: 'No', description: '' },
            ],
          },
          {
            question: 'Which env?',
            header: 'Env',
            options: [
              { label: 'prod', description: '' },
              { label: 'dev', description: '' },
            ],
            multiSelect: true,
          },
        ],
      }),
    ]),
    // A duplicate tool_use id later in the file changes the earlier entry's start time.
    asst([toolUse('t3', 'Write', { file_path: '/x/new.ts', content: 'export {} // again' })]),
    toolResult('t3', 'Wrote file'),
    L({ type: 'system', subtype: 'compact_boundary' }),
  ];
}

/** Silence parser chatter (AUQ / approval logs) during the many full parses. */
let logSpy: jest.SpyInstance;
beforeAll(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterAll(() => logSpy.mockRestore());

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-cache-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function expectEquivalent(
  cache: TranscriptCache,
  file: string,
  lastLines: { inc: number; full: number }
) {
  const snap = cache.getSync(file)!;
  expect(snap).not.toBeNull();
  const content = fs.readFileSync(file, 'utf-8');
  expect(snap.messages()).toEqual(parseConversationFile(file));
  expect(snap.tasks()).toEqual(extractTasks(content));
  // detectCompaction counts a half-written last line as a line (and would then
  // skip it once complete); compare compaction only at line boundaries.
  if (content.length && !content.endsWith('\n')) return;
  const inc = snap.compactionSince(lastLines.inc, 's', 'n', '/p');
  const full = detectCompaction(file, 's', 'n', '/p', lastLines.full, content);
  expect(inc).toEqual(full);
  lastLines.inc = inc.lastLine;
  lastLines.full = full.lastLine;
}

describe('ConversationAccumulator', () => {
  it('equals a full parse for every line-by-line prefix', () => {
    const lines = buildTranscript();
    for (let n = 0; n <= lines.length; n++) {
      const text = lines.slice(0, n).join('\n') + (n ? '\n' : '');
      const acc = new ConversationAccumulator();
      for (let i = 0; i < n; i++) acc.append(parseJsonlLines(lines[i] + '\n'));
      const file = path.join(dir, `p${n}.jsonl`);
      fs.writeFileSync(file, text);
      expect(acc.messages()).toEqual(parseConversationFile(file));
      expect(acc.tasks()).toEqual(extractTasks(text));
    }
  });

  it('marks re-parsed entries: a pending tool becomes completed when its result arrives', () => {
    const acc = new ConversationAccumulator();
    acc.append(parseJsonlLines(asst([toolUse('b1', 'Bash', { command: 'ls' })])));
    expect(acc.messages()[0].toolCalls?.[0].status).toBe('pending');
    expect(acc.messages()[0].isWaitingForChoice).toBe(true);
    acc.append(parseJsonlLines(toolResult('b1', 'file.txt')));
    expect(acc.messages()[0].toolCalls?.[0].status).toBe('completed');
    expect(acc.messages()[0].toolCalls?.[0].output).toBe('file.txt');
    expect(acc.messages()[0].isWaitingForChoice).toBe(false);
  });

  it('a pending AskUserQuestion keeps its options until answered', () => {
    const acc = new ConversationAccumulator();
    const lines = buildTranscript();
    const auqAt = lines.findIndex((l) => l.includes('"q1"') && l.includes('AskUserQuestion'));
    acc.append(parseJsonlLines(lines.slice(0, auqAt + 1).join('\n')));
    const last = acc.messages()[acc.messages().length - 1];
    expect(last.isWaitingForChoice).toBe(true);
    expect(last.questions?.[0].options.map((o) => o.label)).toEqual(['Fast', 'Safe']);
    acc.append(parseJsonlLines(lines[auqAt + 1]));
    const answered = acc.messages().find((m) => m.toolCalls?.some((t) => t.id === 'q1'))!;
    expect(answered.isWaitingForChoice).toBe(false);
    expect(answered.questions).toBeUndefined();
  });

  it('returned messages are copies (callers cannot corrupt the cache)', () => {
    const acc = new ConversationAccumulator();
    acc.append(parseJsonlLines(user('hello there') + '\n' + asst([{ type: 'text', text: 'hi' }])));
    const a = acc.messages();
    a[0].content = 'mutated';
    acc.append(parseJsonlLines(user('another')));
    expect(acc.messages()[0].content).toBe('hello there');
  });
});

describe('consumeLines', () => {
  it('keeps an unterminated partial line for later', () => {
    const r = consumeLines(Buffer.from('{"a":1}\n{"b":'));
    expect(r.used).toBe(8);
    expect(r.entries).toHaveLength(1);
  });
  it('consumes an unterminated line that is already complete JSON', () => {
    const r = consumeLines(Buffer.from('{"a":1}\n{"b":2}'));
    expect(r.used).toBe(15);
    expect(r.entries).toHaveLength(2);
  });
});

describe('TranscriptCache', () => {
  const content = () => buildTranscript().join('\n') + '\n';

  it('split writes at every byte offset (mid-line, mid UTF-8 char) equal a full parse', () => {
    const data = Buffer.from(content());
    const file = path.join(dir, 'split.jsonl');
    // Every offset is slow (n^2); use a stride that still hits mid-line and
    // mid-multibyte positions plus every line boundary.
    const cuts = new Set<number>();
    for (let i = 0; i <= data.length; i += 37) cuts.add(i);
    for (let i = 0; i < data.length; i++) if (data[i] === 0x0a) cuts.add(i + 1);
    for (let i = 0; i < data.length; i++) if (data[i] >= 0x80) cuts.add(i); // inside multibyte sequences
    cuts.add(data.length);
    const cache = new TranscriptCache();
    const ll = { inc: 0, full: 0 };
    let written = 0;
    fs.writeFileSync(file, '');
    for (const cut of [...cuts].sort((a, b) => a - b)) {
      if (cut <= written) continue;
      fs.appendFileSync(file, data.subarray(written, cut));
      written = cut;
      expectEquivalent(cache, file, ll);
    }
  });

  it('many tiny appends through the async path equal a full parse', async () => {
    const data = Buffer.from(content());
    const file = path.join(dir, 'tiny.jsonl');
    fs.writeFileSync(file, '');
    const cache = new TranscriptCache();
    for (let i = 0; i < data.length; i += 97) {
      fs.appendFileSync(file, data.subarray(i, Math.min(data.length, i + 97)));
      const snap = await cache.get(file);
      expect(snap!.messages()).toEqual(parseConversationFile(file));
    }
    const snap = await cache.get(file);
    expect(snap!.tasks()).toEqual(extractTasks(fs.readFileSync(file, 'utf-8')));
  });

  it('mixed sync and async readers stay consistent', async () => {
    const lines = buildTranscript();
    const file = path.join(dir, 'mixed.jsonl');
    fs.writeFileSync(file, '');
    const cache = new TranscriptCache();
    for (const line of lines) {
      fs.appendFileSync(file, line + '\n');
      const p = cache.get(file);
      cache.getSync(file);
      await p;
      expect(cache.getSync(file)!.messages()).toEqual(parseConversationFile(file));
    }
  });

  it('reads only the appended bytes after the first load', () => {
    const file = path.join(dir, 'inc.jsonl');
    fs.writeFileSync(file, content());
    const cache = new TranscriptCache();
    const first = cache.getSync(file)!;
    const size0 = first.size;
    expect(cache.stats.full).toBe(1);
    fs.appendFileSync(file, user('one more prompt') + '\n');
    const snap = cache.getSync(file)!;
    expect(cache.stats.full).toBe(1);
    expect(cache.stats.incremental).toBe(1);
    expect(snap.size).toBeGreaterThan(size0);
    expect(snap.messages()).toEqual(parseConversationFile(file));
  });

  it('truncation, in-place rewrite and replacement fall back to a full parse', async () => {
    const file = path.join(dir, 'rw.jsonl');
    const lines = buildTranscript();
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const cache = new TranscriptCache();
    cache.getSync(file);

    // Truncated (e.g. /clear rewriting) -> smaller than the offset.
    fs.writeFileSync(file, lines.slice(0, 5).join('\n') + '\n');
    expect(cache.getSync(file)!.messages()).toEqual(parseConversationFile(file));

    // Rewritten in place to a LONGER file whose prefix differs.
    const other = [user('completely different start'), ...lines.slice(1)].join('\n') + '\n';
    fs.writeFileSync(file, other + user('tail') + '\n');
    expect((await cache.get(file))!.messages()).toEqual(parseConversationFile(file));

    // Same size, different bytes before the offset.
    const now = fs.readFileSync(file, 'utf-8');
    const flipped = now.replace('tail', 'TAIL');
    fs.writeFileSync(file, flipped);
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(file, t, t);
    expect(cache.getSync(file)!.messages()).toEqual(parseConversationFile(file));

    // Replaced by another file (atomic rename -> new inode).
    const tmp = path.join(dir, 'rw.tmp');
    fs.writeFileSync(tmp, lines.slice(0, 3).join('\n') + '\n');
    fs.renameSync(tmp, file);
    expect((await cache.get(file))!.messages()).toEqual(parseConversationFile(file));
  });

  it('a missing file yields null and is forgotten', async () => {
    const cache = new TranscriptCache();
    expect(cache.getSync(path.join(dir, 'nope.jsonl'))).toBeNull();
    expect(await cache.get(path.join(dir, 'nope.jsonl'))).toBeNull();
  });

  it('is bounded (LRU)', () => {
    const cache = new TranscriptCache(2);
    for (const n of ['a', 'b', 'c']) {
      const f = path.join(dir, `${n}.jsonl`);
      fs.writeFileSync(f, user(n) + '\n');
      cache.getSync(f);
    }
    expect(cache.has(path.join(dir, 'a.jsonl'))).toBe(false);
    expect(cache.has(path.join(dir, 'c.jsonl'))).toBe(true);
  });
});
