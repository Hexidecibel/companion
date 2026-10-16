import { execFile } from 'child_process';
import { promisify } from 'util';
import { trackedExecAsync, runTmux } from './impact/sub';
import { tmuxSnapshot, invalidateTmuxSnapshot } from './tmux-snapshot';
import * as path from 'path';

const execAsync = trackedExecAsync('tmux-manager');
const execFileAsync = promisify(execFile);

export interface TmuxSessionInfo {
  name: string;
  created: number;
  attached: boolean;
  windows: number;
  workingDir?: string;
  tagged?: boolean;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  isMain: boolean;
}

export interface WorktreeResult {
  success: boolean;
  worktreePath?: string;
  branch?: string;
  error?: string;
}

export class TmuxManager {
  private sessionPrefix: string;

  constructor(sessionPrefix: string = 'companion') {
    this.sessionPrefix = sessionPrefix;
  }

  /**
   * List all tmux sessions (not filtered by prefix, so user can switch between any sessions)
   */
  async listSessions(): Promise<TmuxSessionInfo[]> {
    try {
      // Shared, ~2 s cached `tmux list-panes -a` (one subprocess for every
      // caller) + the cached COMPANION_APP tag per session.
      const snap = await tmuxSnapshot.get();
      const sessions: TmuxSessionInfo[] = [];
      // Include all sessions so users can interact with any tmux session
      for (const row of snap.sessions) {
        sessions.push({
          name: row.name,
          created: parseInt(row.created, 10) * 1000, // Convert to ms
          attached: row.attached === '1',
          windows: row.windows,
          workingDir: row.workingDir,
          tagged: await tmuxSnapshot.isTagged(row),
        });
      }
      return sessions;
    } catch (err) {
      // No sessions or tmux not running
      return [];
    }
  }

