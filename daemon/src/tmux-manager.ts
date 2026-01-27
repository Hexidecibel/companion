import { exec, execSync, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface TmuxSessionInfo {
  name: string;
  created: number;
  attached: boolean;
  windows: number;
  workingDir?: string;
}

export class TmuxManager {
  private sessionPrefix: string;

  constructor(sessionPrefix: string = 'claude') {
    this.sessionPrefix = sessionPrefix;
  }

  /**
   * List all tmux sessions (not filtered by prefix, so user can switch between any sessions)
   */
  async listSessions(): Promise<TmuxSessionInfo[]> {
    try {
      const { stdout } = await execAsync(
        'tmux list-sessions -F "#{session_name}|#{session_created}|#{session_attached}|#{session_windows}" 2>/dev/null'
      );

      const sessions: TmuxSessionInfo[] = [];

      for (const line of stdout.trim().split('\n')) {
        if (!line) continue;
        const [name, created, attached, windows] = line.split('|');

        // Include all sessions so users can interact with any tmux session
        sessions.push({
          name,
          created: parseInt(created, 10) * 1000, // Convert to ms
          attached: attached === '1',
          windows: parseInt(windows, 10),
        });
      }

      // Get working directory for each session
      for (const session of sessions) {
        try {
          const { stdout: pwd } = await execAsync(
            `tmux display-message -t "${session.name}" -p "#{pane_current_path}" 2>/dev/null`
          );
          session.workingDir = pwd.trim();
        } catch {
          // Ignore errors getting working dir
        }
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
      await execAsync(`tmux has-session -t "${name}" 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a new tmux session and start Claude in it
   */
  async createSession(
    name: string,
    workingDir: string,
    startClaude: boolean = true
  ): Promise<{ success: boolean; error?: string }> {
    // Validate session name
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');

    // Check if session already exists
    if (await this.sessionExists(safeName)) {
      return { success: false, error: `Session "${safeName}" already exists` };
    }

    try {
      // Create detached tmux session in the specified directory
      await execAsync(
        `tmux new-session -d -s "${safeName}" -c "${workingDir}"`
      );

      console.log(`TmuxManager: Created session "${safeName}" in ${workingDir}`);

      // Start Claude if requested
      if (startClaude) {
        // Small delay to let the session initialize
        await new Promise(resolve => setTimeout(resolve, 200));

        // Send the claude command
        await execAsync(
          `tmux send-keys -t "${safeName}" "claude" Enter`
        );
        console.log(`TmuxManager: Started Claude in session "${safeName}"`);
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
      // First try to gracefully exit Claude Code
      try {
        // Send Ctrl+C to interrupt any running operation
        await execAsync(`tmux send-keys -t "${name}" C-c`);
        await new Promise(resolve => setTimeout(resolve, 300));

        // Send Ctrl+D to exit Claude gracefully (preferred over "exit")
        await execAsync(`tmux send-keys -t "${name}" C-d`);
        await new Promise(resolve => setTimeout(resolve, 1000));

        // If still alive, try "exit" command
        const stillAlive = await this.sessionExists(name);
        if (stillAlive) {
          await execAsync(`tmux send-keys -t "${name}" "exit" Enter`);
          await new Promise(resolve => setTimeout(resolve, 500));
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

      await execAsync(
        `tmux send-keys -t "${sessionName}" -l "${escaped}"`
      );
      return true;
    } catch (err) {
      console.error(`TmuxManager: Failed to send keys to "${sessionName}":`, err);
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
   * Get the current pane content (for debugging)
   */
  async capturePane(sessionName: string, lines: number = 50): Promise<string> {
    try {
      const { stdout } = await execAsync(
        `tmux capture-pane -t "${sessionName}" -p -S -${lines}`
      );
      return stdout;
    } catch (err) {
      return '';
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
      return stdout.trim().split('\n').filter(d => d && d !== basePath);
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
   * Generate a unique session name based on directory
   */
  generateSessionName(workingDir: string): string {
    const dirName = workingDir.split('/').pop() || 'session';
    const safeName = dirName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = Date.now().toString(36);
    return `${this.sessionPrefix}-${safeName}-${timestamp}`;
  }
}
