import { InputInjector } from '../input-injector';

// ---------------------------------------------------------------------------
// Mock child_process.spawnSync at the module level
// ---------------------------------------------------------------------------
const mockSpawnSync = jest.fn();
jest.mock('child_process', () => ({
  spawn: jest.fn(),
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

// Helper to build spawnSync return values
function ok(stdout = '') {
  return { status: 0, stdout: Buffer.from(stdout), stderr: Buffer.from('') };
}
function fail(stderr = '') {
  return { status: 1, stdout: Buffer.from(''), stderr: Buffer.from(stderr) };
}

describe('InputInjector overlay dismissal', () => {
  let injector: InputInjector;

  beforeEach(() => {
    injector = new InputInjector('test-session');
    mockSpawnSync.mockReset();
    // Default: session exists
    mockSpawnSync.mockReturnValue(ok());
  });

  // -----------------------------------------------------------------------
  // Helpers to inspect calls
  // -----------------------------------------------------------------------
  function callArgs(): string[][] {
    return mockSpawnSync.mock.calls.map((c: unknown[]) => [c[0] as string, ...(c[1] as string[])]);
  }

  function sentKeys(): string[][] {
    return callArgs().filter((a) => a[0] === 'tmux' && a[1] === 'send-keys');
  }

  function capturedPanes(): string[][] {
    return callArgs().filter((a) => a[0] === 'tmux' && a[1] === 'capture-pane');
  }

  // -----------------------------------------------------------------------
  // Pattern: Background tasks panel
  // -----------------------------------------------------------------------
  it('sends Escape before input when background tasks overlay is detected', async () => {
    const bgTasksPanel = [
      '  ┃ Agent (local)                                  running  ┃',
      '  ┃                                                         ┃',
      '  ┃ ↑↓ to select · Enter to view · Esc to close            ┃',
    ].join('\n');

    mockSpawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'has-session') return ok();
      if (args[0] === 'capture-pane') return ok(bgTasksPanel);
      if (args[0] === 'send-keys') return ok();
      return ok();
    });

    await injector.sendInput('hello', 'test-session');

    // Should have captured pane, sent Escape, then sent the actual input
    expect(capturedPanes().length).toBe(1);
    const keys = sentKeys();
    // First send-keys should be Escape
    expect(keys[0]).toContain('Escape');
    // Then literal text and Enter
    expect(keys.some((k) => k.includes('-l'))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Pattern: Generic "Esc to close" overlay
  // -----------------------------------------------------------------------
  it('sends Escape for generic "Esc to close" overlay', async () => {
    const genericOverlay = 'Some panel content\nPress Esc to close';

    mockSpawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'has-session') return ok();
      if (args[0] === 'capture-pane') return ok(genericOverlay);
      if (args[0] === 'send-keys') return ok();
      return ok();
    });

    await injector.sendInput('test', 'test-session');

    const keys = sentKeys();
    expect(keys[0]).toContain('Escape');
  });

  // -----------------------------------------------------------------------
  // No overlay — input sent directly
  // -----------------------------------------------------------------------
  it('does not send Escape when no overlay is detected', async () => {
    const normalPrompt = '> waiting for input...';

    mockSpawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'has-session') return ok();
      if (args[0] === 'capture-pane') return ok(normalPrompt);
      if (args[0] === 'send-keys') return ok();
      return ok();
    });

    await injector.sendInput('hello', 'test-session');

    const keys = sentKeys();
    // No Escape key sent
    expect(keys.every((k) => !k.includes('Escape'))).toBe(true);
    // Input was still sent
    expect(keys.some((k) => k.includes('-l'))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Capture failure — fail open
  // -----------------------------------------------------------------------
  it('proceeds with input when pane capture fails', async () => {
    mockSpawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'has-session') return ok();
      if (args[0] === 'capture-pane') return fail('pane not found');
      if (args[0] === 'send-keys') return ok();
      return ok();
    });

    const result = await injector.sendInput('hello', 'test-session');

    // Should still succeed — fail open
    expect(result).toBe(true);
    const keys = sentKeys();
    // No Escape (capture returned empty string from fail)
    expect(keys.every((k) => !k.includes('Escape'))).toBe(true);
    // Input was sent
    expect(keys.some((k) => k.includes('-l'))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // sendChoice also dismisses overlays
  // -----------------------------------------------------------------------
  it('dismisses overlay before sending choice', async () => {
    const overlay = '↑↓ to select · Enter to view · Esc to close';

    mockSpawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'has-session') return ok();
      if (args[0] === 'capture-pane') return ok(overlay);
      if (args[0] === 'send-keys') return ok();
      return ok();
    });

    await injector.sendChoice([0], 3, false, undefined, 'test-session');

    const keys = sentKeys();
    expect(keys[0]).toContain('Escape');
  });

  // -----------------------------------------------------------------------
  // cancelInput also dismisses overlays
  // -----------------------------------------------------------------------
  it('dismisses overlay before sending Ctrl+C', async () => {
    const overlay = 'Esc to close';

    mockSpawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'has-session') return ok();
      if (args[0] === 'capture-pane') return ok(overlay);
      if (args[0] === 'send-keys') return ok();
      return ok();
    });

    await injector.cancelInput('test-session');

    const keys = sentKeys();
    // First send-keys is Escape (dismiss), second is C-c (cancel)
    expect(keys[0]).toContain('Escape');
    expect(keys[1]).toContain('C-c');
  });

  // -----------------------------------------------------------------------
  // Pattern matching: doesn't match normal content containing "Esc"
  // -----------------------------------------------------------------------
  it('does not false-positive on "Esc" in normal text', async () => {
    const normalText = 'Press Escape to exit vim. Use :wq to save.';

    mockSpawnSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'has-session') return ok();
      if (args[0] === 'capture-pane') return ok(normalText);
      if (args[0] === 'send-keys') return ok();
      return ok();
    });

    await injector.sendInput('hello', 'test-session');

    const keys = sentKeys();
    // "Escape" in normal text should NOT trigger overlay dismissal
    // (pattern matches "Esc to close", not "Escape")
    expect(keys.every((k) => !k.includes('Escape'))).toBe(true);
  });
});
