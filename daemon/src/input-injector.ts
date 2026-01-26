import { spawn, execSync } from 'child_process';

export class InputInjector {
  private tmuxSession: string;

  constructor(tmuxSession: string) {
    this.tmuxSession = tmuxSession;
  }

  async sendInput(input: string): Promise<boolean> {
    const { spawnSync } = require('child_process');

    // First, check if the tmux session exists
    const checkResult = spawnSync('tmux', ['has-session', '-t', this.tmuxSession], { timeout: 5000 });
    if (checkResult.status !== 0) {
      console.error(`Tmux session '${this.tmuxSession}' not found`);
      return false;
    }

    // Session exists, send the input
    return this.doSendInput(input);
  }

  private async doSendInput(input: string): Promise<boolean> {
    try {
      console.log(`Sending input to tmux session '${this.tmuxSession}': ${input.substring(0, 80)}...`);

      const { spawnSync } = require('child_process');

      // Send the text using spawnSync (avoids shell interpretation)
      const textResult = spawnSync('tmux', ['send-keys', '-t', this.tmuxSession, '-l', '--', input], { timeout: 5000 });
      if (textResult.status !== 0) {
        console.error('Failed to send text:', textResult.stderr?.toString());
        return false;
      }
      console.log('Text sent to tmux');

      // Synchronous sleep
      spawnSync('sleep', ['0.1']);

      // Send Enter
      const enterResult = spawnSync('tmux', ['send-keys', '-t', this.tmuxSession, 'Enter'], { timeout: 5000 });
      if (enterResult.status !== 0) {
        console.error('Failed to send Enter:', enterResult.stderr?.toString());
        return false;
      }
      console.log('Enter sent to tmux');

      console.log(`Input sent successfully to tmux session '${this.tmuxSession}'`);
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

  async checkSessionExists(): Promise<boolean> {
    return new Promise((resolve) => {
      const check = spawn('tmux', ['has-session', '-t', this.tmuxSession]);
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

  setSession(sessionName: string): void {
    this.tmuxSession = sessionName;
  }

  getSession(): string {
    return this.tmuxSession;
  }
}
