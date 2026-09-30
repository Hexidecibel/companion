import { LocalSessionSource, LocalSourceDeps } from '../src/herald/session-source';

const DIVIDER = '─'.repeat(80);
const LIVE_BOX = [
  '  Some earlier output from the session.',
  DIVIDER,
  ' ☐ Approach',
  '',
  'How thorough should the parser rewrite be?',
  '',
  '❯ 1. Robust/lenient',
  '     Handle numbered, cursor-only, and bulleted option layouts.',
  '  2. Match this exact format',
  '     Tightly target the format I am capturing now.',
  '  3. Type something.',
  DIVIDER,
  '  4. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
  '',
].join('\n');

function deps(overrides: Partial<LocalSourceDeps> = {}) {
  const sent: string[] = [];
  const d: LocalSourceDeps = {
    watcher: {
      getServerSummary: jest.fn(async () => ({
        sessions: [
          { id: 'companion', name: 'companion', projectPath: '/src/companion', status: 'waiting' as const, lastActivity: 100, tmuxSessionName: 'companion' },
          { id: 'notes', name: 'notes', projectPath: '/src/notes', status: 'working' as const, lastActivity: 90, currentActivity: 'Editing README' },
          { id: 'build', name: 'build', projectPath: '/src/build', status: 'waiting' as const, lastActivity: 80 },
          { id: 'old', name: 'old', projectPath: '/src/old', status: 'idle' as const, lastActivity: 1, inactive: true },
        ],
      })),
      getMessages: jest.fn((id?: string) => {
        if (id === 'build') {
          return [
            { id: 'u', type: 'user', content: 'run the tests', timestamp: 1 },
            {
              id: 'a1',
              type: 'assistant',
              content: 'Running the suite.',
              timestamp: 2,
              toolCalls: [{ id: 'tu-9', name: 'Bash', input: { command: 'npm test' }, status: 'pending' }],
            },
          ] as any;
        }
        if (id === 'companion') {
          return [
            { id: 'u', type: 'user', content: 'refactor', timestamp: 1 },
            { id: 'a1', type: 'assistant', content: 'Done refactoring. Should I push to main?', timestamp: 5 },
          ] as any;
        }
        return [];
      }),
    },
    injector: {
      sendInput: jest.fn(async () => true),
      sendChoice: jest.fn(async () => true),
      checkSessionExists: jest.fn(async () => true),
    },
    sessionNames: { getAll: () => ({ companion: 'Companion Main' }) },
    capturePane: jest.fn(async (name: string) => (name === 'companion' ? LIVE_BOX : 'normal output\n❯ ')),
    onSent: (tmux, text, tag) => sent.push(`${tmux}|${text}|${tag}`),
    ...overrides,
  };
  return { d, sent };
}

