import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  classifyLocalCommands,
  extractHighlights,
  parseConversationChain,
  parseConversationFile,
  parseLocalCommandPart,
} from '../parser';
import { orderConversationChain, transcriptStartMs } from '../session-identity';
import { extractExchanges, extractRecentTranscript } from '../herald/session-source';
import { classifyPrompt } from '../review/ledger';
import type { ConversationMessage } from '../types';

// The transcript a `/login` run inside a live claude wrote on 2026-10-02
// (d26a039f): caveat (isMeta), command, stdout -- and nothing else.
const line = (o: object) => JSON.stringify(o);
const CAVEAT =
  "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It's recorded here as context for later messages.</local-command-caveat>";
const LOGIN_CMD =
  '<command-name>/login</command-name>\n            <command-message>login</command-message>\n            <command-args></command-args>';
function loginFile(): string {
  return [
    line({ type: 'mode', mode: 'normal', sessionId: 'd26a039f' }),
    line({ type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 'd26a039f' }),
    line({
      type: 'file-history-snapshot',
      messageId: 'x',
      snapshot: { messageId: 'x', trackedFileBackups: {}, timestamp: '2026-10-02T05:32:04.042Z' },
      isSnapshotUpdate: false,
    }),
    line({
      parentUuid: null,
      type: 'user',
      message: { role: 'user', content: CAVEAT },
      isMeta: true,
      uuid: 'cav',
      timestamp: '2026-10-02T05:32:04.041Z',
    }),
    line({
      parentUuid: 'cav',
      type: 'user',
      message: { role: 'user', content: LOGIN_CMD },
      uuid: 'cmd',
      timestamp: '2026-10-02T05:32:04.040Z',
    }),
    line({
      parentUuid: 'cmd',
      type: 'user',
      message: {
        role: 'user',
        content: '<local-command-stdout>Login successful</local-command-stdout>',
      },
      uuid: 'out',
      timestamp: '2026-10-02T05:32:04.040Z',
    }),
    line({ type: 'last-prompt', leafUuid: 'out', sessionId: 'd26a039f' }),
  ].join('\n');
}
function mainFile(): string {
  return [
    line({
      type: 'user',
      message: { role: 'user', content: 'review the code' },
      uuid: 'u1',
      timestamp: '2026-09-30T07:00:51.344Z',
    }),
    line({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Reviewed.' }] },
      uuid: 'a1',
      timestamp: '2026-09-30T07:01:00.000Z',
    }),
    line({
      type: 'user',
      message: { role: 'user', content: 'keep going' },
      uuid: 'u2',
      timestamp: '2026-10-02T05:32:20.000Z',
    }),
    line({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Newest reply.' }] },
      uuid: 'a2',
      timestamp: '2026-10-02T08:52:48.411Z',
    }),
  ].join('\n');
}

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-cmd-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
function write(name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}
const msg = (
  id: string,
  type: 'user' | 'assistant',
  content: string,
  timestamp = 1
): ConversationMessage => ({
  id,
  type,
  content,
  timestamp,
});

describe('parseLocalCommandPart', () => {
  it('classifies caveat, command, stdout and stderr', () => {
    expect(parseLocalCommandPart(CAVEAT)).toEqual({ kind: 'caveat' });
    expect(parseLocalCommandPart(LOGIN_CMD)).toEqual({ kind: 'command', name: '/login', args: '' });
    expect(
      parseLocalCommandPart('<command-name>model</command-name><command-args>opus</command-args>')
    ).toEqual({
      kind: 'command',
      name: '/model',
      args: 'opus',
    });
    expect(
      parseLocalCommandPart('<local-command-stdout>\x1b[1mSet\x1b[22m model</local-command-stdout>')
    ).toEqual({
      kind: 'output',
      text: 'Set model',
      isError: false,
    });
    expect(parseLocalCommandPart('<local-command-stderr>boom</local-command-stderr>')).toEqual({
      kind: 'output',
      text: 'boom',
      isError: true,
    });
    expect(parseLocalCommandPart('please fix <local-command-stdout> handling')).toBeNull();
    expect(parseLocalCommandPart('hello')).toBeNull();
  });
});

