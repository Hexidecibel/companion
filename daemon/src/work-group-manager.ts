import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { WorkGroup, WorkerSession, WorkerQuestion } from './types';
import { TmuxManager } from './tmux-manager';
import { InputInjector } from './input-injector';
import { SessionWatcher } from './watcher';

const execAsync = promisify(exec);

const STATE_FILE = path.join(os.homedir(), '.companion', 'work-groups.json');

interface SpawnWorkerRequest {
  taskSlug: string;
  taskDescription: string;
  planSection: string;
  files: string[];
}

interface SpawnWorkGroupRequest {
  name: string;
  foremanSessionId: string;
  foremanTmuxSession: string;
  parentDir: string;
  planFile?: string;
  workers: SpawnWorkerRequest[];
}

interface MergeResult {
  success: boolean;
  mergeCommit?: string;
  conflicts?: string[];
  error?: string;
}

export class WorkGroupManager extends EventEmitter {
  private groups: Map<string, WorkGroup> = new Map();
  private tmux: TmuxManager;
  private injector: InputInjector;
  private watcher: SessionWatcher;
  private gitEnabled: boolean;
  private monitorInterval: NodeJS.Timeout | null = null;

  constructor(
    tmux: TmuxManager,
    injector: InputInjector,
    watcher: SessionWatcher,
    gitEnabled: boolean = true
  ) {
    super();
    this.tmux = tmux;
    this.injector = injector;
    this.watcher = watcher;
    this.gitEnabled = gitEnabled;

    this.loadState();
    this.startMonitoring();

    // Listen to watcher events for all sessions (active and non-active)
    this.watcher.on('status-change', (data) => this.handleStatusChange(data));
    this.watcher.on('other-session-activity', (data) => this.handleStatusChange(data));
  }

  async createWorkGroup(request: SpawnWorkGroupRequest): Promise<WorkGroup> {
    if (!this.gitEnabled) {
      throw new Error('Git integration is disabled');
    }

    const groupId = uuidv4();
    const group: WorkGroup = {
      id: groupId,
      name: request.name,
      foremanSessionId: request.foremanSessionId,
      foremanTmuxSession: request.foremanTmuxSession,
      status: 'active',
      workers: [],
      createdAt: Date.now(),
      planFile: request.planFile,
    };

    // Spawn each worker
    for (const workerReq of request.workers) {
      const worker = await this.spawnWorker(request.parentDir, workerReq);
      group.workers.push(worker);
    }

    this.groups.set(groupId, group);
    this.saveState();
    this.emitUpdate(group);

    console.log(
      `WorkGroupManager: Created group "${group.name}" with ${group.workers.length} workers`
    );
    return group;
  }

  private async spawnWorker(
    parentDir: string,
    request: SpawnWorkerRequest
  ): Promise<WorkerSession> {
    const workerId = uuidv4();
    const branchName = `parallel/${request.taskSlug}`;

    const worker: WorkerSession = {
      id: workerId,
      sessionId: '',
      tmuxSessionName: '',
      taskSlug: request.taskSlug,
      taskDescription: request.taskDescription,
      branch: branchName,
      worktreePath: '',
      status: 'spawning',
      commits: [],
      startedAt: Date.now(),
    };

    try {
      // Create git worktree
      const wtResult = await this.tmux.createWorktree(parentDir, branchName);
      if (!wtResult.success || !wtResult.worktreePath) {
        worker.status = 'error';
        worker.error = wtResult.error || 'Failed to create worktree';
        return worker;
      }

      worker.worktreePath = wtResult.worktreePath;
      worker.branch = wtResult.branch || branchName;

      // Create tmux session in the worktree directory
      const sessionName = this.tmux.generateSessionName(wtResult.worktreePath);
      const tmuxResult = await this.tmux.createSession(sessionName, wtResult.worktreePath, true);

      if (!tmuxResult.success) {
        worker.status = 'error';
        worker.error = tmuxResult.error || 'Failed to create tmux session';
        // Clean up worktree on failure
        await this.tmux.removeWorktree(parentDir, wtResult.worktreePath);
        return worker;
      }

      worker.tmuxSessionName = sessionName;

      // Derive sessionId from worktree path (same encoding as watcher uses)
      // Encode path the same way Claude CLI does: replace / and _ with -
      worker.sessionId = wtResult.worktreePath.replace(/[/_]/g, '-');

      // Wait for Claude CLI to start up
      await this.waitForCliReady(sessionName);

      // Inject the worker prompt
      const prompt = this.buildWorkerPrompt(request);
      await this.injector.sendInput(prompt, sessionName);

      worker.status = 'working';

      // Refresh watcher so it picks up the new session's conversation files
      await this.watcher.refreshTmuxPaths();

      console.log(`WorkGroupManager: Spawned worker "${request.taskSlug}" in ${sessionName}`);
    } catch (err) {
      worker.status = 'error';
      worker.error = err instanceof Error ? err.message : String(err);
      console.error(`WorkGroupManager: Failed to spawn worker "${request.taskSlug}":`, err);
    }

    return worker;
  }