describe('LocalSessionSource', () => {
  it('builds snapshots: live choice from the pane, approvals and questions from the transcript', async () => {
    const { d } = deps();
    const src = new LocalSessionSource(d);
    const list = await src.listSessions();
    const by = Object.fromEntries(list.map((s) => [s.sessionId, s]));

    expect(by.companion.sessionName).toBe('Companion Main');
    expect(by.companion.status).toBe('waiting');
    expect(by.companion.pendingChoice?.question).toMatch(/How thorough/);
    expect(by.companion.pendingChoice?.options.map((o) => o.label)).toEqual(expect.arrayContaining(['Robust/lenient', 'Match this exact format']));
    // A live choice supersedes the plain trailing question.
    expect(by.companion.pendingQuestion).toBeNull();

    expect(by.notes.status).toBe('working');
    expect(by.notes.currentActivity).toBe('Editing README');
    expect(by.notes.pendingChoice).toBeNull();

    expect(by.build.status).toBe('waiting');
    expect(by.build.pendingApproval).toEqual({ tool: 'Bash', detail: 'npm test', toolUseId: 'tu-9' });

    expect(by.old.inactive).toBe(true);
    expect(d.capturePane).not.toHaveBeenCalledWith('old');
  });

  it('turn-ended question makes an otherwise idle session "waiting"', async () => {
    const { d } = deps({ capturePane: jest.fn(async () => '') });
    const s = (await new LocalSessionSource(d).listSessions()).find((x) => x.sessionId === 'companion')!;
    expect(s.status).toBe('waiting');
    expect(s.pendingQuestion).toBe('Should I push to main?');
    expect(s.lastTurnKey).toBe('a1:5');
  });

  it('memoizes transcript parsing per lastActivity and shares in-flight listings', async () => {
    const { d } = deps();
    const src = new LocalSessionSource(d);
    await Promise.all([src.listSessions(), src.listSessions()]);
    expect(d.watcher.getServerSummary).toHaveBeenCalledTimes(1);
    await src.listSessions();
    const calls = (d.watcher.getMessages as jest.Mock).mock.calls.filter(([id]) => id === 'build').length;
    expect(calls).toBe(1);
  });

  it('loads a skipped transcript on demand (idle sessions after a daemon start) and never caches an empty read', async () => {
    const loaded = new Set<string>();
    const { d } = deps({ capturePane: jest.fn(async () => '') });
    const base = d.watcher.getMessages as jest.Mock;
    d.watcher.getMessages = jest.fn((id?: string) => (id === 'build' && !loaded.has('build') ? [] : base(id)));
    d.watcher.ensureConversationLoaded = jest.fn((id: string) => {
      loaded.add(id);
      return true;
    });
    const src = new LocalSessionSource(d);
    const build = (await src.listSessions()).find((x) => x.sessionId === 'build')!;
    expect(d.watcher.ensureConversationLoaded).toHaveBeenCalledWith('build');
    expect(build.pendingApproval?.tool).toBe('Bash');
    expect(build.lastTurnKey).toBe('a1:2');
    const t = await src.getRecentTranscript('build', 1);
    expect(t.assistantTurns[0].text).toBe('Running the suite.');
  });

  it('retries an empty transcript on the next poll instead of memoizing it', async () => {
    const { d } = deps({ capturePane: jest.fn(async () => '') });
    let ready = false;
    const base = d.watcher.getMessages as jest.Mock;
    d.watcher.getMessages = jest.fn((id?: string) => (id === 'companion' && !ready ? [] : base(id)));
    const src = new LocalSessionSource(d);
    expect((await src.listSessions()).find((x) => x.sessionId === 'companion')!.lastTurnKey).toBeNull();
    ready = true;
    expect((await src.listSessions()).find((x) => x.sessionId === 'companion')!.lastTurnKey).toBe('a1:5');
  });

  it('sends through the injector and runs the sent hook', async () => {
    const { d, sent } = deps();
    const src = new LocalSessionSource(d);
    expect(await src.sendText('companion', 'hello', 'herald-1')).toBe(true);
    expect(d.injector.sendInput).toHaveBeenCalledWith('hello', 'companion');
    expect(await src.sendChoice('companion', 1, 4, false)).toBe(true);
    expect(d.injector.sendChoice).toHaveBeenCalledWith([1], 4, false, undefined, 'companion');
    expect(sent).toEqual(['companion|hello|herald-1', 'companion||choice']);
  });

  it('a failed pane capture yields no choice rather than an error', async () => {
    const { d } = deps({ capturePane: jest.fn(async () => Promise.reject(new Error('tmux gone'))) });
    const list = await new LocalSessionSource(d).listSessions();
    expect(list.every((s) => s.pendingChoice === null)).toBe(true);
  });

  it('pre-send re-validation fails closed when the pane cannot be read', async () => {
    const { d } = deps({ capturePane: jest.fn(async () => Promise.reject(new Error('tmux gone'))) });
    await expect(new LocalSessionSource(d).getLiveChoice('companion')).rejects.toThrow(/could not read/);
    const { d: d2 } = deps({ capturePane: jest.fn(async () => '') });
    await expect(new LocalSessionSource(d2).getLiveChoice('companion')).rejects.toThrow(/empty/);
  });

  it('pre-send re-validation still reports a readable pane with no prompt as null', async () => {
    const { d } = deps({ capturePane: jest.fn(async () => 'normal output\n❯ ') });
    await expect(new LocalSessionSource(d).getLiveChoice('companion')).resolves.toBeNull();
  });
});