describe('local commands in highlights', () => {
  it('the observed /login transcript renders as one "Ran /login" marker, no raw tags', () => {
    const p = write('login.jsonl', loginFile());
    const hl = extractHighlights(parseConversationFile(p));
    expect(hl).toHaveLength(1);
    expect(hl[0]).toMatchObject({
      type: 'system',
      content: 'Ran /login · Login successful',
      localCommand: { name: '/login', output: 'Login successful' },
    });
    expect(hl[0].skillName).toBeUndefined();
  });

  it('never shows a caveat, and drops long or multi-line output', () => {
    const long = 'x'.repeat(500);
    const hl = extractHighlights([
      msg('1', 'user', 'hi'),
      msg('2', 'assistant', 'hello'),
      msg('3', 'user', CAVEAT),
      msg('4', 'user', '<command-name>/usage</command-name><command-args></command-args>'),
      msg('5', 'user', `<local-command-stdout>${long}</local-command-stdout>`),
      msg('6', 'user', CAVEAT),
      msg('7', 'user', '<command-name>/model</command-name><command-args></command-args>'),
      msg('8', 'user', '<local-command-stdout>line one\nline two</local-command-stdout>'),
      msg('9', 'user', '<command-name>/foo</command-name>'),
      msg('10', 'user', '<local-command-stderr>Unknown command</local-command-stderr>'),
    ]);
    expect(hl.map((h) => h.content)).toEqual([
      'hi',
      'hello',
      'Ran /usage',
      'Ran /model',
      'Ran /foo · Unknown command',
    ]);
    expect(hl[4].localCommand?.isError).toBe(true);
    for (const h of hl) expect(h.content).not.toMatch(/<\/?(local-command|command-)/);
  });

  it('a skill trigger stays hidden and its expansion stays a skill card', () => {
    const p = write(
      'skill.jsonl',
      [
        line({
          type: 'user',
          message: { role: 'user', content: '<command-name>/commit</command-name>' },
          uuid: 's1',
          timestamp: '2026-10-01T00:00:00.000Z',
        }),
        line({
          type: 'user',
          message: { role: 'user', content: '# Smart Commit\nDo the commit.' },
          uuid: 's2',
          timestamp: '2026-10-01T00:00:01.000Z',
        }),
      ].join('\n')
    );
    const hl = extractHighlights(parseConversationFile(p));
    expect(hl).toHaveLength(1);
    expect(hl[0]).toMatchObject({ type: 'user', skillName: 'commit' });
    expect(hl[0].localCommand).toBeUndefined();
  });

  it('classifyLocalCommands marks plumbing and markers by index', () => {
    const { hidden, markers } = classifyLocalCommands([
      msg('1', 'user', CAVEAT),
      msg('2', 'user', LOGIN_CMD),
      msg('3', 'user', '<local-command-stdout>Login successful</local-command-stdout>'),
      msg('4', 'user', 'real prompt'),
    ]);
    expect([...hidden].sort()).toEqual([0, 2]);
    expect([...markers.keys()]).toEqual([1]);
  });
});

describe('parseConversationChain with a command-only file', () => {
  it('skips an older command-only file: no misleading "Previous session" divider', () => {
    const login = write('chain-login.jsonl', loginFile());
    const main = write('chain-main.jsonl', mainFile());
    const r = parseConversationChain([login, main], 50, 0);
    expect(r.highlights.some((h) => h.content.includes('Previous session'))).toBe(false);
    expect(r.highlights.some((h) => h.localCommand)).toBe(false);
    expect(r.highlights[r.highlights.length - 1].content).toBe('Newest reply.');
  });

  it('a newest command-only file shows only its marker, no divider', () => {
    const login = write('chain-login2.jsonl', loginFile());
    const main = write('chain-main3.jsonl', mainFile());
    const r = parseConversationChain([main, login], 50, 0);
    expect(r.highlights.some((h) => h.content.includes('Previous session'))).toBe(false);
    expect(r.highlights[r.highlights.length - 1].content).toBe(
      'Ran /login \u00b7 Login successful'
    );
  });

  it('still inserts the divider between two real sessions', () => {
    const older = write('chain-older.jsonl', mainFile().replace(/2026-10-02/g, '2026-09-29'));
    const main = write('chain-main2.jsonl', mainFile());
    const r = parseConversationChain([older, main], 50, 0);
    expect(r.highlights.filter((h) => h.content.includes('Previous session'))).toHaveLength(1);
  });
});

