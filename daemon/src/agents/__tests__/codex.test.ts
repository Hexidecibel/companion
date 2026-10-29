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
  detectCodexOverlay,
  parseCodexApprovalBox,
  classifyCodexStartupPane,
  readCodexPromptBox,
} from '../codex/terminal';
import { isPermissionChoice } from '../../herald/babysit/tracker';
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

  it('a trailing escalated call without output waits on the approval box', () => {
    const msgs = parseCodexFile(fixture('pending-call.jsonl'));
    const last = msgs[msgs.length - 1];
    expect(last.type).toBe('assistant');
    const tc = last.toolCalls![last.toolCalls!.length - 1];
    expect(tc.status).toBe('running');
    expect(tc.input.sandbox_permissions).toBe('require_escalated');
    expect(codexTurnEnded(msgs)).toBe(false);
    expect(codexAdapter.transcript.detectWaitingForInput(msgs)).toBe(true);
    expect(codexCurrentActivity(msgs)).toBe('Waiting for approval');
    expect(codexAdapter.transcript.getPendingApprovalTools(msgs)).toEqual([
      { name: 'exec_command', id: tc.id },
    ]);
    // a plain (sandboxed) running call is just running
    const plain = msgs.map((m, i) =>
      i === msgs.length - 1
        ? {
            ...m,
            toolCalls: m.toolCalls!.map((t) => ({
              ...t,
              input: { ...t.input, sandbox_permissions: undefined },
            })),
          }
        : m
    );
    expect(codexAdapter.transcript.detectWaitingForInput(plain)).toBe(false);
    expect(codexAdapter.transcript.getPendingApprovalTools(plain)).toEqual([]);
    expect(codexCurrentActivity(plain)).toMatch(/^Running: pwd && ls -la/);
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

  it('choice keys: the option digit (selects + confirms); feedback = Esc then a pasted message', () => {
    const t = codexAdapter.terminal;
    expect(
      t.choiceKeys({ selectedIndices: [1], optionCount: 3, multiSelect: false }).steps
    ).toEqual([{ type: 'key', key: '2' }]);
    const fb = t.choiceKeys({
      selectedIndices: [],
      optionCount: 3,
      multiSelect: false,
      otherText: 'use wget instead',
    });
    expect(fb.steps[0]).toEqual({ type: 'key', key: 'Escape' });
    expect(fb.steps).toContainEqual({ type: 'paste', text: 'use wget instead' });
    expect(fb.steps.filter((s) => s.type === 'key').map((s) => (s as { key: string }).key)).toEqual(
      ['Escape', 'Enter']
    );
    expect(t.requiresLiveChoiceBox).toBe(true);
  });

  it('text = bracketed paste + Enter; interrupt = Esc, never Ctrl+C', () => {
    const t = codexAdapter.terminal;
    const steps = t.textKeys('line one\nline two');
    expect(steps[0]).toEqual({ type: 'paste', text: 'line one\nline two' });
    expect(steps.filter((s) => s.type === 'key')).toEqual([{ type: 'key', key: 'Enter' }]);
    expect(t.interruptKeys()).toEqual([{ type: 'key', key: 'Escape' }]);
    // Claude keeps typing + Enter and Ctrl+C
    const c = getAgentAdapter('claude').terminal;
    expect(c.textKeys('hi')[0]).toEqual({ type: 'text', text: 'hi' });
    expect(c.interruptKeys()).toEqual([{ type: 'key', key: 'C-c' }]);
  });

  it('launch line and env', () => {
    const t = codexAdapter.terminal;
    expect(t.launchCommand()).toBe('codex');
    expect(t.launchCommand('bypassPermissions')).toBe(
      'codex --dangerously-bypass-approvals-and-sandbox'
    );
    expect(t.launchEnv?.({ codexHome: '/h/.codex' })).toEqual({ CODEX_HOME: '/h/.codex' });
    expect(t.launchEnv?.({})).toEqual({});
  });
});

