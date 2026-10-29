/**
 * Codex polish: missing `codex` on launch, launch mode from argv (bypass
 * switch), pane-only approval boxes (Codex edit approvals) as waits.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { agentCommandMissing, createAgentSession } from '../session-spawn';
import { codexLaunchMode } from '../agents/codex/discovery';
import { BackgroundWorkMonitor, PANE_APPROVAL_ACTIVITY } from '../background-work';

const FIXTURES = path.join(__dirname, '..', 'agents', '__tests__', 'fixtures', 'codex');

describe('agentCommandMissing', () => {
  it.each([
    'bash: codex: command not found',
    'zsh: command not found: codex',
    'fish: Unknown command: codex\nfish: \n codex --dangerously-bypass-approvals-and-sandbox\n ^~~~^',
    "fish: Unknown command 'codex'",
    'sh: 1: codex: not found',
  ])('%s', (line) => {
    expect(agentCommandMissing(`$ codex\n${line}\n$ `, 'codex')).toBe(true);
  });

  it('the launch line itself or a running Codex is not "missing"', () => {
    expect(
      agentCommandMissing('$ codex --dangerously-bypass-approvals-and-sandbox\n', 'codex')
    ).toBe(false);
    expect(agentCommandMissing('bash: codexx: command not found', 'codex')).toBe(false);
    expect(
      agentCommandMissing(
        fs.readFileSync(path.join(FIXTURES, 'live-approval-patch.txt'), 'utf-8'),
        'codex'
      )
    ).toBe(false);
  });
});

describe('createAgentSession: Codex not installed', () => {
  const baseDeps = (tmux: Record<string, unknown>) => ({
    tmux: {
      createSession: async () => ({ success: true }),
      generateSessionName: () => 's',
      ...tmux,
    } as never,
    storeTmuxSessionConfig: jest.fn(),
    sessionNameStore: { get: () => undefined, set: () => {} },
    watcher: { markSessionAsNew: jest.fn(), refreshTmuxPaths: async () => {} },
    log: () => {},
  });
  const sleep = async () => {};

  it('reports it, removes the session and stores nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdx-missing-'));
    try {
      const killSession = jest.fn(async () => ({ success: true }));
      const deps = baseDeps({
        capturePane: async () =>
          '$ codex --dangerously-bypass-approvals-and-sandbox\nfish: Unknown command: codex\n',
        killSession,
      });
      const r = await createAgentSession(deps, { workingDir: dir, agent: 'codex' }, { sleep });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/Codex is not installed/);
      expect(r.error).toMatch(/npm install -g @openai\/codex/);
      expect(killSession).toHaveBeenCalledWith('s');
      expect(deps.storeTmuxSessionConfig).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops watching as soon as Codex draws its screen', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdx-ok-'));
    try {
      const capturePane = jest.fn(async () => '› Ask Codex to do anything\n\n  ? for shortcuts');
      const deps = baseDeps({ capturePane, killSession: jest.fn() });
      const r = await createAgentSession(deps, { workingDir: dir, agent: 'codex' }, { sleep });
      expect(r.success).toBe(true);
      expect(capturePane).toHaveBeenCalledTimes(1);
      expect(deps.storeTmuxSessionConfig).toHaveBeenCalledWith('s', dir, true, {
        permissionMode: 'bypassPermissions',
        agent: 'codex',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Claude launches are not watched', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-ok-'));
    try {
      const capturePane = jest.fn(async () => 'bash: claude: command not found');
      const r = await createAgentSession(baseDeps({ capturePane }), { workingDir: dir }, { sleep });
      expect(r.success).toBe(true);
      expect(capturePane).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('codexLaunchMode', () => {
  const node = ['node', '/x/bin/codex'];
  it.each([
    [[...node, '--dangerously-bypass-approvals-and-sandbox'], 'bypass'],
    [[...node, '--yolo'], 'bypass'],
    [[...node, '-a', 'never', '-s', 'danger-full-access'], 'bypass'],
    [[...node, '--ask-for-approval=never', '--sandbox=danger-full-access'], 'bypass'],
    [[...node, '-a', 'never'], 'default'],
    [[...node, '-a', 'on-request'], 'default'],
    [node, 'default'],
    [[...node, 'resume', '01a18489-0000-0000-0000-000000000000'], 'default'],
  ])('%j -> %s', (argv, mode) => {
    expect(codexLaunchMode(argv as string[])).toBe(mode);
  });
});

describe('pane-only approval box (Codex edit approval)', () => {
  const box = fs.readFileSync(path.join(FIXTURES, 'live-approval-patch.txt'), 'utf-8');

  function monitor() {
    let now = 1_000_000;
    const changes: Array<[string, boolean]> = [];
    const m = new BackgroundWorkMonitor({
      runningAgents: () => 0,
      now: () => now,
      paneApproval: (id, cap) => id.startsWith('cdx') && /Would you like to make/.test(cap),
      onPaneApprovalChange: (id, up) => changes.push([id, up]),
    });
    return { m, changes, advance: (ms: number) => (now += ms) };
  }

  it('a working session with the box up is waiting; edges fire once', () => {
    const { m, changes } = monitor();
    expect(m.overlay('cdx', false, [])).toEqual({ waiting: false });
    m.noteCapture('cdx', box);
    m.noteCapture('cdx', box);
    expect(changes).toEqual([['cdx', true]]);
    expect(m.overlay('cdx', false, [])).toEqual({
      waiting: true,
      currentActivity: PANE_APPROVAL_ACTIVITY,
    });
    m.noteCapture('cdx', '› Ask Codex to do anything');
    expect(changes).toEqual([
      ['cdx', true],
      ['cdx', false],
    ]);
    expect(m.overlay('cdx', false, [])).toEqual({ waiting: false });
  });

  it('a stale reading is unknown (no wait)', () => {
    const { m, advance } = monitor();
    m.noteCapture('cdx', box);
    advance(31_000);
    expect(m.overlay('cdx', false, [])).toEqual({ waiting: false });
  });

  it('sessions the detector does not claim (Claude) are untouched', () => {
    const { m, changes } = monitor();
    m.noteCapture('claude-proj', box);
    expect(changes).toEqual([]);
    expect(m.overlay('claude-proj', false, [])).toEqual({ waiting: false });
  });

  it('the real Codex detector reads the edit box as a choice', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { codexAdapter } = require('../agents/codex');
    const choice = codexAdapter.terminal.detectActiveChoicePrompt(box);
    expect(choice?.options.length).toBe(3);
  });
});