describe('transcriptStartMs / orderConversationChain', () => {
  it('reads the first timestamped entry (metadata lines carry none)', () => {
    const p = write('start.jsonl', loginFile());
    expect(transcriptStartMs(p)).toBe(Date.parse('2026-10-02T05:32:04.041Z'));
    expect(transcriptStartMs(write('empty.jsonl', ''))).toBeNull();
    expect(transcriptStartMs(path.join(dir, 'missing.jsonl'))).toBeNull();
  });

  it('reads past a large first line', () => {
    const big = line({ type: 'file-history-snapshot', blob: 'y'.repeat(200 * 1024) });
    const p = write(
      'big.jsonl',
      big + '\n' + line({ type: 'user', timestamp: '2026-01-01T00:00:00.000Z' })
    );
    expect(transcriptStartMs(p)).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
  });

  const MAIN = {
    id: '19e80693',
    path: '/p/19e80693.jsonl',
    startMs: Date.parse('2026-09-30T07:00:51.344Z'),
  };
  const LOGIN = {
    id: 'd26a039f',
    path: '/p/d26a039f.jsonl',
    startMs: Date.parse('2026-10-02T05:32:04.041Z'),
  };

  it('observed state: a side transcript started after the live one is never rendered after it', () => {
    expect(orderConversationChain([MAIN, LOGIN], '19e80693')).toEqual([MAIN.path]);
    expect(orderConversationChain([LOGIN, MAIN], '19e80693')).toEqual([MAIN.path]);
  });

  it('orders predecessors by first entry, live conversation last', () => {
    const a = { id: 'a', path: '/a', startMs: 1 };
    const b = { id: 'b', path: '/b', startMs: 2 };
    const c = { id: 'c', path: '/c', startMs: 3 };
    expect(orderConversationChain([c, a, b], 'c')).toEqual(['/a', '/b', '/c']);
    expect(orderConversationChain([b, c, a], undefined)).toEqual(['/a', '/b', '/c']);
    expect(orderConversationChain([c, a, b], 'c', 2)).toEqual(['/b', '/c']);
    expect(orderConversationChain([c, a, b], 'c', 1)).toEqual(['/c']);
  });

  it('keeps an empty live file, drops empty predecessors', () => {
    const a = { id: 'a', path: '/a', startMs: 1 };
    const e = { id: 'e', path: '/e', startMs: null };
    expect(orderConversationChain([a, e], 'e')).toEqual(['/a', '/e']);
    expect(orderConversationChain([e, a], 'a')).toEqual(['/a']);
    expect(orderConversationChain([], 'a')).toEqual([]);
  });
});

describe('Herald transcript extraction ignores local commands', () => {
  const msgs: ConversationMessage[] = [
    msg('1', 'user', 'review the code', 1000),
    msg('2', 'assistant', 'Reviewed.', 2000),
    msg('3', 'user', CAVEAT, 3000),
    msg('4', 'user', LOGIN_CMD, 3000),
    msg('5', 'user', '<local-command-stdout>Login successful</local-command-stdout>', 3000),
  ];

  it('extractRecentTranscript: the last prompt is the real one', () => {
    const t = extractRecentTranscript(msgs, 3);
    expect(t.lastUserPrompt?.text).toBe('review the code');
    expect(t.assistantTurns.map((x) => x.text)).toEqual(['Reviewed.']);
  });

  it('a skill trigger is still a prompt (unchanged)', () => {
    const t = extractRecentTranscript(
      [
        msg('1', 'user', '<command-name>/commit</command-name>', 1000),
        msg('2', 'assistant', 'Committed.', 2000),
      ],
      3
    );
    expect(t.lastUserPrompt?.text).toBe('<command-name>/commit</command-name>');
  });

  it('extractExchanges: no exchange for the caveat or the command', () => {
    const ex = extractExchanges(msgs, 0);
    expect(ex).toEqual([
      { prompt: 'review the code', promptAt: 1000, reply: 'Reviewed.', replyAt: 2000 },
    ]);
  });
});

describe('review ledger prompt classification', () => {
  it('a caveat or command output never opens a turn', () => {
    expect(classifyPrompt(CAVEAT, false)).toBe('attach');
    expect(
      classifyPrompt('<local-command-stdout>Login successful</local-command-stdout>', false)
    ).toBe('attach');
    expect(classifyPrompt('<local-command-stderr>x</local-command-stderr>', false)).toBe('attach');
    expect(classifyPrompt(LOGIN_CMD, false)).toEqual({ label: expect.stringMatching(/^\/login/) });
  });
});
