import { spawn } from 'child_process';

export class InputInjector {
  private defaultSession: string;
  private activeSession: string;
  private sendLock: Promise<void> = Promise.resolve();

  constructor(tmuxSession: string) {
    this.defaultSession = tmuxSession;
    this.activeSession = tmuxSession;
  }

  /**
   * Send input to the active session (or a specific session if provided)
   * Uses a lock to prevent concurrent sends from interleaving
   */
  async sendInput(input: string, targetSession?: string): Promise<boolean> {
    // Wait for any pending send to complete before starting this one
    const previousLock = this.sendLock;
    let releaseLock: () => void;
    this.sendLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    try {
      await previousLock;

      const session = targetSession || this.activeSession;
      const { spawnSync } = require('child_process');

      // First, check if the tmux session exists
      const checkResult = spawnSync('tmux', ['has-session', '-t', session], { timeout: 5000 });
      if (checkResult.status !== 0) {
        console.error(`Tmux session '${session}' not found`);
        return false;
      }

      // Session exists, send the input
      return await this.doSendInput(input, session);
    } finally {
      releaseLock!();
    }
  }

  private async doSendInput(input: string, session: string): Promise<boolean> {
    try {
      console.log(`Sending input to tmux session '${session}': ${input.substring(0, 80)}...`);

      const { spawnSync } = require('child_process');

      // Send the text using spawnSync (avoids shell interpretation)
      const textResult = spawnSync('tmux', ['send-keys', '-t', session, '-l', '--', input], {
        timeout: 5000,
      });
      if (textResult.status !== 0) {
        console.error('Failed to send text:', textResult.stderr?.toString());
        return false;
      }
      console.log('Text sent to tmux');

      // Wait for tmux to process the text before sending Enter
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Send Enter
      const enterResult = spawnSync('tmux', ['send-keys', '-t', session, 'Enter'], {
        timeout: 5000,
      });
      if (enterResult.status !== 0) {
        console.error('Failed to send Enter:', enterResult.stderr?.toString());
        return false;
      }
      console.log('Enter sent to tmux');

      // Small delay after Enter to ensure tmux processes it before next message
      await new Promise((resolve) => setTimeout(resolve, 50));

      console.log(`Input sent successfully to tmux session '${session}'`);
      return true;
    } catch (err) {
      console.error('Error sending input to tmux:', err);
      return false;
    }
  }

  private escapeTmuxInput(input: string): string {
    // Escape special characters that tmux interprets
    // Replace backslashes first, then other special chars
    return input
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/'/g, "\\'")
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`');
  }

  async checkSessionExists(sessionName?: string): Promise<boolean> {
    const session = sessionName || this.activeSession;
    return new Promise((resolve) => {
      const check = spawn('tmux', ['has-session', '-t', session]);
      check.on('close', (code) => resolve(code === 0));
      check.on('error', () => resolve(false));
    });
  }

  async listSessions(): Promise<string[]> {
    return new Promise((resolve) => {
      const list = spawn('tmux', ['list-sessions', '-F', '#{session_name}']);
      let output = '';

      list.stdout.on('data', (data) => {
        output += data.toString();
      });

      list.on('close', (code) => {
        if (code === 0) {
          resolve(output.trim().split('\n').filter(Boolean));
        } else {
          resolve([]);
        }
      });

      list.on('error', () => resolve([]));
    });
  }

  setActiveSession(sessionName: string): void {
    this.activeSession = sessionName;
  }

  getActiveSession(): string {
    return this.activeSession;
  }

  getDefaultSession(): string {
    return this.defaultSession;
  }

  /**
   * Send Ctrl+C to cancel current input in a tmux session
   */
  async cancelInput(targetSession?: string): Promise<boolean> {
    const session = targetSession || this.activeSession;
    const { spawnSync } = require('child_process');
    const checkResult = spawnSync('tmux', ['has-session', '-t', session], { timeout: 5000 });
    if (checkResult.status !== 0) return false;
    const result = spawnSync('tmux', ['send-keys', '-t', session, 'C-c'], { timeout: 5000 });
    return result.status === 0;
  }

  /**
   * Capture the current content of a tmux pane
   */
  async capturePaneContent(targetSession?: string, lines = 20): Promise<string> {
    const session = targetSession || this.activeSession;
    const { spawnSync } = require('child_process');
    const result = spawnSync('tmux', ['capture-pane', '-t', session, '-p', '-S', `-${lines}`], {
      timeout: 5000,
    });
    if (result.status !== 0) return '';
    return (result.stdout?.toString() || '').trim();
  }

  // Deprecated - use setActiveSession
  setSession(sessionName: string): void {
    this.activeSession = sessionName;
  }

  // Deprecated - use getActiveSession
  getSession(): string {
    return this.activeSession;
  }
}
