import * as path from 'path';
import * as os from 'os';
import { WorkGroupManager } from '../src/work-group-manager';

// Mock uuid to return predictable IDs
let uuidCounter = 0;
jest.mock('uuid', () => ({
  v4: () => `test-uuid-${uuidCounter++}`,
}));

// Mock child_process exec (used by detectCommits and promisify)
jest.mock('child_process', () => ({
  exec: jest.fn((cmd: string, opts: any, cb?: any) => {
    const callback = cb || opts;
    callback(null, { stdout: '', stderr: '' });
  }),
}));

// Mock fs at the module level so properties are always configurable
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn().mockReturnValue('[]'),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  statSync: jest.fn(),
}));

// Import the mocked fs after jest.mock
import * as fs from 'fs';

const STATE_FILE = path.join(os.homedir(), '.companion', 'work-groups.json');

const mockTmux = {
  createWorktree: jest.fn(),
  createSession: jest.fn(),
  removeWorktree: jest.fn(),
  killSession: jest.fn(),
  sessionExists: jest.fn(),
  capturePane: jest.fn(),
  generateSessionName: jest.fn(),
} as any;

const mockInjector = {
  sendInput: jest.fn(),
} as any;

const mockWatcher = {
  on: jest.fn(),
  getStatus: jest.fn().mockReturnValue({}),
  refreshTmuxPaths: jest.fn(),
} as any;

function setupDefaultMocks() {
  mockTmux.createWorktree.mockResolvedValue({
    success: true,
    worktreePath: '/tmp/test-wt',
    branch: 'parallel/test-task',
  });
  mockTmux.createSession.mockResolvedValue({ success: true });
  mockTmux.generateSessionName.mockReturnValue('companion-test-task-abc');
  mockTmux.capturePane.mockResolvedValue('claude > ');
  mockTmux.killSession.mockResolvedValue(undefined);
  mockTmux.removeWorktree.mockResolvedValue({ success: true });
  mockTmux.sessionExists.mockResolvedValue(true);
  mockInjector.sendInput.mockResolvedValue(true);
  mockWatcher.refreshTmuxPaths.mockResolvedValue(undefined);
}

function makeRequest(overrides: Partial<{
  name: string;
  foremanSessionId: string;
  foremanTmuxSession: string;
  parentDir: string;
  workers: Array<{
    taskSlug: string;
    taskDescription: string;
    planSection: string;
    files: string[];
  }>;
}> = {}) {
  return {
    name: 'Test Group',
    foremanSessionId: 'foreman-session-1',
    foremanTmuxSession: 'foreman-tmux-1',
    parentDir: '/tmp/repo',
    workers: [
      {
        taskSlug: 'add-auth',
        taskDescription: 'Add authentication module',
        planSection: '## Auth\nImplement login/logout',
        files: ['src/auth.ts', 'src/middleware.ts'],
      },
      {
        taskSlug: 'add-api',
        taskDescription: 'Add API routes',
        planSection: '## API\nImplement REST endpoints',
        files: ['src/routes.ts'],
      },
    ],
    ...overrides,
  };
}

