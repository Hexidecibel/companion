/**
 * Transcript builder for stuck tests: JSONL entries shaped like real Claude
 * Code transcripts (assistant tool_use, user tool_result with is_error and
 * toolUseResult, prompts), synthetic content. Parsed with the daemon's own
 * parser so the tests exercise the same path as production.
 */
import { parseConversationFile } from '../../parser';
import type { ConversationMessage } from '../../types';

const base = {
  userType: 'external',
  entrypoint: 'cli',
  version: '2.1.285',
  gitBranch: 'main',
  cwd: '/home/u/proj',
};
const iso = (ms: number) => new Date(ms).toISOString();
export const MIN = 60_000;
export const T0 = Date.parse('2026-10-03T10:00:00.000Z');

let seq = 0;

export class Transcript {
  entries: Record<string, unknown>[] = [];
  t: number;

  constructor(start = T0) {
    this.t = start;
  }

  /** Move the clock (seconds). */
  wait(sec: number): this {
    this.t += sec * 1000;
    return this;
  }

  prompt(text: string, uuid = `p${++seq}`): this {
    this.entries.push({
      parentUuid: null,
      isSidechain: false,
      promptId: `pid-${uuid}`,
      type: 'user',
      message: { role: 'user', content: text },
      uuid,
      timestamp: iso(this.t),
      ...base,
    });
    return this.wait(2);
  }

  text(s: string): this {
    this.entries.push({
      type: 'assistant',
      isSidechain: false,
      uuid: `a${++seq}`,
      timestamp: iso(this.t),
      message: {
        id: `msg_${seq}`,
        role: 'assistant',
        model: 'claude-opus',
        content: [{ type: 'text', text: s }],
      },
      ...base,
    });
    return this.wait(3);
  }

  /** tool_use only (still pending). Returns the tool id via `lastId`. */
  use(name: string, input: Record<string, unknown>): this {
    this.lastId = `toolu_${++seq}`;
    this.entries.push({
      type: 'assistant',
      isSidechain: false,
      uuid: `a${++seq}`,
      timestamp: iso(this.t),
      message: {
        id: `msg_${seq}`,
        role: 'assistant',
        model: 'claude-opus',
        content: [{ type: 'tool_use', id: this.lastId, name, input }],
      },
      ...base,
    });
    return this;
  }

  lastId = '';

  /** tool_result for the last tool_use. */
  result(content: string, opts: { isError?: boolean; after?: number; tur?: unknown } = {}): this {
    this.wait(opts.after ?? 5);
    this.entries.push({
      parentUuid: `a${seq}`,
      isSidechain: false,
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            tool_use_id: this.lastId,
            type: 'tool_result',
            content,
            ...(opts.isError ? { is_error: true } : {}),
          },
        ],
      },
      uuid: `u${++seq}`,
      timestamp: iso(this.t),
      toolUseResult:
        opts.tur ??
        (opts.isError
          ? `Error: ${content}`
          : { stdout: content, stderr: '', interrupted: false, isImage: false }),
      ...base,
    });
    return this.wait(2);
  }

  bash(command: string, output: string, opts: { isError?: boolean; after?: number } = {}): this {
    return this.use('Bash', { command, description: 'run it' }).result(output, opts);
  }

  read(
    filePath: string,
    output = '     1\tline one\n     2\tline two',
    opts: { offset?: number } = {}
  ): this {
    return this.use('Read', {
      file_path: filePath,
      ...(opts.offset ? { offset: opts.offset } : {}),
    }).result(output);
  }

  edit(
    filePath: string,
    oldString: string,
    newString: string,
    opts: { isError?: boolean } = {}
  ): this {
    this.use('Edit', {
      file_path: filePath,
      old_string: oldString,
      new_string: newString,
      replace_all: false,
    });
    if (opts.isError)
      return this.result(
        '<tool_use_error>String to replace not found in file.\nString: ' +
          oldString +
          '</tool_use_error>',
        {
          isError: true,
        }
      );
    return this.result(
      `The file ${filePath} has been updated. Here's the result of running \`cat -n\` on a snippet...`,
      {
        tur: {
          filePath,
          oldString,
          newString,
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: [`-${oldString}`, `+${newString}`],
            },
          ],
          userModified: false,
          replaceAll: false,
        },
      }
    );
  }

  write(filePath: string, content: string): this {
    this.use('Write', { file_path: filePath, content });
    return this.result(`File created successfully at: ${filePath}`, {
      tur: { type: 'update', filePath, content, structuredPatch: [], originalFile: null },
    });
  }

  interrupted(): this {
    this.entries.push({
      type: 'user',
      isSidechain: false,
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      uuid: `u${++seq}`,
      timestamp: iso(this.t),
      ...base,
    });
    return this.wait(1);
  }

  jsonl(): string {
    return this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  }

  messages(): ConversationMessage[] {
    return parseConversationFile('/nonexistent.jsonl', undefined, this.jsonl());
  }
}

/** Jest-style failing output; numbers vary per run like real timings. */
export function jestFail(run: number): string {
  return [
    '> proj@1.0.0 test',
    '> jest',
    '',
    'FAIL src/api.test.ts',
    '  retries',
    `    ✕ backs off (${10 + run} ms)`,
    `    ✓ gives up (${2 + run} ms)`,
    '',
    '  ● retries › backs off',
    '',
    '    expect(received).toBe(expected) // Object.is equality',
    '',
    `    Expected: ${3}`,
    `    Received: ${run % 2 ? 2 : 1}`,
    '',
    `      at Object.<anonymous> (src/api.test.ts:${40 + run}:7)`,
    '',
    'Tests:       1 failed, 1 passed, 2 total',
    `Time:        ${1 + run / 10} s`,
  ].join('\n');
}

export function jestPass(): string {
  return [
    'PASS src/api.test.ts',
    '  retries',
    '    ✓ backs off (11 ms)',
    '    ✓ gives up (2 ms)',
    '',
    'Tests:       2 passed, 2 total',
  ].join('\n');
}

export function tscFail(line: number): string {
  return `src/api.ts(${line},5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`;
}