describe('Codex TUI (live captures, codex-cli 0.165)', () => {
  it('exec approval box', () => {
    const pane = read('live-approval-exec.txt');
    const box = parseCodexApprovalBox(pane)!;
    expect(box.command).toBe('curl -sI https://example.com | head -1');
    expect(box.hotkeys).toEqual(['y', 'p', 'esc']);
    expect(box.selected).toBe(0);
    expect(readCodexPromptBox(pane).found).toBe(false);
    expect(detectCodexOverlay(pane)).toBe(false);
  });

  it('edit approval box (Destination / Description)', () => {
    const pane = read('live-approval-patch.txt');
    const box = parseCodexApprovalBox(pane)!;
    expect(box.question).toBe('Would you like to make the following edits?');
    expect(box.destination).toBe('/tmp/claude-1000/cdx/newdir/x.txt');
    expect(box.description).toMatch(/retry without sandbox/);
    expect(box.hotkeys).toEqual(['y', 'a', 'esc']);
    const c = detectCodexActiveChoicePrompt(pane)!;
    expect(c.question).toMatch(/Destination: \/tmp/);
    expect(codexAdapter.terminal.approvalPromptRe.test(pane)).toBe(true);
    // never the babysitter's to answer
    expect(
      isPermissionChoice({
        header: c.header,
        question: c.question,
        options: c.options.map((o) => ({ label: o.label })),
        multiSelect: false,
      } as Parameters<typeof isPermissionChoice>[0])
    ).toBe(true);
  });

  it('composer: dim placeholder is empty, a typed draft is a draft', () => {
    const idle = read('live-idle.ansi');
    expect(readCodexPromptBox(idle)).toEqual({ found: true, draft: '' });
    expect(classifyCodexStartupPane(idle)).toBe('ready');
    expect(detectCodexOverlay(idle)).toBe(false);
    // eslint-disable-next-line no-control-regex
    const draft = idle.replace(/\x1b\[2mAsk Codex to do anything\x1b\[0m/, 'hello draft');
    expect(readCodexPromptBox(draft)).toEqual({ found: true, draft: 'hello draft' });
    const multi = [
      '› Write a 300 word poem about rain.',
      '',
      '• Working (3s • esc to interrupt)',
      '',
      '› line one',
      '  line two',
      '',
      '  GPT-6.1-Sol default · ~/x',
      '',
    ].join('\n');
    expect(readCodexPromptBox(multi)).toEqual({ found: true, draft: 'line one\nline two' });
    // a plain capture still knows the placeholder
    expect(readCodexPromptBox('› Ask Codex to do anything\n\n  GPT · ~/x\n').draft).toBe('');
  });

  it('overlays: transcript pager and the Ctrl+C dialog; not the trust prompt', () => {
    expect(detectCodexOverlay(read('live-backtrack.txt'))).toBe(true);
    const dialog = read('live-ctrlc-dialog.txt');
    expect(detectCodexOverlay(dialog)).toBe(true);
    expect(readCodexPromptBox(dialog).found).toBe(false);
    expect(parseCodexApprovalBox(dialog)).toBeNull();
    expect(detectCodexOverlay('› Ask Codex to do anything\n  ? / esc close')).toBe(true);
    const trust = read('live-trust.txt');
    expect(classifyCodexStartupPane(trust)).toBe('trust_prompt');
    expect(detectCodexOverlay(trust)).toBe(false);
    expect(parseCodexApprovalBox(trust)).toBeNull();
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

  it('pickRollout: two TUIs started seconds apart in one folder keep their own threads', () => {
    const s = 5_000_000;
    const c = (id: string, mtimeMs: number, born: number): RolloutCandidate => ({
      file: `/s/rollout-${id}.jsonl`,
      id,
      mtimeMs,
      meta: { id, cwd: '/p', startedAt: born },
    });
    // P1 started at s (thread born s+2s, written just now); P2 3 s later (thread born s+4.5s)
    const t1 = c('t1', s + 60_000, s + 2_000);
    const t2 = c('t2', s + 30_000, s + 4_500);
    const p2 = { cwd: '/p', startedAt: s + 3_000, resumeId: null };
    const p1 = { cwd: '/p', startedAt: s, resumeId: null };
    // newer process claims first, by thread birth (not by the latest write)
    expect(pickRollout(p2, [t1, t2])?.id).toBe('t2');
    expect(pickRollout(p1, [t1, t2], new Set([t2.file]))?.id).toBe('t1');
    // a /new in P1 later: P1's newest-born thread wins for P1
    const t3 = c('t3', s + 70_000, s + 50_000);
    expect(pickRollout(p1, [t1, t2, t3], new Set([t2.file]))?.id).toBe('t3');
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