describe('WorkGroupManager', () => {
  let manager: WorkGroupManager;
  let statusChangeHandler: (data: any) => void;
  let otherSessionHandler: (data: any) => void;

  beforeEach(() => {
    uuidCounter = 0;
    jest.useFakeTimers();
    jest.clearAllMocks();
    setupDefaultMocks();

    // Reset fs mocks to defaults for loadState during construction
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.readFileSync as jest.Mock).mockReturnValue('[]');
    (fs.writeFileSync as jest.Mock).mockImplementation(() => {});
    (fs.mkdirSync as jest.Mock).mockImplementation(() => undefined);

    manager = new WorkGroupManager(mockTmux, mockInjector, mockWatcher);

    // Capture the event handlers registered on the watcher
    for (const call of mockWatcher.on.mock.calls) {
      if (call[0] === 'status-change') {
        statusChangeHandler = call[1];
      }
      if (call[0] === 'other-session-activity') {
        otherSessionHandler = call[1];
      }
    }
  });

  afterEach(() => {
    manager.stop();
    jest.useRealTimers();
  });

  // Helper: create a work group while advancing fake timers for waitForCliReady
  async function createGroupWithTimers(request?: ReturnType<typeof makeRequest>) {
    const req = request ?? makeRequest();
    const promise = manager.createWorkGroup(req);
    // Each worker calls waitForCliReady which has a 1s setTimeout loop.
    // Advance timers enough for all workers to pass their wait.
    // We need multiple advances because each worker is spawned sequentially.
    for (let i = 0; i < req.workers.length; i++) {
      await jest.advanceTimersByTimeAsync(2000);
    }
    return promise;
  }

  describe('createWorkGroup', () => {
    it('creates a group with workers, calling tmux.createWorktree and tmux.createSession for each', async () => {
      const request = makeRequest();
      const group = await createGroupWithTimers(request);

      expect(group.name).toBe('Test Group');
      expect(group.status).toBe('active');
      expect(group.workers).toHaveLength(2);
      expect(group.foremanSessionId).toBe('foreman-session-1');
      expect(group.foremanTmuxSession).toBe('foreman-tmux-1');

      // createWorktree called once per worker
      expect(mockTmux.createWorktree).toHaveBeenCalledTimes(2);
      expect(mockTmux.createWorktree).toHaveBeenCalledWith('/tmp/repo', 'parallel/add-auth');
      expect(mockTmux.createWorktree).toHaveBeenCalledWith('/tmp/repo', 'parallel/add-api');

      // createSession called once per worker
      expect(mockTmux.createSession).toHaveBeenCalledTimes(2);

      // generateSessionName called once per worker
      expect(mockTmux.generateSessionName).toHaveBeenCalledTimes(2);

      // Each worker should be in 'working' status
      for (const worker of group.workers) {
        expect(worker.status).toBe('working');
        expect(worker.worktreePath).toBe('/tmp/test-wt');
        expect(worker.tmuxSessionName).toBe('companion-test-task-abc');
      }

      // sendInput called once per worker (to inject the prompt)
      expect(mockInjector.sendInput).toHaveBeenCalledTimes(2);

      // refreshTmuxPaths called once per worker
      expect(mockWatcher.refreshTmuxPaths).toHaveBeenCalledTimes(2);
    });

    it('sets worker to error when createWorktree fails', async () => {
      mockTmux.createWorktree.mockResolvedValue({
        success: false,
        error: 'Branch already exists',
      });

      const request = makeRequest({
        workers: [{
          taskSlug: 'fail-task',
          taskDescription: 'Will fail',
          planSection: 'plan',
          files: [],
        }],
      });

      const group = await manager.createWorkGroup(request);
      expect(group.workers[0].status).toBe('error');
      expect(group.workers[0].error).toBe('Branch already exists');
      expect(mockTmux.createSession).not.toHaveBeenCalled();
    });

    it('sets worker to error and cleans up worktree when createSession fails', async () => {
      mockTmux.createSession.mockResolvedValue({
        success: false,
        error: 'Session creation failed',
      });

      const request = makeRequest({
        workers: [{
          taskSlug: 'fail-session',
          taskDescription: 'Session fails',
          planSection: 'plan',
          files: [],
        }],
      });

      const group = await manager.createWorkGroup(request);
      expect(group.workers[0].status).toBe('error');
      expect(group.workers[0].error).toBe('Session creation failed');
      // Should clean up the worktree
      expect(mockTmux.removeWorktree).toHaveBeenCalledWith('/tmp/repo', '/tmp/test-wt');
    });
  });

  describe('getWorkGroups / getWorkGroup', () => {
    it('returns correct data after creation', async () => {
      const request = makeRequest();
      const created = await createGroupWithTimers(request);

      const allGroups = manager.getWorkGroups();
      expect(allGroups).toHaveLength(1);
      expect(allGroups[0].id).toBe(created.id);
      expect(allGroups[0].name).toBe('Test Group');

      const single = manager.getWorkGroup(created.id);
      expect(single).toBeDefined();
      expect(single!.id).toBe(created.id);
      expect(single!.workers).toHaveLength(2);
    });

    it('returns undefined for non-existent group', () => {
      const result = manager.getWorkGroup('nonexistent-id');
      expect(result).toBeUndefined();
    });

    it('returns empty array when no groups exist', () => {
      const result = manager.getWorkGroups();
      expect(result).toEqual([]);
    });
  });

  describe('handleStatusChange', () => {
    it('transitions worker to waiting when isWaitingForInput=true', async () => {
      const group = await createGroupWithTimers();
      const worker = group.workers[0];

      statusChangeHandler({
        sessionId: worker.sessionId,
        isWaitingForInput: true,
        lastMessage: { content: 'Should I continue with option A or B?' },
      });

      const updated = manager.getWorkGroup(group.id)!;
      expect(updated.workers[0].status).toBe('waiting');
      expect(updated.workers[0].lastQuestion).toBeDefined();
      expect(updated.workers[0].lastQuestion!.text).toBe('Should I continue with option A or B?');
    });

    it('transitions worker to completed when message starts with "TASK COMPLETE:"', async () => {
      const group = await createGroupWithTimers();
      const worker = group.workers[0];

      statusChangeHandler({
        sessionId: worker.sessionId,
        isWaitingForInput: true,
        lastMessage: { content: 'TASK COMPLETE: Implemented auth module with login/logout' },
      });

      const updated = manager.getWorkGroup(group.id)!;
      expect(updated.workers[0].status).toBe('completed');
      expect(updated.workers[0].completedAt).toBeDefined();
    });

    it('transitions worker to completed when message contains "TASK COMPLETE:"', async () => {
      const group = await createGroupWithTimers();
      const worker = group.workers[0];

      statusChangeHandler({
        sessionId: worker.sessionId,
        isWaitingForInput: true,
        lastMessage: { content: 'All done! TASK COMPLETE: everything is done' },
      });

      const updated = manager.getWorkGroup(group.id)!;
      expect(updated.workers[0].status).toBe('completed');
    });

    it('transitions worker back to working when no longer waiting', async () => {
      const group = await createGroupWithTimers();
      const worker = group.workers[0];

      // First, make worker waiting
      statusChangeHandler({
        sessionId: worker.sessionId,
        isWaitingForInput: true,
        lastMessage: { content: 'Question?' },
      });

      expect(manager.getWorkGroup(group.id)!.workers[0].status).toBe('waiting');

      // Then, worker resumes working
      statusChangeHandler({
        sessionId: worker.sessionId,
        isWaitingForInput: false,
      });

      expect(manager.getWorkGroup(group.id)!.workers[0].status).toBe('working');
      expect(manager.getWorkGroup(group.id)!.workers[0].lastQuestion).toBeUndefined();
    });

    it('does not update completed workers', async () => {
      const group = await createGroupWithTimers();
      const worker = group.workers[0];

      // Complete the worker
      statusChangeHandler({
        sessionId: worker.sessionId,
        isWaitingForInput: true,
        lastMessage: { content: 'TASK COMPLETE: done' },
      });

      expect(manager.getWorkGroup(group.id)!.workers[0].status).toBe('completed');

      // Try to change it back - should be ignored
      statusChangeHandler({
        sessionId: worker.sessionId,
        isWaitingForInput: true,
        lastMessage: { content: 'Some new question?' },
      });

      expect(manager.getWorkGroup(group.id)!.workers[0].status).toBe('completed');
    });

    it('updates lastActivity from currentActivity', async () => {
      const group = await createGroupWithTimers();
      const worker = group.workers[0];

      statusChangeHandler({
        sessionId: worker.sessionId,
        isWaitingForInput: false,
        currentActivity: 'Writing tests for auth module',
      });

      expect(manager.getWorkGroup(group.id)!.workers[0].lastActivity).toBe('Writing tests for auth module');
    });

    it('ignores events without sessionId', async () => {
      await createGroupWithTimers();

      // Should not throw
      statusChangeHandler({
        isWaitingForInput: true,
        lastMessage: { content: 'some content' },
      });
    });

    it('ignores events for unknown session IDs', async () => {
      const group = await createGroupWithTimers();

      statusChangeHandler({
        sessionId: 'unknown-session-id',
        isWaitingForInput: true,
        lastMessage: { content: 'question?' },
      });

      // Workers should remain unchanged
      expect(manager.getWorkGroup(group.id)!.workers[0].status).toBe('working');
      expect(manager.getWorkGroup(group.id)!.workers[1].status).toBe('working');
    });

    it('also matches by tmuxSessionName', async () => {
      const group = await createGroupWithTimers();
      const worker = group.workers[0];

      statusChangeHandler({
        sessionId: worker.tmuxSessionName,
        isWaitingForInput: true,
        lastMessage: { content: 'A question via tmux name' },
      });

      expect(manager.getWorkGroup(group.id)!.workers[0].status).toBe('waiting');
    });
  });

  describe('extractQuestion', () => {
    it('parses question text and numbered options from content', async () => {
      const group = await createGroupWithTimers();
      const worker = group.workers[0];

      statusChangeHandler({
        sessionId: worker.sessionId,
        isWaitingForInput: true,
        lastMessage: {
          content: 'Which approach should I use?\n1. Option A - use middleware\n2. Option B - use decorators\n3. Option C - use manual checks',
        },
      });

      const updated = manager.getWorkGroup(group.id)!;
      const question = updated.workers[0].lastQuestion!;
      expect(question.text).toBe('Which approach should I use?');
      expect(question.options).toHaveLength(3);
      expect(question.options![0].label).toBe('Option A - use middleware');
      expect(question.options![1].label).toBe('Option B - use decorators');
      expect(question.options![2].label).toBe('Option C - use manual checks');
    });

    it('parses bulleted options', async () => {
      const group = await createGroupWithTimers();
      const worker = group.workers[0];

      statusChangeHandler({
        sessionId: worker.sessionId,
        isWaitingForInput: true,
        lastMessage: {
          content: 'What format?\n- JSON\n- YAML\n- TOML',
        },
      });

      const question = manager.getWorkGroup(group.id)!.workers[0].lastQuestion!;
      expect(question.text).toBe('What format?');
      expect(question.options).toHaveLength(3);
      expect(question.options![0].label).toBe('JSON');
      expect(question.options![1].label).toBe('YAML');
      expect(question.options![2].label).toBe('TOML');
    });

    it('parses asterisk-bulleted options', async () => {
      const group = await createGroupWithTimers();
      const worker = group.workers[0];

      statusChangeHandler({
        sessionId: worker.sessionId,
        isWaitingForInput: true,
        lastMessage: {
          content: 'Pick one:\n* First choice\n* Second choice',
        },
      });

      const question = manager.getWorkGroup(group.id)!.workers[0].lastQuestion!;
      expect(question.options).toHaveLength(2);
      expect(question.options![0].label).toBe('First choice');
      expect(question.options![1].label).toBe('Second choice');
    });

    it('handles content with no options', async () => {
      const group = await createGroupWithTimers();
      const worker = group.workers[0];

      statusChangeHandler({
        sessionId: worker.sessionId,
        isWaitingForInput: true,
        lastMessage: {
          content: 'Can you clarify the requirements?',
        },
      });

      const question = manager.getWorkGroup(group.id)!.workers[0].lastQuestion!;
      expect(question.text).toBe('Can you clarify the requirements?');
      expect(question.options).toBeUndefined();
    });

    it('handles parenthesized numbered options like "1)"', async () => {
      const group = await createGroupWithTimers();
      const worker = group.workers[0];

      statusChangeHandler({
        sessionId: worker.sessionId,
        isWaitingForInput: true,
        lastMessage: {
          content: 'Choose:\n1) Alpha\n2) Beta',
        },
      });

      const question = manager.getWorkGroup(group.id)!.workers[0].lastQuestion!;
      expect(question.options).toHaveLength(2);
      expect(question.options![0].label).toBe('Alpha');
      expect(question.options![1].label).toBe('Beta');
    });
  });

  describe('sendWorkerInput', () => {
    it('calls injector.sendInput with correct session name and updates worker status', async () => {
      const group = await createGroupWithTimers();
      const worker = group.workers[0];

      // Put worker in waiting state first
      statusChangeHandler({
        sessionId: worker.sessionId,
        isWaitingForInput: true,
        lastMessage: { content: 'Question?' },
      });

      expect(manager.getWorkGroup(group.id)!.workers[0].status).toBe('waiting');

      mockInjector.sendInput.mockClear();
      const result = await manager.sendWorkerInput(group.id, worker.id, 'Use option A');

      expect(result.success).toBe(true);
      expect(mockInjector.sendInput).toHaveBeenCalledWith('Use option A', worker.tmuxSessionName);

      const updated = manager.getWorkGroup(group.id)!;
      expect(updated.workers[0].status).toBe('working');
      expect(updated.workers[0].lastQuestion).toBeUndefined();
    });

    it('returns error for non-existent group', async () => {
      const result = await manager.sendWorkerInput('bad-group', 'bad-worker', 'text');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Work group not found');
    });

    it('returns error for non-existent worker', async () => {
      const group = await createGroupWithTimers();
      const result = await manager.sendWorkerInput(group.id, 'bad-worker', 'text');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Worker not found');
    });

    it('returns error for worker without tmux session', async () => {
      // Force a worker with no tmux session by making worktree fail
      mockTmux.createWorktree.mockResolvedValue({
        success: false,
        error: 'Failed',
      });

      const group = await manager.createWorkGroup(makeRequest({
        workers: [{
          taskSlug: 'no-tmux',
          taskDescription: 'No tmux',
          planSection: '',
          files: [],
        }],
      }));

      const result = await manager.sendWorkerInput(group.id, group.workers[0].id, 'text');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Worker has no tmux session');
    });
  });

  describe('cancelWorkGroup', () => {
    it('kills sessions and sets group status to cancelled', async () => {
      const group = await createGroupWithTimers();

      mockTmux.killSession.mockClear();
      const result = await manager.cancelWorkGroup(group.id);

      expect(result.success).toBe(true);
      // killSession called for each worker with a tmux session
      expect(mockTmux.killSession).toHaveBeenCalledTimes(2);
      expect(mockTmux.killSession).toHaveBeenCalledWith(group.workers[0].tmuxSessionName);
      expect(mockTmux.killSession).toHaveBeenCalledWith(group.workers[1].tmuxSessionName);

      const updated = manager.getWorkGroup(group.id)!;
      expect(updated.status).toBe('cancelled');
      expect(updated.completedAt).toBeDefined();
    });

    it('returns error for non-existent group', async () => {
      const result = await manager.cancelWorkGroup('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Work group not found');
    });
  });

  describe('checkGroupCompletion', () => {
    it('emits group-ready-to-merge when all workers are completed', async () => {
      const group = await createGroupWithTimers();
      const emitSpy = jest.fn();
      manager.on('group-ready-to-merge', emitSpy);

      // Complete first worker
      statusChangeHandler({
        sessionId: group.workers[0].sessionId,
        isWaitingForInput: true,
        lastMessage: { content: 'TASK COMPLETE: Auth done' },
      });

      // Not yet - second worker still working
      expect(emitSpy).not.toHaveBeenCalled();

      // Complete second worker
      statusChangeHandler({
        sessionId: group.workers[1].sessionId,
        isWaitingForInput: true,
        lastMessage: { content: 'TASK COMPLETE: API done' },
      });

      // Now all workers are done
      expect(emitSpy).toHaveBeenCalledTimes(1);
      expect(emitSpy).toHaveBeenCalledWith({
        groupId: group.id,
        name: 'Test Group',
      });
    });

    it('emits group-ready-to-merge when workers are mix of completed and error', async () => {
      // First worker succeeds, second fails at worktree creation
      mockTmux.createWorktree
        .mockResolvedValueOnce({
          success: true,
          worktreePath: '/tmp/test-wt-1',
          branch: 'parallel/task-a',
        })
        .mockResolvedValueOnce({
          success: false,
          error: 'Failed to create worktree',
        });

      const group = await createGroupWithTimers();
      const emitSpy = jest.fn();
      manager.on('group-ready-to-merge', emitSpy);

      // Second worker is already in error state from creation
      expect(group.workers[1].status).toBe('error');

      // Complete first worker
      statusChangeHandler({
        sessionId: group.workers[0].sessionId,
        isWaitingForInput: true,
        lastMessage: { content: 'TASK COMPLETE: done' },
      });

      expect(emitSpy).toHaveBeenCalledTimes(1);
    });

    it('does not emit when some workers are still working', async () => {
      const group = await createGroupWithTimers();
      const emitSpy = jest.fn();
      manager.on('group-ready-to-merge', emitSpy);

      // Only complete one worker
      statusChangeHandler({
        sessionId: group.workers[0].sessionId,
        isWaitingForInput: true,
        lastMessage: { content: 'TASK COMPLETE: half done' },
      });

      expect(emitSpy).not.toHaveBeenCalled();
    });
  });

  describe('state persistence', () => {
    it('saveState writes groups to STATE_FILE as JSON', async () => {
      const writeSpy = fs.writeFileSync as jest.Mock;

      await createGroupWithTimers();

      // saveState is called during createWorkGroup
      expect(writeSpy).toHaveBeenCalled();

      const lastCall = writeSpy.mock.calls[writeSpy.mock.calls.length - 1];
      expect(lastCall[0]).toBe(STATE_FILE);

      const written = JSON.parse(lastCall[1]);
      expect(Array.isArray(written)).toBe(true);
      expect(written).toHaveLength(1);
      expect(written[0].name).toBe('Test Group');
      expect(written[0].workers).toHaveLength(2);
    });

    it('loadState restores groups from disk', () => {
      // Clean up existing manager
      manager.stop();
      jest.clearAllMocks();

      const savedGroups = [{
        id: 'restored-group-1',
        name: 'Restored Group',
        foremanSessionId: 'foreman-1',
        foremanTmuxSession: 'foreman-tmux-1',
        status: 'active',
        workers: [{
          id: 'restored-worker-1',
          sessionId: 'session-1',
          tmuxSessionName: 'tmux-session-1',
          taskSlug: 'restored-task',
          taskDescription: 'A restored task',
          branch: 'parallel/restored-task',
          worktreePath: '/tmp/restored-wt',
          status: 'working',
          commits: [],
          startedAt: Date.now(),
        }],
        createdAt: Date.now(),
      }];

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(savedGroups));

      // Creating a new manager triggers loadState in constructor
      const newManager = new WorkGroupManager(mockTmux, mockInjector, mockWatcher);

      const groups = newManager.getWorkGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0].id).toBe('restored-group-1');
      expect(groups[0].name).toBe('Restored Group');
      expect(groups[0].workers).toHaveLength(1);
      expect(groups[0].workers[0].taskSlug).toBe('restored-task');

      newManager.stop();
    });

    it('loadState handles missing state file gracefully', () => {
      manager.stop();
      jest.clearAllMocks();

      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const newManager = new WorkGroupManager(mockTmux, mockInjector, mockWatcher);
      expect(newManager.getWorkGroups()).toEqual([]);

      newManager.stop();
    });

    it('loadState handles corrupt state file gracefully', () => {
      manager.stop();
      jest.clearAllMocks();

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue('not valid json{{{');

      // Should not throw
      const newManager = new WorkGroupManager(mockTmux, mockInjector, mockWatcher);
      expect(newManager.getWorkGroups()).toEqual([]);

      newManager.stop();
    });

    it('saveState/loadState round-trips correctly', async () => {
      let savedData = '';
      (fs.writeFileSync as jest.Mock).mockImplementation((_path: string, data: string) => {
        savedData = data;
      });

      await createGroupWithTimers();

      // Now create a new manager that loads what was saved
      manager.stop();
      jest.clearAllMocks();

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(savedData);
      (fs.writeFileSync as jest.Mock).mockImplementation(() => {});

      const newManager = new WorkGroupManager(mockTmux, mockInjector, mockWatcher);
      const groups = newManager.getWorkGroups();

      expect(groups).toHaveLength(1);
      expect(groups[0].name).toBe('Test Group');
      expect(groups[0].workers).toHaveLength(2);
      expect(groups[0].workers[0].taskSlug).toBe('add-auth');
      expect(groups[0].workers[1].taskSlug).toBe('add-api');
      expect(groups[0].status).toBe('active');

      newManager.stop();
    });
  });

  describe('getWorkGroupForSession', () => {
    it('returns group matching foreman session ID', async () => {
      const group = await createGroupWithTimers();
      const found = manager.getWorkGroupForSession('foreman-session-1');
      expect(found).toBeDefined();
      expect(found!.id).toBe(group.id);
    });

    it('returns group matching worker session ID', async () => {
      const group = await createGroupWithTimers();
      const found = manager.getWorkGroupForSession(group.workers[0].sessionId);
      expect(found).toBeDefined();
      expect(found!.id).toBe(group.id);
    });

    it('returns undefined for unknown session ID', async () => {
      await createGroupWithTimers();
      const found = manager.getWorkGroupForSession('unknown-session');
      expect(found).toBeUndefined();
    });
  });
});
