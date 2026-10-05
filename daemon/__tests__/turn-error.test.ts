import {
  bashKind,
  detectTurnEndError,
  firstErrorLine,
  textLeavesErrorStanding,
} from '../src/turn-error';
import { parseConversationFile } from '../src/parser';
import type { ConversationMessage, ToolCall } from '../src/types';

let n = 0;
function user(content: string): ConversationMessage {
  return { id: `u${++n}`, type: 'user', content, timestamp: n };
}
function toolResultEntry(): ConversationMessage {
  // A tool_result-only user entry parses to an empty user message.
  return { id: `r${++n}`, type: 'user', content: '', timestamp: n };
}
function said(content: string, stopReason = 'end_turn'): ConversationMessage {
  return { id: `a${++n}`, type: 'assistant', content, timestamp: n, stopReason };
}
function tool(
  name: string,
  input: Record<string, unknown>,
  output: string,
  error = false
): ConversationMessage {
  const tc: ToolCall = {
    id: `t${++n}`,
    name,
    input,
    output,
    status: error ? 'error' : 'completed',
    ...(error ? { isError: true } : {}),
  };
  return { id: `a${n}`, type: 'assistant', content: '', timestamp: n, toolCalls: [tc], stopReason: 'tool_use' };
}
const bash = (command: string, output: string, error = false) => tool('Bash', { command }, output, error);

describe('detectTurnEndError: harmless errors stay silent', () => {
  it('grep with no match, then the turn moves on', () => {
    const m = [
      user('is foo still used?'),
      bash('grep -rn foo src', 'Exit code 1', true),
      toolResultEntry(),
      said('No references to foo remain; it is safe to delete.'),
    ];
    expect(detectTurnEndError(m)).toBeNull();
  });

  it('an Edit mismatch fixed by a later edit', () => {
    const m = [
      user('rename it'),
      tool('Edit', { file_path: '/a.ts' }, '<tool_use_error>String to replace not found in file.</tool_use_error>', true),
      toolResultEntry(),
      tool('Read', { file_path: '/a.ts' }, 'contents'),
      toolResultEntry(),
      tool('Write', { file_path: '/a.ts' }, 'File written'),
      toolResultEntry(),
      said('Renamed. The edit failed at first because the file had changed, so I rewrote it.'),
    ];
    // "failed" in the summary, but a later edit succeeded: resolved.
    expect(detectTurnEndError(m)).toBeNull();
  });

  it('a red test mid-TDD that later passes', () => {
    const m = [
      user('add the feature with TDD'),
      bash('npm test -- parser', 'Exit code 1\nFAIL parser.test.ts\n  expected 2, got 1', true),
      toolResultEntry(),
      tool('Edit', { file_path: '/p.ts' }, 'ok'),
      toolResultEntry(),
      bash('npm test -- parser', 'PASS parser.test.ts'),
      toolResultEntry(),
      said('Done: the parser handles it and the tests pass.'),
    ];
    expect(detectTurnEndError(m)).toBeNull();
  });

  it('a red step the turn says was expected', () => {
    const m = [
      user('write the failing test first'),
      bash('npm test', 'Exit code 1\nFAIL x.test.ts', true),
      toolResultEntry(),
      said('The new test fails as expected (red step). Next I will implement it.'),
    ];
    expect(detectTurnEndError(m)).toBeNull();
  });

  it('a tool the user rejected or an interrupt', () => {
    const rejected = [
      user('deploy'),
      bash('bin/deploy', "The user doesn't want to proceed with this tool use. The tool use was rejected", true),
      toolResultEntry(),
      said('Okay, I will not deploy.'),
    ];
    expect(detectTurnEndError(rejected)).toBeNull();
    const interrupted = [
      user('run it'),
      bash('npm test', 'Exit code 1\nFAIL', true),
      user('[Request interrupted by user]'),
    ];
    expect(detectTurnEndError(interrupted)).toBeNull();
  });

  it('an error in an earlier turn does not count', () => {
    const m = [
      user('first'),
      bash('npm test', 'Exit code 1\nFAIL', true),
      toolResultEntry(),
      said('The tests fail.'),
      user('ok, now just say hi'),
      said('Hi!'),
    ];
    expect(detectTurnEndError(m)).toBeNull();
  });

  it('nothing while the turn is still going', () => {
    const errored = bash('npm run build', 'Exit code 2\nerror TS2322', true);
    expect(detectTurnEndError([user('build'), errored])).toBeNull(); // stop_reason tool_use
    expect(detectTurnEndError([user('build'), errored, toolResultEntry()])).toBeNull(); // user entry last
    const running = tool('Bash', { command: 'sleep 9' }, '');
    running.toolCalls![0].status = 'running';
    running.toolCalls![0].output = undefined;
    expect(detectTurnEndError([user('x'), running])).toBeNull();
  });
});

