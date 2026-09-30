import { spawn, execFile } from 'child_process';
import { TMUX_OPERATION_TIMEOUT_MS, INPUT_LOG_PREVIEW_LENGTH, POST_TEXT_DELAY_MS, POST_ENTER_DELAY_MS, POST_ENTER_BEFORE_TYPING_DELAY_MS, POST_OTHER_SELECT_DELAY_MS, POST_TEXT_INPUT_DELAY_MS, POST_CHOICE_DELAY_MS, DEFAULT_PANE_CAPTURE_LINES, OVERLAY_DISMISS_DELAY_MS, OVERLAY_DETECTION_LINES } from './constants';
import { incrementTmuxOperations } from './metrics';

interface TmuxResult {
  /** 0 on success; non-zero (or null for signal kills) on failure. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** True if the process was killed by the timeout watchdog. */
  timedOut: boolean;
}

export class InputInjector {
  private defaultSession: string;
  private activeSession: string;
  private sendLock: Promise<void> = Promise.resolve();

  constructor(tmuxSession: string) {
    this.defaultSession = tmuxSession;
    this.activeSession = tmuxSession;
  }

  /**
   * Run a `tmux` subprocess WITHOUT blocking the event loop.
   *
   * Replaces the former `spawnSync` calls: a synchronous tmux invocation that
   * stalled (e.g. a wedged server) would freeze the daemon's single thread past
   * the WebSocket pong window, causing false-positive client disconnects.
   *
   * Per the project's subprocess-safety rule this enforces a hard timeout with a
   * SIGKILL escalation (execFile's `timeout` + `killSignal: 'SIGKILL'`), and it
   * never rejects — the result mirrors spawnSync's `{ status, stdout, stderr }`
   * shape so existing call-site checks (`result.status !== 0`,
   * `result.stdout?.toString()`) keep working unchanged.
   */
  private runTmux(args: string[]): Promise<TmuxResult> {
    return new Promise((resolve) => {
      execFile(
        'tmux',
        args,
        {
          timeout: TMUX_OPERATION_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          maxBuffer: 16 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          const out = stdout ?? '';
          const errOut = stderr ?? '';
          if (err) {
            const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
            const timedOut = !!e.killed;
            // execFile puts the exit code in err.code when it's a number; ENOENT
            // and other spawn failures surface as a string code -> treat as status 1.
            const status = typeof e.code === 'number' ? e.code : 1;
            resolve({ status, stdout: out, stderr: errOut, timedOut });
            return;
          }
          resolve({ status: 0, stdout: out, stderr: errOut, timedOut: false });
        }
      );
    });
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

      // First, check if the tmux session exists
      const checkResult = await this.runTmux(['has-session', '-t', session]);
      if (checkResult.status !== 0) {
        console.error(`Tmux session '${session}' not found`);
        return false;
      }

      // Dismiss any TUI overlay before sending
      await this.dismissOverlayIfPresent(session);

      // Session exists, send the input
      return await this.doSendInput(input, session);
    } finally {
      releaseLock!();
    }
  }

  /**
   * Detect and dismiss TUI overlays (e.g. "Background tasks" panel) before sending input.
   * Overlays intercept keystrokes, causing messages to silently fail.
   * Fails open: if capture errors, we proceed without dismissing.
   */
  private async dismissOverlayIfPresent(session: string): Promise<void> {
    try {
      const paneContent = await this.capturePaneContent(session, OVERLAY_DETECTION_LINES);
      const overlayPatterns = [
        /to select.*Enter to view.*Esc to close/,  // Background tasks panel
        /Esc to close/,                              // Generic overlay catch-all
      ];
      const hasOverlay = overlayPatterns.some((p) => p.test(paneContent));
      if (hasOverlay) {
        console.log(`Overlay detected in session '${session}', sending Escape to dismiss`);
        await this.runTmux(['send-keys', '-t', session, 'Escape']);
        await new Promise((resolve) => setTimeout(resolve, OVERLAY_DISMISS_DELAY_MS));
      }
    } catch (err) {
      // Fail open — never block sending
      console.warn('Overlay detection failed, proceeding with send:', err);
    }
  }

  private async doSendInput(input: string, session: string): Promise<boolean> {
    try {
      console.log(`Sending input to tmux session '${session}': ${input.substring(0, INPUT_LOG_PREVIEW_LENGTH)}...`);

      // Send the text (avoids shell interpretation via -l --)
      const textResult = await this.runTmux(['send-keys', '-t', session, '-l', '--', input]);
      if (textResult.status !== 0) {
        console.error('Failed to send text:', textResult.stderr);
        return false;
      }
      console.log('Text sent to tmux');

      // Wait for tmux to process the text before sending Enter
      await new Promise((resolve) => setTimeout(resolve, POST_TEXT_DELAY_MS));

      // Send Enter
      const enterResult = await this.runTmux(['send-keys', '-t', session, 'Enter']);
      if (enterResult.status !== 0) {
        console.error('Failed to send Enter:', enterResult.stderr);
        return false;
      }
      console.log('Enter sent to tmux');

      // Small delay after Enter to ensure tmux processes it before next message
      await new Promise((resolve) => setTimeout(resolve, POST_ENTER_DELAY_MS));

      console.log(`Input sent successfully to tmux session '${session}'`);
      incrementTmuxOperations();
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
   *
   * Claude Code's AskUserQuestion picker renders NUMBERED options (1., 2., 3., ...).
   * Pressing the option's digit is far more robust than positional arrow walking
   * (no cumulative cursor drift), so this uses digit keys as the primary mechanism.
   * Behaviour verified against a live picker (Claude Code 2.1.x):
   *
   *   - Single-select: pressing the option's digit SELECTS and SUBMITS in one keypress.
   *   - Multi-select:  each option shows a [ ] checkbox; pressing its digit TOGGLES the
   *                    checkbox in place (cursor does not move, no submit). After toggling
   *                    all desired options, Right arrow opens a "Submit answers / Cancel"
   *                    review screen; pressing "1" confirms.
   *   - "Other":       the free-text choice ("Type something.") is rendered as the option
   *                    AFTER the real options, i.e. numbered (optionCount + 1). Pressing
   *                    that digit highlights it and enters inline text-edit mode WITHOUT
   *                    submitting; we then type the text and press Enter to submit.
   *
   * Arrow-key fallbacks are kept for the (not-expected-for-AskUserQuestion) case of
   * more than 9 options, where single digit keys can't address every row.
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

      const checkResult = await this.runTmux(['has-session', '-t', session]);
      if (checkResult.status !== 0) {
        console.error(`Tmux session '${session}' not found`);
        return false;
      }

      // Dismiss any TUI overlay before sending
      await this.dismissOverlayIfPresent(session);

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
      // The picker repaints between keypresses; give the TUI time to settle so a
      // digit toggle / tab switch is fully rendered before the next key arrives.
      const KEY_DELAY = 120; // ms between key presses

      const sendKey = async (key: string): Promise<boolean> => {
        const result = await this.runTmux(['send-keys', '-t', session, key]);
        if (result.status !== 0) {
          console.error(`Failed to send key '${key}':`, result.stderr);
          return false;
        }
        return true;
      };
      const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

      if (otherText !== undefined) {
        // "Other" / free-text ("Type something.") is the numbered row AFTER the real
        // options, i.e. position (optionCount + 1). Pressing its digit highlights it and
        // opens an inline text field (no submit); then we type the text and press Enter.
        const otherNumber = optionCount + 1; // 1-based position of "Type something."
        console.log(`Sending choice: Other "${otherText.substring(0, 60)}" (option ${otherNumber}) to '${session}'`);

        if (otherNumber <= 9) {
          if (!(await sendKey(String(otherNumber)))) return false;
        } else {
          // >9 options: digit can't address the Other row — walk down to it instead.
          for (let i = 0; i < optionCount; i++) {
            if (!(await sendKey('Down'))) return false;
            await delay(KEY_DELAY);
          }
          if (!(await sendKey('Enter'))) return false;
        }
        // Wait for the inline text field to open before typing.
        await delay(POST_OTHER_SELECT_DELAY_MS);

        // Type the free-text (replaces the "Type something." label in place).
        const textResult = await this.runTmux(['send-keys', '-t', session, '-l', '--', otherText]);
        if (textResult.status !== 0) {
          console.error('Failed to type Other text:', textResult.stderr);
          return false;
        }
        await delay(POST_TEXT_INPUT_DELAY_MS);
        if (!(await sendKey('Enter'))) return false;
      } else if (multiSelect) {
        // Multi-select: each option has a [ ] checkbox. Pressing the option's digit
        // toggles that checkbox in place (cursor stays put, nothing submits), so we can
        // address selected options directly with no positional drift. After toggling,
        // Right arrow opens the "Submit answers / Cancel" review screen and "1" confirms.
        const sorted = [...new Set(selectedIndices)].sort((a, b) => a - b);
        console.log(`Sending multi-select choice: indices [${sorted.join(',')}] of ${optionCount} to '${session}'`);

        for (const idx of sorted) {
          const num = idx + 1; // 1-based option number
          if (num > 9) {
            // Digit keys can't address rows past 9; AskUserQuestion never has this many.
            console.warn(`Multi-select option ${num} exceeds digit range, skipping`);
            continue;
          }
          if (!(await sendKey(String(num)))) return false;
          await delay(KEY_DELAY);
        }
        // Open the review/Submit screen, then confirm with "1. Submit answers".
        if (!(await sendKey('Right'))) return false;
        await delay(POST_OTHER_SELECT_DELAY_MS);
        if (!(await sendKey('1'))) return false;
      } else {
        // Single-select: pressing the option's digit selects AND submits in one keypress.
        const idx = selectedIndices[0] || 0;
        const num = idx + 1; // 1-based option number
        console.log(`Sending single-select choice: index ${idx} (option ${num}) of ${optionCount} to '${session}'`);

        if (num <= 9) {
          if (!(await sendKey(String(num)))) return false;
        } else {
          // >9 options: fall back to arrow navigation + Enter.
          for (let i = 0; i < idx; i++) {
            if (!(await sendKey('Down'))) return false;
            await delay(KEY_DELAY);
          }
          if (!(await sendKey('Enter'))) return false;
        }
      }

      await delay(POST_CHOICE_DELAY_MS);
      console.log(`Choice sent successfully to tmux session '${session}'`);
      incrementTmuxOperations();
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
    const checkResult = await this.runTmux(['has-session', '-t', session]);
    if (checkResult.status !== 0) return false;
    await this.dismissOverlayIfPresent(session);
    const result = await this.runTmux(['send-keys', '-t', session, 'C-c']);
    return result.status === 0;
  }

  /**
   * Capture the current content of a tmux pane
   */
  async capturePaneContent(targetSession?: string, lines = DEFAULT_PANE_CAPTURE_LINES): Promise<string> {
    const session = targetSession || this.activeSession;
    const result = await this.runTmux(['capture-pane', '-t', session, '-p', '-S', `-${lines}`]);
    if (result.status !== 0) return '';
    return result.stdout.trim();
  }

  /**
   * Capture the tmux pane content (last 30 lines by default).
   * Returns the captured text, or empty string on error.
   */
  async captureTmuxPane(targetSession?: string, lines = 30): Promise<string> {
    try {
      const session = targetSession || this.activeSession;
      const result = await this.runTmux(['capture-pane', '-t', session, '-p', '-S', `-${lines}`]);
      if (result.status !== 0) {
        return '';
      }
      return result.stdout.trim();
    } catch (err) {
      return '';
    }
  }

  /**
   * Send a single keypress to tmux (no Enter).
   * Used for feedback prompts that auto-submit after a keypress.
   */
  async sendKeypress(key: string, targetSession?: string): Promise<void> {
    try {
      const session = targetSession || this.activeSession;
      await this.runTmux(['send-keys', '-t', session, key]);
    } catch {
      // Silent fail — don't crash if tmux isn't available
    }
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
