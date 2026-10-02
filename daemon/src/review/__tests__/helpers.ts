/** JSONL entry builders shaped like real Claude Code transcripts. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

let seq = 0;
const iso = (ms: number) => new Date(ms).toISOString();
const base = { userType: 'external', entrypoint: 'cli', version: '2.1.285', gitBranch: 'main' };

export function prompt(uuid: string, text: string, at: number, extra: Record<string, unknown> = {}) {
  return {
    parentUuid: null,
    isSidechain: false,
    promptId: `p-${uuid}`,
    type: 'user',
    message: { role: 'user', content: text },
    uuid,
    timestamp: iso(at),
    ...base,
    ...extra,
  };
}

export function assistantText(text: string, at: number) {
  return {
    type: 'assistant',
    isSidechain: false,
    uuid: `a${++seq}`,
    timestamp: iso(at),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    ...base,
  };
}

export function toolUse(id: string, name: string, input: Record<string, unknown>, at: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    isSidechain: false,
    uuid: `a${++seq}`,
    timestamp: iso(at),
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    ...base,
    ...extra,
  };
}

export function toolResult(id: string, tur: unknown, at: number, opts: { isError?: boolean; extra?: Record<string, unknown> } = {}) {
  return {
    type: 'user',
    isSidechain: false,
    uuid: `u${++seq}`,
    timestamp: iso(at),
    message: {
      role: 'user',
      content: [
        {
          tool_use_id: id,
          type: 'tool_result',
          content: opts.isError ? 'Error: String to replace not found' : 'ok',
          ...(opts.isError ? { is_error: true } : {}),
        },
      ],
    },
    toolUseResult: tur,
    ...base,
    ...(opts.extra || {}),
  };
}

export function editResult(filePath: string, hunks: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }>) {
  return { filePath, oldString: 'x', newString: 'y', structuredPatch: hunks, userModified: false, replaceAll: false };
}

export function writeCreate(filePath: string, content: string) {
  return { type: 'create', filePath, content, structuredPatch: [], originalFile: null };
}

export function jsonl(entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

export function tmpDir(prefix = 'review-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

export function initRepo(): string {
  const dir = tmpDir('review-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  return fs.realpathSync(dir);
}

export function commitAll(dir: string, msg = 'c'): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
}

/** A fake watcher with one session whose chain is `files`. */
export function fakeWatcher(sessions: Array<{ id: string; projectPath: string; files: string[]; waiting?: boolean }>) {
  return {
    getSessions: () =>
      sessions.map((s) => ({
        id: s.id,
        name: s.id,
        projectPath: s.projectPath,
        conversationPath: s.files[s.files.length - 1],
        lastActivity: 0,
        isWaitingForInput: s.waiting ?? true,
        messageCount: 0,
      })),
    getConversationChain: (id: string) => sessions.find((s) => s.id === id)?.files || [],
  };
}
