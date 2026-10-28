/**
 * Codex CLI adapter (read-only): rollout parsing, status, tool roles, the
 * approval box and pane -> rollout discovery. Fixtures are sanitized copies of
 * real codex-cli 0.165 rollouts (no creator / account ids, user names, auth,
 * long outputs truncated).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { codexAdapter, getAgentAdapter, requiresApproval } from '..';
import {
  CodexAccumulator,
  codexCurrentActivity,
  codexTurnEnded,
  customToolResult,
  customToolStart,
  functionToolResult,
  functionToolStart,
  isInjectedUserMessage,
  parseCodexFile,
  parseCodexText,
  patchFiles,
  summarizeExecInput,
} from '../codex/parse';
import {
  detectCodexActiveChoicePrompt,
  parseCodexApprovalBox,
  classifyCodexStartupPane,
} from '../codex/terminal';
import {
  CodexRolloutIndex,
  dateDirsSince,
  findCodexPid,
  isCodexArgv,
  isCodexRollout,
  pickRollout,
  resolveCodexHome,
  resumeIdFromArgv,
  rolloutIdOf,
  type RolloutCandidate,
} from '../codex/discovery';
import { TranscriptCache } from '../../transcript-cache';
import { readPane } from '../../stuck/normalize';

const FIX = path.join(__dirname, 'fixtures', 'codex');
const fixture = (name: string) => path.join(FIX, name);
const read = (name: string) => fs.readFileSync(fixture(name), 'utf-8');

describe('Codex rollout parsing', () => {
  it('a finished turn: user + assistant text, exec calls as shell tools, turn over', () => {
    const msgs = parseCodexFile(fixture('complete.jsonl'));
    expect(msgs.map((m) => m.type)).toEqual(['user', 'assistant', 'assistant']);
    // environment_context (role user, harness-injected) and developer messages are skipped
    expect(msgs[0].content).toBe('summarize my repo pleas');
    const calls = msgs[1].toolCalls!;
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.name === 'exec_command')).toBe(true);
    expect(calls.every((c) => codexAdapter.toolRole(c.name) === 'shell')).toBe(true);
    expect(calls.every((c) => c.status === 'completed')).toBe(true);
    expect(calls[0].input.command).toMatch(/^pwd && rg --files/);
    // exit_code 1 (sandbox failed) -> isError; status stays completed
    expect(calls[0].isError).toBe(true);
    expect(calls[0].output).toMatch(/bwrap/);
    expect(calls[1].isError).toBeUndefined();
    expect(calls[1].input.sandbox_permissions).toBe('require_escalated');
    expect(String(calls[1].input.justification)).toMatch(/sandbox/);
    expect(msgs[2].content).toMatch(/Codegrind/);
    expect(msgs[2].stopReason).toBe('end_turn');
    expect(codexTurnEnded(msgs)).toBe(true);
    expect(codexAdapter.transcript.detectWaitingForInput(msgs)).toBe(true);
    expect(codexCurrentActivity(msgs)).toBeUndefined();
    expect(codexAdapter.transcript.getPendingApprovalTools(msgs)).toEqual([]);
  });

  it('an interrupted turn ends with a system "Turn interrupted"; reasoning stays hidden', () => {
    const msgs = parseCodexFile(fixture('two-turns-aborted.jsonl'));
    expect(msgs.map((m) => m.type)).toEqual(['user', 'assistant', 'assistant', 'user', 'system']);
    expect(msgs[2].stopReason).toBe('end_turn');
    expect(msgs[3].content).toBe('exit');
    expect(msgs[4]).toMatchObject({ content: 'Turn interrupted', stopReason: 'aborted' });
    expect(msgs.some((m) => /encrypted|<redacted>/.test(m.content))).toBe(false);
    expect(codexTurnEnded(msgs)).toBe(true);
  });

  it('a trailing call without output is running (approval may be pending on screen)', () => {
    const msgs = parseCodexFile(fixture('pending-call.jsonl'));
    const last = msgs[msgs.length - 1];
    expect(last.type).toBe('assistant');
    const tc = last.toolCalls![last.toolCalls!.length - 1];
    expect(tc.status).toBe('running');
    expect(tc.input.sandbox_permissions).toBe('require_escalated');
    expect(codexTurnEnded(msgs)).toBe(false);
    expect(codexAdapter.transcript.detectWaitingForInput(msgs)).toBe(false);
    expect(codexCurrentActivity(msgs)).toMatch(/^Running: pwd && ls -la/);
    expect(codexAdapter.transcript.getPendingApprovalTools(msgs)).toEqual([]);
  });

  it('working states: user only = Processing, assistant text mid-turn = Working', () => {
    const lines = read('complete.jsonl').trim().split('\n');
    const upTo = (pred: (l: string) => boolean) => {
      const i = lines.findIndex(pred);
      return parseCodexText(lines.slice(0, i + 1).join('\n')).messages;
    };
    const afterUser = upTo((l) => l.includes('"user.text"'));
    expect(afterUser[afterUser.length - 1].type).toBe('user');
    expect(codexCurrentActivity(afterUser)).toBe('Processing...');
    const afterCommentary = upTo(
      (l) => l.includes('"phase":"commentary"') && l.includes('"role":"assistant"')
    );
    expect(codexCurrentActivity(afterCommentary)).toBe('Working...');
    expect(codexTurnEnded(afterCommentary)).toBe(false);
  });

  it('incremental append equals a full parse, and earlier snapshots are not mutated', () => {
    const text = read('complete.jsonl');
    const full = parseCodexText(text).messages;
    const acc = new CodexAccumulator();
    const snaps: string[] = [];
    const held: Array<ReturnType<CodexAccumulator['messages']>> = [];
    for (const line of text.trim().split('\n')) {
      acc.append([JSON.parse(line)]);
      const m = acc.messages();
      held.push(m);
      snaps.push(JSON.stringify(m));
    }
    expect(acc.messages()).toEqual(full);
    held.forEach((m, i) => expect(JSON.stringify(m)).toBe(snaps[i]));
    expect(acc.meta).toMatchObject({
      id: '01a18489-6c75-7bb1-ab42-09c09097479d',
      cwd: '/home/user/local/src/codegrind',
    });
  });

  it('the transcript cache reads rollouts incrementally with the Codex parser', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cache-'));
    try {
      const f = path.join(
        dir,
        'rollout-2026-10-28T15-02-41-01a18489-6c75-7bb1-ab42-09c09097479d.jsonl'
      );
      const lines = read('complete.jsonl').trim().split('\n');
      fs.writeFileSync(f, lines.slice(0, 10).join('\n') + '\n');
      const cache = new TranscriptCache();
      const first = cache.getSync(f)!.messages();
      fs.appendFileSync(f, lines.slice(10).join('\n') + '\n');
      const snap = cache.getSync(f)!;
      expect(cache.stats).toEqual({ full: 1, incremental: 1 });
      expect(snap.messages()).toEqual(parseCodexFile(fixture('complete.jsonl')));
      expect(first.length).toBeLessThan(snap.messages().length);
      expect(snap.tasks()).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unknown record types and broken lines are ignored', () => {
    const text = [
      '{"type":"something_new","payload":{"x":1}}',
      'not json',
      '{"type":"response_item","payload":{"type":"brand_new_item"}}',
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}',
    ].join('\n');
    expect(parseCodexText(text).messages.map((m) => m.content)).toEqual(['hi']);
  });

  it('harness-injected user content is skipped (with and without content kinds)', () => {
    const kinds = (k: string[]) => ({
      internal_chat_message_metadata_passthrough: { content_item_kinds: k },
    });
    expect(
      isInjectedUserMessage(kinds(['environments.environment_context']), '<environment_context>')
    ).toBe(true);
    expect(isInjectedUserMessage(kinds(['user.text']), 'hello')).toBe(false);
    expect(isInjectedUserMessage({}, '<environment_context>\n  <cwd>/x</cwd>')).toBe(true);
    expect(isInjectedUserMessage({}, '# AGENTS.md instructions for /x')).toBe(true);
    expect(isInjectedUserMessage({}, 'fix the build')).toBe(false);
  });
});

describe('Codex tool calls', () => {
  it('exec snippets: several commands, quoted keys, single quotes, escapes', () => {
    const s = summarizeExecInput(
      `text(await tools.exec_command({cmd:"echo \\"a\\" && ls","max_output_tokens":4000}));\n` +
        `text(await tools.exec_command({'cmd': 'git status', "justification":"May I?","sandbox_permissions":"require_escalated"}));`
    );
    expect(s.tools).toEqual(['exec_command', 'exec_command']);
    expect(s.commands).toEqual(['echo "a" && ls', 'git status']);
    expect(s.justification).toBe('May I?');
    expect(s.escalated).toBe(true);
    const start = customToolStart('exec', 'text(await tools.exec_command({cmd:"ls"}))');
    expect(start).toEqual({ name: 'exec_command', input: { command: 'ls', commands: ['ls'] } });
  });

  it('apply_patch (custom tool, exec snippet, function call) is an edit with its files', () => {
    const patch =
      '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: b.md\n+x\n*** End Patch';
    expect(patchFiles(patch)).toEqual(['src/a.ts', 'b.md']);
    const custom = customToolStart('apply_patch', patch);
    expect(custom.name).toBe('apply_patch');
    expect(custom.input.files).toEqual(['src/a.ts', 'b.md']);
    const viaExec = customToolStart(
      'exec',
      `text(await tools.apply_patch({input: ${JSON.stringify(patch)}}))`
    );
    expect(viaExec.name).toBe('apply_patch');
    expect(viaExec.input.files).toEqual(['src/a.ts', 'b.md']);
    const fn = functionToolStart('apply_patch', JSON.stringify({ input: patch }));
    expect(fn.input.files).toEqual(['src/a.ts', 'b.md']);
    expect(codexAdapter.toolRole('apply_patch')).toBe('edit');
  });

  it('function calls (older rollouts): shell argv, exit codes, plan updates', () => {
    const text = [
      { type: 'event_msg', payload: { type: 'task_started' } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'run tests' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'shell',
          call_id: 'c1',
          arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'], workdir: '/x' }),
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'c1',
          output: JSON.stringify({ output: 'FAIL', metadata: { exit_code: 1 } }),
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'update_plan',
          call_id: 'c2',
          arguments: '{"plan":[]}',
        },
      },
      {
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'c2', output: 'Plan updated' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Tests fail.' }],
        },
      },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n');
    const msgs = parseCodexText(text).messages;
    expect(msgs.map((m) => m.type)).toEqual(['user', 'assistant', 'assistant']);
    const [shell, plan] = msgs[1].toolCalls!;
    expect(shell).toMatchObject({
      name: 'shell',
      status: 'completed',
      isError: true,
      output: 'FAIL',
    });
    expect(shell.input.command).toBe('npm test');
    expect(plan).toMatchObject({ name: 'update_plan', status: 'completed' });
    expect(codexAdapter.toolRole('update_plan')).toBe('todo');
    expect(msgs[2].stopReason).toBe('end_turn');
  });

  it('tool results: code-mode chunks and plain function output', () => {
    const r = customToolResult([
      { type: 'input_text', text: 'Script completed\nWall time 0.3 seconds\nOutput:\n' },
      { type: 'input_text', text: JSON.stringify({ exit_code: 0, output: 'one\n' }) },
      { type: 'input_text', text: JSON.stringify({ exit_code: 2, output: 'two\n' }) },
    ]);
    expect(r).toEqual({ output: 'one\n\ntwo', isError: true });
    expect(customToolResult('plain')).toEqual({ output: 'plain', isError: false });
    expect(functionToolResult('Exit code: 3\nboom').isError).toBe(true);
    expect(functionToolResult({ content: 'ok', success: true })).toEqual({
      output: 'ok',
      isError: false,
    });
    expect(
      customToolResult([{ type: 'input_text', text: 'x'.repeat(40_000) }]).output.length
    ).toBeLessThan(17_000);
  });

  it('role table: shell / edit / todo / poll / other; nothing needs approval by name', () => {
    expect(getAgentAdapter('codex')).toBe(codexAdapter);
    expect(codexAdapter.toolRole('exec_command')).toBe('shell');
    expect(codexAdapter.toolRole('exec')).toBe('shell');
    expect(codexAdapter.toolRole('shell')).toBe('shell');
    expect(codexAdapter.toolRole('write_stdin')).toBe('poll');
    expect(codexAdapter.toolRole('web_search')).toBe('web');
    expect(codexAdapter.toolRole('mcp__thing')).toBe('other');
    expect(codexAdapter.toolRole('Bash')).toBe('other'); // Claude names mean nothing here
    expect(requiresApproval('exec_command', codexAdapter.tools)).toBe(false);
    expect(codexAdapter.terminal.launchCommand()).toBe('codex');
  });
});

describe('Codex approval box', () => {
  const pane = read('approval-pane.txt');

  it('parses the live box captured from tmux', () => {
    const box = parseCodexApprovalBox(pane)!;
    expect(box.question).toBe('Would you like to run the following command?');
    expect(box.options.map((o) => o.label)).toEqual([
      'Yes, proceed',
      "Yes, and don't ask again for commands that start with `pwd`",
      'No, and tell Codex what to do differently',
    ]);
    expect(box.hotkeys).toEqual(['y', 'p', 'esc']);
    expect(box.selected).toBe(0);
    expect(box.environment).toBe('local');
    expect(box.reason).toMatch(/outside the sandbox/);
    expect(box.command).toMatch(/^pwd && ls -la && rg --files/);
  });

  it('surfaces as the active choice prompt (what get_highlights / Herald read)', () => {
    const c = detectCodexActiveChoicePrompt(pane)!;
    expect(c.options).toHaveLength(3);
    expect(c.multiSelect).toBe(false);
    expect(c.question).toMatch(/^Would you like to run the following command\?\n\$ pwd/);
    expect(codexAdapter.terminal.detectActiveChoicePrompt(pane)).toEqual(c);
    expect(codexAdapter.terminal.parsePermissionPrompt(pane)?.options).toHaveLength(3);
    expect(codexAdapter.terminal.approvalPromptRe.test(pane)).toBe(true);
    // the stuck detector treats it as "blocked on the user"
    expect(readPane(pane).prompt).toBe(true);
  });

  it('ignores a numbered list in the conversation and a box scrolled away', () => {
    const list = [
      '• Do you want to clean up? Options:',
      '  1. Remove dead code',
      '  2. Split the watcher',
      '',
      '› Ask Codex to do anything',
      '  GPT-6.1-Sol default · ~/x',
    ].join('\n');
    expect(parseCodexApprovalBox(list)).toBeNull();
    const scrolled = pane + '\n' + Array.from({ length: 8 }, (_, i) => `• line ${i}`).join('\n');
    expect(parseCodexApprovalBox(scrolled)).toBeNull();
    expect(parseCodexApprovalBox('')).toBeNull();
  });

  it('start-up screen', () => {
    expect(classifyCodexStartupPane('› Ask Codex to do anything\n ? for shortcuts')).toBe('ready');
    expect(classifyCodexStartupPane('Do you trust the contents of this directory?')).toBe(
      'trust_prompt'
    );
    expect(classifyCodexStartupPane('')).toBe('starting');
  });

  it('choice keys are not implemented yet: the plan sends nothing and says so', () => {
    const plan = codexAdapter.terminal.choiceKeys({
      selectedIndices: [0],
      optionCount: 3,
      multiSelect: false,
    });
    expect(plan.steps).toEqual([]);
    expect(plan.warnings[0]).toMatch(/not supported/);
  });
});

describe('Codex discovery', () => {
  it('codex home precedence', () => {
    expect(
      resolveCodexHome({ configured: '/c', env: { CODEX_HOME: '/e' }, codeHome: '/h/.claude' })
    ).toBe('/c');
    expect(resolveCodexHome({ env: { CODEX_HOME: '/e' }, codeHome: '/h/.claude' })).toBe('/e');
    expect(resolveCodexHome({ env: {}, codeHome: '/h/.claude' })).toBe('/h/.codex');
    expect(resolveCodexHome({ env: {}, codeHome: '/srv/claude-data' })).toBe(
      path.join(os.homedir(), '.codex')
    );
  });

  it('process + file names', () => {
    expect(isCodexArgv(['node', '/home/u/.nvm/versions/node/v24/bin/codex'])).toBe(true);
    expect(isCodexArgv(['/x/vendor/x86_64-unknown-linux-musl/bin/codex'])).toBe(true);
    expect(isCodexArgv(['/x/bin/codex', 'app-server', '--listen', 'unix://'])).toBe(false);
    expect(isCodexArgv(['node', '/x/bin/claude'])).toBe(false);
    expect(
      resumeIdFromArgv(['node', 'codex', 'resume', '01A18489-6c75-7bb1-ab42-09c09097479d'])
    ).toBe('01a18489-6c75-7bb1-ab42-09c09097479d');
    expect(resumeIdFromArgv(['node', 'codex'])).toBeNull();
    const f =
      '/h/.codex/sessions/2026/10/28/rollout-2026-10-28T15-02-41-01a18489-6c75-7bb1-ab42-09c09097479d.jsonl';
    expect(rolloutIdOf(f)).toBe('01a18489-6c75-7bb1-ab42-09c09097479d');
    expect(isCodexRollout(f)).toBe(true);
    expect(
      isCodexRollout('/h/.claude/projects/-x/01a18489-6c75-7bb1-ab42-09c09097479d.jsonl')
    ).toBe(false);
  });

  it('date dirs cover the process lifetime (local dates), bounded', () => {
    const start = new Date(2026, 9, 28, 15, 0).getTime();
    expect(dateDirsSince(start, start + 3600_000)).toEqual([
      '2026/10/27',
      '2026/10/28',
      '2026/10/29',
    ]);
    const long = dateDirsSince(start - 60 * 86_400_000, start);
    expect(long.length).toBeLessThanOrEqual(6);
    expect(long).toContain('2026/10/28');
  });

  it('pickRollout: same cwd, written since start, born after start first, then newest', () => {
    const start = 1_000_000;
    const c = (
      id: string,
      cwd: string,
      mtimeMs: number,
      born: number | null
    ): RolloutCandidate => ({
      file: `/s/rollout-${id}.jsonl`,
      id,
      mtimeMs,
      meta: { id, cwd, startedAt: born },
    });
    const old = c('old', '/p', start + 50_000, start - 60_000); // previous TUI's thread, still written
    const mine = c('mine', '/p', start + 40_000, start + 3_000);
    const other = c('other', '/q', start + 90_000, start + 1_000);
    const stale = c('stale', '/p', start - 10_000, start - 90_000);
    const proc = { cwd: '/p', startedAt: start, resumeId: null };
    expect(pickRollout(proc, [old, mine, other, stale])?.id).toBe('mine');
    expect(pickRollout(proc, [old, other, stale])?.id).toBe('old');
    expect(pickRollout(proc, [other, stale])).toBeNull();
    expect(pickRollout(proc, [old, mine], new Set([mine.file]))?.id).toBe('old');
    // resume: the named thread, even if not written since the start ...
    expect(pickRollout({ ...proc, resumeId: 'stale' }, [old, stale])?.id).toBe('stale');
    // ... unless a thread was born after the start (a /new after the resume)
    expect(pickRollout({ ...proc, resumeId: 'stale' }, [old, mine, stale])?.id).toBe('mine');
  });

  it('finds the rollout of a codex process on disk', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    try {
      const now = Date.now();
      const d = new Date(now);
      const dir = path.join(
        home,
        'sessions',
        String(d.getFullYear()),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0')
      );
      fs.mkdirSync(dir, { recursive: true });
      const write = (id: string, cwd: string, born: number) => {
        const f = path.join(dir, `rollout-2026-10-28T15-02-41-${id}.jsonl`);
        fs.writeFileSync(
          f,
          JSON.stringify({
            type: 'session_meta',
            payload: { id, cwd, timestamp: new Date(born).toISOString() },
          }) + '\n'
        );
        return f;
      };
      const a = write('01a18489-6c75-7bb1-ab42-09c09097479d', home, now - 1000);
      write('01a18488-5806-7d83-b714-d8d4d4589312', '/elsewhere', now - 500);
      fs.writeFileSync(path.join(dir, 'not-a-rollout.jsonl'), '{}\n');
      const idx = new CodexRolloutIndex(home);
      const hit = await idx.findRollout({
        pid: 1,
        cwd: fs.realpathSync(home),
        startedAt: now - 5000,
        resumeId: null,
      });
      expect(hit?.file).toBe(a);
      expect(hit?.id).toBe('01a18489-6c75-7bb1-ab42-09c09097479d');
      expect(
        await idx.findRollout({ pid: 1, cwd: '/nowhere', startedAt: now - 5000, resumeId: null })
      ).toBeNull();
      // `codex resume <id>` of a thread in an old date dir
      const oldDir = path.join(home, 'sessions', '2025', '01', '02');
      fs.mkdirSync(oldDir, { recursive: true });
      const resumed = path.join(
        oldDir,
        'rollout-2025-01-02T10-00-00-0a000000-0000-4000-8000-000000000001.jsonl'
      );
      fs.writeFileSync(
        resumed,
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: '0a000000-0000-4000-8000-000000000001',
            cwd: '/old',
            timestamp: '2025-01-02T10:00:00Z',
          },
        }) + '\n'
      );
      const r = await idx.findRollout({
        pid: 2,
        cwd: '/old',
        startedAt: now - 5000,
        resumeId: '0a000000-0000-4000-8000-000000000001',
      });
      expect(r?.file).toBe(resumed);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('finds the codex process under a pane in a fake /proc', async () => {
    const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proc-'));
    try {
      const mk = (pid: number, argv: string[], children: number[]) => {
        fs.mkdirSync(path.join(proc, String(pid), 'task', String(pid)), { recursive: true });
        fs.writeFileSync(path.join(proc, String(pid), 'cmdline'), argv.join('\0') + '\0');
        fs.writeFileSync(
          path.join(proc, String(pid), 'task', String(pid), 'children'),
          children.join(' ')
        );
      };
      mk(10, ['-fish'], [11]);
      mk(11, ['node', '/home/u/.nvm/versions/node/v24/bin/codex'], [12]);
      mk(12, ['/x/vendor/bin/codex'], []);
      mk(20, ['-fish'], [21]);
      mk(21, ['node', '/x/bin/claude'], []);
      expect(await findCodexPid(10, proc)).toBe(11);
      expect(await findCodexPid(20, proc)).toBeNull();
    } finally {
      fs.rmSync(proc, { recursive: true, force: true });
    }
  });
});