  /**
   * Check if a session exists
   */
  async sessionExists(name: string): Promise<boolean> {
    try {
      await runTmux(['has-session', '-t', name], 'tmux-manager', { timeoutMs: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Tag an existing tmux session as managed by Companion
   */
  async tagSession(name: string): Promise<boolean> {
    try {
      await runTmux(['set-environment', '-t', name, 'COMPANION_APP', '1'], 'tmux-manager');
      invalidateTmuxSnapshot(name);
      console.log(`TmuxManager: Tagged session "${name}" as managed`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if a tmux session is tagged as managed by Companion
   */
  async isTagged(name: string): Promise<boolean> {
    try {
      const { stdout } = await runTmux(
        ['show-environment', '-t', name, 'COMPANION_APP'],
        'tmux-manager',
        {
          timeoutMs: 3000,
        }
      );
      return stdout.trim().includes('COMPANION_APP=1');
    } catch {
      return false;
    }
  }

  /**
   * Create a new tmux session and start a coding session in it
   */
  async createSession(
    name: string,
    workingDir: string,
    startCli: boolean = true
  ): Promise<{ success: boolean; error?: string }> {
    // Validate session name
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');

    // Check if session already exists
    if (await this.sessionExists(safeName)) {
      return { success: false, error: `Session "${safeName}" already exists` };
    }

    try {
      // Create detached tmux session in the specified directory. execFile, no
      // shell: the directory is passed as one argument, never interpolated.
      await execFileAsync('tmux', ['new-session', '-d', '-s', safeName, '-c', workingDir]);

      // Tag session as managed by Companion so daemon only monitors our sessions
      await execFileAsync('tmux', ['set-environment', '-t', safeName, 'COMPANION_APP', '1']);
      invalidateTmuxSnapshot(safeName);

      console.log(`TmuxManager: Created session "${safeName}" in ${workingDir} (tagged)`);

      // Start CLI in the session if requested
      if (startCli) {
        // Small delay to let the session initialize
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Send the CLI command
        await execFileAsync('tmux', ['send-keys', '-t', safeName, 'claude', 'Enter']);
        console.log(`TmuxManager: Started CLI in session "${safeName}"`);
      }

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`TmuxManager: Failed to create session: ${message}`);
      return { success: false, error: message };
    }
  }

  /**
   * Kill a tmux session
   */
  async killSession(name: string): Promise<{ success: boolean; error?: string }> {
    try {
      // First try to gracefully exit the coding session
      try {
        // Send Ctrl+C to interrupt any running operation
        await execAsync(`tmux send-keys -t "${name}" C-c`);
        await new Promise((resolve) => setTimeout(resolve, 300));

        // Send Ctrl+D to exit gracefully (preferred over "exit")
        await execAsync(`tmux send-keys -t "${name}" C-d`);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // If still alive, try "exit" command
        const stillAlive = await this.sessionExists(name);
        if (stillAlive) {
          await execAsync(`tmux send-keys -t "${name}" "exit" Enter`);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch {
        // Ignore errors during graceful shutdown
      }

      // Check if session still exists before force killing
      if (await this.sessionExists(name)) {
        await execAsync(`tmux kill-session -t "${name}"`);
        console.log(`TmuxManager: Force killed session "${name}"`);
      } else {
        console.log(`TmuxManager: Session "${name}" exited gracefully`);
      }

      invalidateTmuxSnapshot(name);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`TmuxManager: Failed to kill session: ${message}`);
      return { success: false, error: message };
    }
  }

  /**
   * Send input to a specific session
   */
  async sendKeys(sessionName: string, keys: string): Promise<boolean> {
    try {
      // Escape special characters for tmux
      const escaped = keys
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\$/g, '\\$')
        .replace(/`/g, '\\`');

      await execAsync(`tmux send-keys -t "${sessionName}" -l "${escaped}"`);
      return true;
    } catch (err) {
      console.error(`TmuxManager: Failed to send keys to "${sessionName}":`, err);
      return false;
    }
  }

  /**
   * Send raw (non-literal) keys to a tmux session.
   * Unlike sendKeys() which uses -l for literal text, this sends key names
   * directly so tmux interprets them (e.g. "Up", "Down", "C-c", "Enter").
   */
  async sendRawKeys(sessionName: string, keys: string[]): Promise<boolean> {
    try {
      for (const key of keys) {
        // Validate key contains only safe characters (alphanumeric, dash, plus for combos like C-c)
        if (!/^[a-zA-Z0-9\-+]+$/.test(key)) {
          console.error(`TmuxManager: Rejecting unsafe raw key: "${key}"`);
          continue;
        }
        await execAsync(`tmux send-keys -t "${sessionName}" ${key}`);
      }
      return true;
    } catch (err) {
      console.error(`TmuxManager: Failed to send raw keys to "${sessionName}":`, err);
      return false;
    }
  }

  /**
   * Send Enter key to a session
   */
  async sendEnter(sessionName: string): Promise<boolean> {
    try {
      await execAsync(`tmux send-keys -t "${sessionName}" Enter`);
      return true;
    } catch (err) {
      console.error(`TmuxManager: Failed to send Enter to "${sessionName}":`, err);
      return false;
    }
  }

  /**
   * Send Ctrl+C to a session
   */
  async sendInterrupt(sessionName: string): Promise<boolean> {
    try {
      await execAsync(`tmux send-keys -t "${sessionName}" C-c`);
      return true;
    } catch (err) {
      console.error(`TmuxManager: Failed to send interrupt to "${sessionName}":`, err);
      return false;
    }
  }

  /**
   * List available directories (for browsing)
   */
  async listDirectories(basePath: string): Promise<string[]> {
    try {
      const { stdout } = await execAsync(
        `find "${basePath}" -maxdepth 1 -type d 2>/dev/null | head -50`
      );
      return stdout
        .trim()
        .split('\n')
        .filter((d) => d && d !== basePath);
    } catch {
      return [];
    }
  }

  /**
   * Get home directory
   */
  getHomeDir(): string {
    return process.env.HOME || '/root';
  }

  /**
   * Capture the current terminal output from a tmux pane.
   * Returns the last N lines of visible output.
   * When offset is provided, captures lines further back in scrollback:
   *   offset=0 (default): last `lines` lines (-S -lines)
   *   offset=150: lines 150-300 from bottom (-S -300 -E -150)
   */
  async capturePane(sessionName: string, lines: number = 100, offset: number = 0): Promise<string> {
    // Clients poll the terminal view ~2/s each: identical captures within
    // CAPTURE_SHARE_MS (or still running) share one tmux call.
    const key = `${sessionName}\0${lines}\0${offset}`;
    const now = Date.now();
    const hit = this.captureShare.get(key);
    if (hit && now - hit.at < TmuxManager.CAPTURE_SHARE_MS) return hit.p;
    const p = this.capturePaneUncached(sessionName, lines, offset);
    this.captureShare.set(key, { at: now, p });
    if (this.captureShare.size > 64) {
      for (const [k, v] of this.captureShare)
        if (now - v.at >= TmuxManager.CAPTURE_SHARE_MS) this.captureShare.delete(k);
    }
    return p;
  }

  private static readonly CAPTURE_SHARE_MS = 300;
  private captureShare = new Map<string, { at: number; p: Promise<string> }>();

  private async capturePaneUncached(
    sessionName: string,
    lines: number,
    offset: number
  ): Promise<string> {
    try {
      const args =
        offset > 0
          ? [
              'capture-pane',
              '-p',
              '-e',
              '-t',
              sessionName,
              '-S',
              `-${offset + lines}`,
              '-E',
              `-${offset}`,
            ]
          : ['capture-pane', '-p', '-e', '-t', sessionName, '-S', `-${lines}`];
      const { stdout } = await runTmux(args, 'tmux-manager', {
        timeoutMs: 3000,
        maxBuffer: 8 * 1024 * 1024,
      });
      return stdout;
    } catch {
      return '';
    }
  }

  /**
   * Generate a unique session name based on directory
   */
  generateSessionName(workingDir: string): string {
    const dirName = workingDir.split('/').pop() || 'session';
    const safeName = dirName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = Date.now().toString(36);
    return `${this.sessionPrefix}-${safeName}-${timestamp}`;
  }

  // --- Git Worktree Support ---

  /**
   * Check if a directory is a git repository
   */
  async isGitRepo(dir: string): Promise<boolean> {
    try {
      await execAsync('git rev-parse --is-inside-work-tree', { cwd: dir });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a git worktree from a repository directory.
   * Returns the path to the new worktree and the branch name.
   */
  async createWorktree(repoDir: string, branchName?: string): Promise<WorktreeResult> {
    // Verify it's a git repo
    if (!(await this.isGitRepo(repoDir))) {
      return { success: false, error: 'not a git repository' };
    }

    // Get the git root (in case repoDir is a subdirectory)
    const { stdout: gitRoot } = await execAsync('git rev-parse --show-toplevel', { cwd: repoDir });
    const rootDir = gitRoot.trim();

    // Generate branch name if not provided
    const branch = branchName || `wt-${Date.now().toString(36)}`;
    const safeBranch = branch.replace(/[^a-zA-Z0-9_-]/g, '-');

    // Worktree path: sibling directory named <repo>-wt-<branch>
    const repoName = path.basename(rootDir);
    const worktreePath = path.join(path.dirname(rootDir), `${repoName}-wt-${safeBranch}`);

    try {
      await execAsync(`git worktree add "${worktreePath}" -b "${safeBranch}"`, { cwd: rootDir });
      return { success: true, worktreePath, branch: safeBranch };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  /**
   * Remove a git worktree and its directory.
   */
  async removeWorktree(
    repoDir: string,
    worktreePath: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await execAsync(`git worktree remove "${worktreePath}" --force`, { cwd: repoDir });
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  /**
   * List all worktrees for a git repository.
   */
  async listWorktrees(dir: string): Promise<WorktreeInfo[]> {
    if (!(await this.isGitRepo(dir))) {
      return [];
    }

    try {
      const { stdout } = await execAsync('git worktree list --porcelain', { cwd: dir });

      const worktrees: WorktreeInfo[] = [];
      let current: Partial<WorktreeInfo> = {};

      for (const line of stdout.split('\n')) {
        if (line.startsWith('worktree ')) {
          if (current.path) {
            worktrees.push(current as WorktreeInfo);
          }
          current = { path: line.replace('worktree ', ''), isMain: false };
        } else if (line.startsWith('branch ')) {
          // branch refs/heads/main → main
          const ref = line.replace('branch ', '');
          current.branch = ref.replace('refs/heads/', '');
        } else if (line === 'bare') {
          current.isMain = true;
        } else if (line === '') {
          // Empty line ends a worktree entry
          if (current.path) {
            worktrees.push({
              path: current.path,
              branch: current.branch || 'HEAD',
              isMain: current.isMain || false,
            });
            current = {};
          }
        }
      }

      // Mark the first worktree as main (it's the original repo)
      if (worktrees.length > 0) {
        worktrees[0].isMain = true;
      }

      return worktrees;
    } catch {
      return [];
    }
  }
}