describe('detectTurnEndError: a turn that ends on an error', () => {
  it('fires when the turn ends right on the error', () => {
    const last = bash('npm run build', 'Exit code 2\nsrc/a.ts(3,1): error TS2322: Type string is not number', true);
    last.stopReason = undefined; // older CLI: no stop_reason recorded
    const r = detectTurnEndError([user('build it'), last]);
    expect(r).not.toBeNull();
    expect(r!.tool).toBe('Bash');
    expect(r!.line).toBe('src/a.ts(3,1): error TS2322: Type string is not number');
    expect(r!.preview).toBe('Bash: src/a.ts(3,1): error TS2322: Type string is not number');
    expect(r!.toolId).toBe(last.toolCalls![0].id);
  });

  it('fires when the final text reports the failure', () => {
    const e = bash('npm test', 'Exit code 1\nFAIL auth.test.ts\n  TypeError: x is undefined', true);
    const m = [user('fix auth'), e, toolResultEntry(), said("I couldn't get the auth tests to pass. Want me to keep digging?")];
    const r = detectTurnEndError(m);
    expect(r?.toolId).toBe(e.toolCalls![0].id);
    expect(r?.line).toBe('FAIL auth.test.ts');
  });

  it('a later success of a DIFFERENT kind does not resolve it', () => {
    const e = bash('npm test', 'Exit code 1\nFAIL a.test.ts', true);
    const m = [
      user('fix it'),
      e,
      toolResultEntry(),
      bash('git status', 'clean'),
      toolResultEntry(),
      said('The test still fails; I left the tree clean.'),
    ];
    expect(detectTurnEndError(m)?.toolId).toBe(e.toolCalls![0].id);
  });

  it('is deterministic for the same transcript', () => {
    const m = [user('x'), bash('make', 'Exit code 2\nmake: *** No rule to make target', true), toolResultEntry(), said('The build failed.')];
    expect(detectTurnEndError(m)).toEqual(detectTurnEndError(m));
  });

  it('redacts secrets in the preview', () => {
    const e = bash(
      'curl api',
      'Exit code 22\nerror: request failed with key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      true
    );
    const r = detectTurnEndError([user('call it'), e, toolResultEntry(), said('The request failed.')]);
    expect(r).not.toBeNull();
    expect(r!.preview).not.toContain('sk-ant-api03-AAAA');
    expect(r!.preview).toContain('[redacted]');
  });
});

describe('helpers', () => {
  it('bashKind keys a command by program and subcommand, skipping prefixes', () => {
    expect(bashKind('cd web && npm test -- foo')).toBe('npm test');
    expect(bashKind('source ~/.nvm/nvm.sh && npm run build')).toBe('npm run build');
    expect(bashKind('NODE_ENV=test npx jest x')).toBe('npx jest');
    expect(bashKind('/usr/bin/grep -rn foo .')).toBe('grep');
  });

  it('firstErrorLine prefers a line that names the error', () => {
    expect(firstErrorLine('Exit code 1\nRunning...\nError: boom')).toBe('Error: boom');
    expect(firstErrorLine('Exit code 1\nsome output')).toBe('some output');
    expect(firstErrorLine('Exit code 7')).toBe('Exit code 7');
    expect(firstErrorLine('')).toBe('Tool error');
    expect(firstErrorLine('\u001b[31merror\u001b[0m: red')).toBe('error: red');
    expect(firstErrorLine(`error: ${'x'.repeat(400)}`).length).toBeLessThanOrEqual(160);
  });

  it('textLeavesErrorStanding', () => {
    expect(textLeavesErrorStanding('The build still fails.')).toBe(true);
    expect(textLeavesErrorStanding('Added error handling to the parser.')).toBe(false);
    expect(textLeavesErrorStanding('All green, no errors.')).toBe(false);
    expect(textLeavesErrorStanding('It fails as expected.')).toBe(false);
  });
});

describe('parser: error status + stop_reason', () => {
  it('marks is_error results as status error and records stop_reason', () => {
    const lines = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'go' } },
      {
        type: 'assistant',
        uuid: 'a1',
        message: {
          role: 'assistant',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'false' } }],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'Exit code 1' }] },
      },
      { type: 'assistant', uuid: 'a2', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'It failed.' }] } },
    ];
    const msgs = parseConversationFile('/x.jsonl', undefined, lines.map((l) => JSON.stringify(l)).join('\n'));
    const tc = msgs.find((m) => m.id === 'a1')!.toolCalls![0];
    expect(tc.status).toBe('error');
    expect(tc.isError).toBe(true);
    expect(msgs[msgs.length - 1].stopReason).toBe('end_turn');
    expect(detectTurnEndError(msgs)?.toolId).toBe('tu1');
  });
});