  private buildWorkerPrompt(request: SpawnWorkerRequest): string {
    const fileList =
      request.files.length > 0
        ? request.files.map((f) => `- \`${f}\``).join('\n')
        : '(see plan section below)';

    return [
      'You are implementing one item from a parallel work plan. Other items are being',
      'worked on simultaneously in separate sessions. Stay focused on your task only.',
      '',
      `## Task: ${request.taskSlug}`,
      '',
      request.planSection,
      '',
      '## Scoped Files',
      fileList,
      '',
      '## Rules',
      '- Only modify files relevant to this task',
      '- Follow TDD: write tests first, then implement, then refactor',
      '- Run type check when done (npx tsc --noEmit or equivalent)',
      '- Commit with a descriptive message when done (do NOT push)',
      '- If you need clarification, ask — someone is monitoring',
      '- When finished, your final message should start with "TASK COMPLETE:"',
      '  followed by a summary of what was done and commit SHAs',
    ].join('\n');
  }

  private async waitForCliReady(sessionName: string, maxWaitMs: number = 15000): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const output = await this.tmux.capturePane(sessionName, 20);
      // Look for common Claude CLI ready indicators
      if (
        output.includes('claude') &&
        (output.includes('>') || output.includes('$') || output.includes('What'))
      ) {
        console.log(
          `WorkGroupManager: CLI ready in ${sessionName} after ${Date.now() - startTime}ms`
        );
        return;
      }
    }
    console.log(`WorkGroupManager: CLI wait timeout in ${sessionName}, proceeding anyway`);
  }

  private handleStatusChange(data: {
    sessionId?: string;
    isWaitingForInput?: boolean;
    lastMessage?: { content: string };
    currentActivity?: string;
  }): void {
    if (!data.sessionId) return;

    for (const group of this.groups.values()) {
      if (group.status !== 'active') continue;

      for (const worker of group.workers) {
        if (worker.sessionId !== data.sessionId && worker.tmuxSessionName !== data.sessionId)
          continue;
        if (worker.status === 'completed' || worker.status === 'error') continue;

        // Update activity
        if (data.currentActivity) {
          worker.lastActivity = data.currentActivity;
        }

        // Check for completion
        if (data.isWaitingForInput && data.lastMessage?.content) {
          const content = data.lastMessage.content;
          if (content.startsWith('TASK COMPLETE:') || content.includes('TASK COMPLETE:')) {
            worker.status = 'completed';
            worker.completedAt = Date.now();
            this.detectCommits(worker);
            this.saveState();
            this.emitUpdate(group);
            this.checkGroupCompletion(group);
            console.log(`WorkGroupManager: Worker "${worker.taskSlug}" completed`);
            return;
          }

          // Worker is waiting for input (question from Claude)
          worker.status = 'waiting';
          worker.lastQuestion = this.extractQuestion(content);
          this.saveState();
          this.emitUpdate(group);
          this.emit('worker-waiting', { groupName: group.name, worker });
          return;
        }

        // Worker is actively working
        if (!data.isWaitingForInput && worker.status === 'waiting') {
          worker.status = 'working';
          worker.lastQuestion = undefined;
          this.saveState();
          this.emitUpdate(group);
        }
      }
    }
  }

  private extractQuestion(content: string): WorkerQuestion {
    // Try to extract question text and options from the message
    const lines = content.split('\n').filter((l) => l.trim());
    const text = lines[0] || content.substring(0, 200);

    // Look for numbered or bulleted options
    const options: { label: string }[] = [];
    for (const line of lines.slice(1)) {
      const match = line.match(/^\s*(?:\d+[.)]\s*|[-*]\s+)(.+)/);
      if (match) {
        options.push({ label: match[1].trim() });
      }
    }

    return {
      text,
      options: options.length > 0 ? options : undefined,
      timestamp: Date.now(),
    };
  }

  private async detectCommits(worker: WorkerSession): Promise<void> {
    if (!worker.worktreePath) return;
    try {
      // Get commits on this branch that aren't on the base branch
      const { stdout } = await execAsync(
        'git log --oneline --format="%H" HEAD ^main 2>/dev/null || git log --oneline --format="%H" HEAD ^master 2>/dev/null || true',
        { cwd: worker.worktreePath }
      );
      worker.commits = stdout
        .trim()
        .split('\n')
        .filter((l) => l.length > 0);
    } catch {
      // Ignore errors
    }
  }

  private checkGroupCompletion(group: WorkGroup): void {
    const allDone = group.workers.every((w) => w.status === 'completed' || w.status === 'error');
    if (allDone) {
      console.log(`WorkGroupManager: All workers in group "${group.name}" have finished`);
      this.emit('group-ready-to-merge', { groupId: group.id, name: group.name });
    }
  }

  async dismissWorkGroup(groupId: string): Promise<{ success: boolean }> {
    const group = this.groups.get(groupId);
    if (!group) return { success: false };
    if (group.status === 'completed' || group.status === 'cancelled' || group.status === 'failed') {
      this.groups.delete(groupId);
      this.saveState();
      this.emitUpdate(group);
      return { success: true };
    }
    return { success: false };
  }

  getWorkGroups(): WorkGroup[] {
    return Array.from(this.groups.values());
  }

  getWorkGroup(id: string): WorkGroup | undefined {
    return this.groups.get(id);
  }

  getWorkGroupForSession(sessionId: string): WorkGroup | undefined {
    for (const group of this.groups.values()) {
      if (group.foremanSessionId === sessionId) return group;
      for (const worker of group.workers) {
        if (worker.sessionId === sessionId) return group;
      }
    }
    return undefined;
  }

  async mergeWorkGroup(groupId: string): Promise<MergeResult> {
    const group = this.groups.get(groupId);
    if (!group) {
      return { success: false, error: 'Work group not found' };
    }

    const completedWorkers = group.workers.filter((w) => w.status === 'completed');
    if (completedWorkers.length === 0) {
      return { success: false, error: 'No completed workers to merge' };
    }

    group.status = 'merging';
    this.saveState();
    this.emitUpdate(group);

    // Find the main repo directory from a worker's worktree
    const firstWorker = group.workers[0];
    let mainRepoDir: string;
    try {
      const { stdout } = await execAsync('git rev-parse --show-toplevel', {
        cwd: firstWorker.worktreePath,
      });
      // The worktree's toplevel IS the worktree. We need the main repo.
      // Read the .git file in the worktree to find it.
      const gitFile = path.join(firstWorker.worktreePath, '.git');
      if (fs.existsSync(gitFile) && fs.statSync(gitFile).isFile()) {
        const gitContent = fs.readFileSync(gitFile, 'utf-8').trim();
        const match = gitContent.match(/gitdir:\s*(.+)/);
        if (match) {
          // gitdir points to .git/worktrees/<name> — go up 3 levels
          mainRepoDir = path.resolve(path.dirname(match[1]), '..', '..');
        } else {
          mainRepoDir = stdout.trim();
        }
      } else {
        mainRepoDir = stdout.trim();
      }
    } catch (err) {
      group.status = 'failed';
      group.error = 'Could not determine main repo directory';
      this.saveState();
      this.emitUpdate(group);
      return { success: false, error: group.error };
    }

    // Try octopus merge of completed branches
    const branches = completedWorkers.map((w) => w.branch);
    const branchArgs = branches.join(' ');

    try {
      // Ensure we're on the right branch in the main repo
      await execAsync('git checkout main 2>/dev/null || git checkout master', { cwd: mainRepoDir });

      // Try the merge
      await execAsync(`git merge ${branchArgs} --no-edit`, {
        cwd: mainRepoDir,
      });

      // Get the merge commit SHA
      const { stdout: sha } = await execAsync('git rev-parse HEAD', { cwd: mainRepoDir });
      group.mergeCommit = sha.trim();
      group.status = 'completed';
      group.completedAt = Date.now();

      // Clean up worktrees and branches for completed workers
      for (const worker of completedWorkers) {
        await this.cleanupWorker(mainRepoDir, worker, true);
      }

      this.saveState();
      this.emitUpdate(group);

      console.log(`WorkGroupManager: Merged group "${group.name}" → ${group.mergeCommit}`);
      return { success: true, mergeCommit: group.mergeCommit };
    } catch (err) {
      // Merge conflict — abort and report
      try {
        await execAsync('git merge --abort', { cwd: mainRepoDir });
      } catch {
        // Ignore abort errors
      }

      // Determine which files conflict
      const conflicts: string[] = [];
      try {
        const { stdout: statusOutput } = await execAsync(
          'git diff --name-only --diff-filter=U 2>/dev/null || true',
          { cwd: mainRepoDir }
        );
        conflicts.push(
          ...statusOutput
            .trim()
            .split('\n')
            .filter((l) => l.length > 0)
        );
      } catch {
        // Ignore
      }

      group.status = 'active'; // Revert to active so user can retry
      group.error = `Merge conflict in: ${conflicts.join(', ') || 'unknown files'}`;
      this.saveState();
      this.emitUpdate(group);

      return { success: false, conflicts, error: group.error };
    }
  }

  async cancelWorkGroup(groupId: string): Promise<{ success: boolean; error?: string }> {
    const group = this.groups.get(groupId);
    if (!group) {
      return { success: false, error: 'Work group not found' };
    }

    // Find main repo dir for worktree cleanup
    let mainRepoDir: string | null = null;
    for (const worker of group.workers) {
      if (worker.worktreePath) {
        try {
          const gitFile = path.join(worker.worktreePath, '.git');
          if (fs.existsSync(gitFile) && fs.statSync(gitFile).isFile()) {
            const gitContent = fs.readFileSync(gitFile, 'utf-8').trim();
            const match = gitContent.match(/gitdir:\s*(.+)/);
            if (match) {
              mainRepoDir = path.resolve(path.dirname(match[1]), '..', '..');
              break;
            }
          }
        } catch {
          // Continue
        }
      }
    }

    // Kill all worker sessions and clean up worktrees
    for (const worker of group.workers) {
      if (worker.tmuxSessionName) {
        await this.tmux.killSession(worker.tmuxSessionName);
      }
      if (mainRepoDir) {
        await this.cleanupWorker(mainRepoDir, worker, true);
      }
    }

    group.status = 'cancelled';
    group.completedAt = Date.now();
    this.saveState();
    this.emitUpdate(group);

    console.log(`WorkGroupManager: Cancelled group "${group.name}"`);
    return { success: true };
  }

  async retryWorker(
    groupId: string,
    workerId: string
  ): Promise<{ success: boolean; error?: string }> {
    const group = this.groups.get(groupId);
    if (!group) return { success: false, error: 'Work group not found' };

    const workerIndex = group.workers.findIndex((w) => w.id === workerId);
    if (workerIndex < 0) return { success: false, error: 'Worker not found' };

    const oldWorker = group.workers[workerIndex];
    if (oldWorker.status !== 'error')
      return { success: false, error: 'Worker is not in error state' };

    // Clean up old worker
    if (oldWorker.tmuxSessionName) {
      await this.tmux.killSession(oldWorker.tmuxSessionName);
    }

    // Find parent dir from another worker or from the foreman
    let parentDir: string | null = null;
    for (const w of group.workers) {
      if (w.worktreePath && w.id !== workerId) {
        try {
          const gitFile = path.join(w.worktreePath, '.git');
          if (fs.existsSync(gitFile)) {
            const content = fs.readFileSync(gitFile, 'utf-8').trim();
            const match = content.match(/gitdir:\s*(.+)/);
            if (match) {
              parentDir = path.resolve(path.dirname(match[1]), '..', '..');
              break;
            }
          }
        } catch {
          // Continue
        }
      }
    }

    if (!parentDir) {
      return { success: false, error: 'Cannot determine parent repo directory' };
    }

    // Clean up old worktree if it exists
    if (oldWorker.worktreePath) {
      await this.tmux.removeWorktree(parentDir, oldWorker.worktreePath);
    }

    // Re-spawn
    const newWorker = await this.spawnWorker(parentDir, {
      taskSlug: oldWorker.taskSlug,
      taskDescription: oldWorker.taskDescription,
      planSection: '', // We don't have the original plan section; it was injected at creation
      files: [],
    });

    group.workers[workerIndex] = newWorker;
    this.saveState();
    this.emitUpdate(group);

    return { success: true };
  }

  async sendWorkerInput(
    groupId: string,
    workerId: string,
    text: string
  ): Promise<{ success: boolean; error?: string }> {
    const group = this.groups.get(groupId);
    if (!group) return { success: false, error: 'Work group not found' };

    const worker = group.workers.find((w) => w.id === workerId);
    if (!worker) return { success: false, error: 'Worker not found' };

    if (!worker.tmuxSessionName) return { success: false, error: 'Worker has no tmux session' };

    const success = await this.injector.sendInput(text, worker.tmuxSessionName);
    if (success) {
      worker.status = 'working';
      worker.lastQuestion = undefined;
      this.saveState();
      this.emitUpdate(group);
    }

    return { success };
  }

  private async cleanupWorker(
    mainRepoDir: string,
    worker: WorkerSession,
    deleteBranch: boolean = false
  ): Promise<void> {
    // Kill tmux session
    if (worker.tmuxSessionName) {
      try {
        await this.tmux.killSession(worker.tmuxSessionName);
      } catch {
        // Ignore
      }
    }

    // Remove worktree
    if (worker.worktreePath) {
      try {
        await this.tmux.removeWorktree(mainRepoDir, worker.worktreePath);
      } catch {
        // Ignore
      }
    }

    // Delete the branch (best-effort)
    if (deleteBranch && worker.branch) {
      try {
        await execAsync(`git branch -D "${worker.branch}"`, { cwd: mainRepoDir });
      } catch {
        // Branch may already be gone
      }
    }
  }

  private startMonitoring(): void {
    // Poll every 5 seconds to check for stale workers and update status
    this.monitorInterval = setInterval(() => this.monitor(), 5000);
  }

  private async monitor(): Promise<void> {
    for (const group of this.groups.values()) {
      if (group.status !== 'active') continue;

      let changed = false;
      for (const worker of group.workers) {
        if (worker.status === 'completed' || worker.status === 'error') continue;

        // Check if tmux session is still alive
        if (worker.tmuxSessionName) {
          const exists = await this.tmux.sessionExists(worker.tmuxSessionName);
          if (!exists && worker.status !== 'spawning') {
            worker.status = 'error';
            worker.error = 'Tmux session disappeared';
            changed = true;
            this.emit('worker-error', { groupName: group.name, worker });
          }
        }

        // Check for worker status via watcher
        if (worker.sessionId) {
          const status = this.watcher.getStatus(worker.sessionId);
          if (status.currentActivity && status.currentActivity !== worker.lastActivity) {
            worker.lastActivity = status.currentActivity;
            changed = true;
          }
        }
      }

      if (changed) {
        this.saveState();
        this.emitUpdate(group);
        this.checkGroupCompletion(group);
      }
    }
  }

  private emitUpdate(group: WorkGroup): void {
    this.emit('work-group-update', group);
  }

  private loadState(): void {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const content = fs.readFileSync(STATE_FILE, 'utf-8');
        const groups = JSON.parse(content) as WorkGroup[];
        for (const group of groups) {
          // Only restore active/merging groups — completed/cancelled ones are historical
          this.groups.set(group.id, group);
        }
        console.log(`WorkGroupManager: Loaded ${groups.length} work groups from disk`);
      }
    } catch (err) {
      console.error('WorkGroupManager: Failed to load state:', err);
    }
  }

  private saveState(): void {
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const groups = Array.from(this.groups.values());
      fs.writeFileSync(STATE_FILE, JSON.stringify(groups, null, 2));
    } catch (err) {
      console.error('WorkGroupManager: Failed to save state:', err);
    }
  }

  stop(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.saveState();
  }
}
