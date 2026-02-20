import { spawn } from 'child_process';
import { TMUX_OPERATION_TIMEOUT_MS, INPUT_LOG_PREVIEW_LENGTH, POST_TEXT_DELAY_MS, POST_ENTER_DELAY_MS, POST_ENTER_BEFORE_TYPING_DELAY_MS, POST_OTHER_SELECT_DELAY_MS, POST_TEXT_INPUT_DELAY_MS, POST_CHOICE_DELAY_MS, DEFAULT_PANE_CAPTURE_LINES } from './constants';

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
      const checkResult = spawnSync('tmux', ['has-session', '-t', session], { timeout: TMUX_OPERATION_TIMEOUT_MS });
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
      console.log(`Sending input to tmux session '${session}': ${input.substring(0, INPUT_LOG_PREVIEW_LENGTH)}...`);

      const { spawnSync } = require('child_process');

      // Send the text using spawnSync (avoids shell interpretation)
      const textResult = spawnSync('tmux', ['send-keys', '-t', session, '-l', '--', input], {
        timeout: TMUX_OPERATION_TIMEOUT_MS,
      });
      if (textResult.status !== 0) {
        console.error('Failed to send text:', textResult.stderr?.toString());
        return false;
      }
      console.log('Text sent to tmux');

      // Wait for tmux to process the text before sending Enter
      await new Promise((resolve) => setTimeout(resolve, POST_TEXT_DELAY_MS));

      // Send Enter
      const enterResult = spawnSync('tmux', ['send-keys', '-t', session, 'Enter'], {
        timeout: TMUX_OPERATION_TIMEOUT_MS,
      });
      if (enterResult.status !== 0) {
        console.error('Failed to send Enter:', enterResult.stderr?.toString());
        return false;
      }
      console.log('Enter sent to tmux');

      // Small delay after Enter to ensure tmux processes it before next message
      await new Promise((resolve) => setTimeout(resolve, POST_ENTER_DELAY_MS));

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
   * Send a choice selection via key sequences for interactive CLI prompts.
   * Works with AskUserQuestion — navigates with arrow keys, toggles with Space,
   * and confirms with Enter.
   *
   * For single-select: Down × selectedIndex, then Enter.
   * For multi-select: walk all options, Space on selected indices, then Enter.
   * For "Other": navigate to Other option, Enter, type text, Enter.
   */
  async sendChoice(
    selectedIndices: number[],
    optionCount: number,
    multiSelect: boolean,
    otherText: string | undefined,
    targetSession?: string
  ): Promise<boolean> {
    const previousLock = this.sendLock;
    let releaseLock: () => void;
    this.sendLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    try {
      await previousLock;

      const session = targetSession || this.activeSession;
      const { spawnSync } = require('child_process');

      const checkResult = spawnSync('tmux', ['has-session', '-t', session], { timeout: TMUX_OPERATION_TIMEOUT_MS });
      if (checkResult.status !== 0) {
        console.error(`Tmux session '${session}' not found`);
        return false;
      }

      return await this.doSendChoice(selectedIndices, optionCount, multiSelect, otherText, session);
    } finally {
      releaseLock!();
    }
  }

  private async doSendChoice(
    selectedIndices: number[],
    optionCount: number,
    multiSelect: boolean,
    otherText: string | undefined,
    session: string
  ): Promise<boolean> {
    try {
      const { spawnSync } = require('child_process');
      const KEY_DELAY = 80; // ms between key presses

      const sendKey = (key: string): boolean => {
        const result = spawnSync('tmux', ['send-keys', '-t', session, key], { timeout: TMUX_OPERATION_TIMEOUT_MS });
        if (result.status !== 0) {
          console.error(`Failed to send key '${key}':`, result.stderr?.toString());
          return false;
        }
        return true;
      };

      if (otherText !== undefined) {
        // "Other" option: navigate past all options to "Other", press Enter, type text, Enter
        console.log(`Sending choice: Other "${otherText.substring(0, 60)}" to '${session}'`);
        for (let i = 0; i < optionCount; i++) {
          if (!sendKey('Down')) return false;
          await new Promise((r) => setTimeout(r, KEY_DELAY));
        }
        if (!sendKey('Enter')) return false;
        await new Promise((r) => setTimeout(r, POST_OTHER_SELECT_DELAY_MS));

        // Type the text
        const textResult = spawnSync('tmux', ['send-keys', '-t', session, '-l', '--', otherText], {
          timeout: TMUX_OPERATION_TIMEOUT_MS,
        });
        if (textResult.status !== 0) return false;
        await new Promise((r) => setTimeout(r, POST_TEXT_INPUT_DELAY_MS));
        if (!sendKey('Enter')) return false;
      } else if (multiSelect) {
        // Multi-select: walk through all options, Space on selected ones, then Enter
        const selectedSet = new Set(selectedIndices);
        console.log(`Sending multi-select choice: indices [${selectedIndices.join(',')}] of ${optionCount} to '${session}'`);

        for (let i = 0; i < optionCount; i++) {
          if (selectedSet.has(i)) {
            if (!sendKey('Space')) return false;
            await new Promise((r) => setTimeout(r, KEY_DELAY));
          }
          if (i < optionCount - 1) {
            if (!sendKey('Down')) return false;
            await new Promise((r) => setTimeout(r, KEY_DELAY));
          }
        }
        // Submit
        if (!sendKey('Enter')) return false;
      } else {
        // Single-select: Down to the selected option, then Enter
        const idx = selectedIndices[0] || 0;
        console.log(`Sending single-select choice: index ${idx} of ${optionCount} to '${session}'`);

        for (let i = 0; i < idx; i++) {
          if (!sendKey('Down')) return false;
          await new Promise((r) => setTimeout(r, KEY_DELAY));
        }
        if (!sendKey('Enter')) return false;
      }

      await new Promise((r) => setTimeout(r, POST_CHOICE_DELAY_MS));
      console.log(`Choice sent successfully to tmux session '${session}'`);
      return true;
    } catch (err) {
      console.error('Error sending choice to tmux:', err);
      return false;
    }
  }

  /**
   * Send Ctrl+C to cancel current input in a tmux session
   */
  async cancelInput(targetSession?: string): Promise<boolean> {
    const session = targetSession || this.activeSession;
    const { spawnSync } = require('child_process');
    const checkResult = spawnSync('tmux', ['has-session', '-t', session], { timeout: TMUX_OPERATION_TIMEOUT_MS });
    if (checkResult.status !== 0) return false;
    const result = spawnSync('tmux', ['send-keys', '-t', session, 'C-c'], { timeout: TMUX_OPERATION_TIMEOUT_MS });
    return result.status === 0;
  }

  /**
   * Capture the current content of a tmux pane
   */
  async capturePaneContent(targetSession?: string, lines = DEFAULT_PANE_CAPTURE_LINES): Promise<string> {
    const session = targetSession || this.activeSession;
    const { spawnSync } = require('child_process');
    const result = spawnSync('tmux', ['capture-pane', '-t', session, '-p', '-S', `-${lines}`], {
      timeout: TMUX_OPERATION_TIMEOUT_MS,
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
