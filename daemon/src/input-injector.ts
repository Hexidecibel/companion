import { trySub, tmuxKind } from './impact/sub';
import {
  TMUX_OPERATION_TIMEOUT_MS,
  INPUT_LOG_PREVIEW_LENGTH,
  POST_CHOICE_DELAY_MS,
  DEFAULT_PANE_CAPTURE_LINES,
  OVERLAY_DISMISS_DELAY_MS,
} from './constants';
import { incrementTmuxOperations } from './metrics';
import { impact } from './impact/state';
import { defaultAgent, type AgentAdapter, type KeyStep } from './agents';
import { secondsSinceClientActivity, refusalFor, type InputRefusal } from './prompt-guard';

/** An attached client that pressed a key within this many seconds = someone is typing. */
export const TYPING_QUIET_S = 2;
/** How long a send waits for the typing to pause before it is refused. */
export const TYPING_MAX_WAIT_MS = 3000;
const TYPING_POLL_MS = 500;
/** Lines captured to find the prompt box (a long draft makes the box tall). */
const GUARD_CAPTURE_LINES = 60;

export type SendInputResult =
  | { ok: true }
  | ({ ok: false } & (
      | InputRefusal
      | { reason: 'no_session' | 'tmux_error'; code: string; message: string }
    ));

export interface InputInjectorOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

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
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;

  /**
   * TUI knowledge (prompt box, overlays, text / choice / interrupt keys) for
   * the agent in a pane. The watcher knows which agent runs where
   * (`setAgentResolver`); without it every pane is Claude.
   */
  private agentResolver: (session: string) => AgentAdapter = () => defaultAgent();
  private pasteSeq = 0;

  constructor(tmuxSession: string, opts: InputInjectorOptions = {}) {
    this.defaultSession = tmuxSession;
    this.activeSession = tmuxSession;
    this.now = opts.now || Date.now;
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Which agent runs in each tmux session (SessionWatcher.agentFor). */
  setAgentResolver(resolve: (session: string) => AgentAdapter): void {
    this.agentResolver = resolve;
  }

  /** The agent in a tmux session (falls back to Claude on any resolver error). */
  agentFor(session: string): AgentAdapter {
    try {
      return this.agentResolver(session) || defaultAgent();
    } catch {
      return defaultAgent();
    }
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
  private async runTmux(args: string[]): Promise<TmuxResult> {
    const r = await trySub(tmuxKind(args, 'injector'), 'tmux', args, {
      timeoutMs: TMUX_OPERATION_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    // A non-numeric code (ENOENT, spawn failure) is status 1, like before.
    const status = !r.error ? 0 : r.code >= 0 ? r.code : 1;
    return { status, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
  }

  /**
   * Send input to the active session (or a specific session if provided)
   * Uses a lock to prevent concurrent sends from interleaving
   */
  async sendInput(input: string, targetSession?: string): Promise<boolean> {
    return (await this.sendInputDetailed(input, targetSession)).ok;
  }

  /**
   * Free text into Claude's prompt box, guarded against collisions with the
   * user: refused when the box already holds an unsent draft (typing would
   * append to it and Enter would send both), and deferred (then refused) while
   * an attached client typed within the last TYPING_QUIET_S seconds. Choice
   * answers (`sendChoice`) never come here: a choice box replaces the prompt box.
   */
  async sendInputDetailed(input: string, targetSession?: string): Promise<SendInputResult> {
    // Wait for any pending send to complete before starting this one
    const previousLock = this.sendLock;
    let releaseLock: () => void;
    this.sendLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    try {
      await previousLock;

      const session = targetSession || this.activeSession;
      const agent = this.agentFor(session);

      // First, check if the tmux session exists
      const checkResult = await this.runTmux(['has-session', '-t', session]);
      if (checkResult.status !== 0) {
        console.error(`Tmux session '${session}' not found`);
        return {
          ok: false,
          reason: 'no_session',
          code: 'tmux_session_not_found',
          message: 'The session is not running.',
        };
      }

      // A bare Ctrl+C character (the app's "/cancel" quick command) is the
      // agent's interrupt, not text: Codex quits on a literal Ctrl+C.
      if (input === '\x03' && agent.id !== 'claude') {
        const sent = await this.runSteps(session, agent.terminal.interruptKeys(), 'interrupt');
        return sent
          ? { ok: true }
          : { ok: false, reason: 'tmux_error', code: 'send_failed', message: 'Failed to interrupt' };
      }

      if (!(await this.waitForTypingPause(session))) {
        impact.count('inputCollisions');
        console.log(`Input to '${session}' refused: an attached client is typing`);
        return { ok: false, ...refusalFor('typing') };
      }

      // Dismiss any TUI overlay, then make sure the prompt box holds no draft.
      let pane = await this.captureForGuard(session);
      if (pane !== null && agent.terminal.detectOverlay(pane)) {
        console.log(`Overlay detected in session '${session}', sending Escape to dismiss`);
        await this.runTmux(['send-keys', '-t', session, 'Escape']);
        await this.sleep(OVERLAY_DISMISS_DELAY_MS);
        pane = await this.captureForGuard(session);
      }
      if (pane !== null) {
        const box = agent.terminal.readPromptBox(pane);
        if (box.found && box.draft) {
          impact.count('inputCollisions');
          console.log(
            `Input to '${session}' refused: the prompt has an unsent draft (${box.draft.length} chars)`
          );
          return { ok: false, ...refusalFor('draft') };
        }
      }

      const sent = await this.doSendInput(input, session, agent);
      return sent
        ? { ok: true }
        : {
            ok: false,
            reason: 'tmux_error',
            code: 'send_failed',
            message: 'Failed to send input to session',
          };
    } finally {
      releaseLock!();
    }
  }

  /** `capture-pane -e` of the bottom of the pane; null when it cannot be read (fail open). */
  private async captureForGuard(session: string): Promise<string | null> {
    try {
      const r = await this.runTmux([
        'capture-pane',
        '-t',
        session,
        '-p',
        '-e',
        '-S',
        `-${GUARD_CAPTURE_LINES}`,
      ]);
      return r.status === 0 ? r.stdout : null;
    } catch {
      return null;
    }
  }

  /** Seconds since an attached client's last keypress (null: none attached / unknown). */
  private async clientIdleSeconds(session: string): Promise<number | null> {
    const r = await this.runTmux(['list-clients', '-t', session, '-F', '#{client_activity}']);
    if (r.status !== 0) return null;
    return secondsSinceClientActivity(r.stdout, this.now());
  }

  /** False when someone kept typing for the whole wait window. */
  private async waitForTypingPause(session: string): Promise<boolean> {
    const deadline = this.now() + TYPING_MAX_WAIT_MS;
    for (;;) {
      const idle = await this.clientIdleSeconds(session);
      if (idle === null || idle >= TYPING_QUIET_S) return true;
      if (this.now() >= deadline) return false;
      await this.sleep(TYPING_POLL_MS);
    }
  }

  /**
   * Detect and dismiss TUI overlays (e.g. "Background tasks" panel) before sending input.
   * Overlays intercept keystrokes, causing messages to silently fail. Only a real
   * overlay counts: the prompt box is gone and a key-hint line offers "Esc to close"
   * (see prompt-guard.ts `detectOverlay`). Fails open on capture errors.
   */
  private async dismissOverlayIfPresent(session: string): Promise<void> {
    try {
      const paneContent = await this.captureForGuard(session);
      if (paneContent !== null && this.agentFor(session).terminal.detectOverlay(paneContent)) {
        console.log(`Overlay detected in session '${session}', sending Escape to dismiss`);
        await this.runTmux(['send-keys', '-t', session, 'Escape']);
        await this.sleep(OVERLAY_DISMISS_DELAY_MS);
      }
    } catch (err) {
      // Fail open — never block sending
      console.warn('Overlay detection failed, proceeding with send:', err);
    }
  }

  private async doSendInput(input: string, session: string, agent: AgentAdapter): Promise<boolean> {
    try {
      console.log(
        `Sending input to tmux session '${session}': ${input.substring(0, INPUT_LOG_PREVIEW_LENGTH)}...`
      );
      // The agent decides how text goes in (Claude: typed + Enter; Codex:
      // bracketed paste + Enter).
      if (!(await this.runSteps(session, agent.terminal.textKeys(input), 'text'))) return false;
      console.log(`Input sent successfully to tmux session '${session}'`);
      incrementTmuxOperations();
      return true;
    } catch (err) {
      console.error('Error sending input to tmux:', err);
      return false;
    }
  }

  /**
   * Execute a key plan against a pane. Stops at the first failed step.
   * `paste` = a named buffer pasted with bracketed-paste markers and deleted.
   */
  private async runSteps(session: string, steps: KeyStep[], what: string): Promise<boolean> {
    for (const step of steps) {
      if (step.type === 'key') {
        const r = await this.runTmux(['send-keys', '-t', session, step.key]);
        if (r.status !== 0) {
          console.error(`Failed to send key '${step.key}' (${what}):`, r.stderr);
          return false;
        }
      } else if (step.type === 'text') {
        const r = await this.runTmux(['send-keys', '-t', session, '-l', '--', step.text]);
        if (r.status !== 0) {
          console.error(`Failed to send text (${what}):`, r.stderr);
          return false;
        }
      } else if (step.type === 'paste') {
        const buffer = `companion-${process.pid}-${++this.pasteSeq}`;
        const set = await this.runTmux(['set-buffer', '-b', buffer, '--', step.text]);
        if (set.status !== 0) {
          console.error(`Failed to stage paste (${what}):`, set.stderr);
          return false;
        }
        const r = await this.runTmux(['paste-buffer', '-p', '-d', '-b', buffer, '-t', session]);
        if (r.status !== 0) {
          console.error(`Failed to paste (${what}):`, r.stderr);
          await this.runTmux(['delete-buffer', '-b', buffer]);
          return false;
        }
      } else {
        await this.sleep(step.ms);
      }
    }
    return true;
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
    const r = await this.runTmux(['has-session', '-t', session]);
    return r.status === 0;
  }

  async listSessions(): Promise<string[]> {
    const r = await this.runTmux(['list-sessions', '-F', '#{session_name}']);
    return r.status === 0 ? r.stdout.trim().split('\n').filter(Boolean) : [];
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

      const agent = this.agentFor(session);
      if (agent.terminal.requiresLiveChoiceBox) {
        // Codex: a digit sent to the bare composer would be typed into it and
        // Esc would interrupt, so answer only a box that is on screen now.
        const pane = await this.captureForGuard(session);
        if (pane === null || !agent.terminal.detectActiveChoicePrompt(pane)) {
          console.log(`Choice for '${session}' not sent: no ${agent.displayName} choice box on screen`);
          return false;
        }
      } else {
        // Dismiss any TUI overlay before sending
        await this.dismissOverlayIfPresent(session);
      }

      return await this.doSendChoice(
        selectedIndices,
        optionCount,
        multiSelect,
        otherText,
        session,
        agent
      );
    } finally {
      releaseLock!();
    }
  }

  private async doSendChoice(
    selectedIndices: number[],
    optionCount: number,
    multiSelect: boolean,
    otherText: string | undefined,
    session: string,
    agent: AgentAdapter
  ): Promise<boolean> {
    try {
      // The agent decides the keys (Claude: digits, arrows, Right + "1" to submit;
      // Codex: the option's digit, or Esc + a pasted message for feedback).
      const plan = agent.terminal.choiceKeys({
        selectedIndices,
        optionCount,
        multiSelect,
        otherText,
      });
      console.log(`Sending ${plan.description} to '${session}'`);
      for (const w of plan.warnings) console.warn(w);
      if (plan.steps.length === 0) return false;

      if (!(await this.runSteps(session, plan.steps, 'choice'))) return false;

      await this.sleep(POST_CHOICE_DELAY_MS);
      console.log(`Choice sent successfully to tmux session '${session}'`);
      incrementTmuxOperations();
      return true;
    } catch (err) {
      console.error('Error sending choice to tmux:', err);
      return false;
    }
  }

  /**
   * Interrupt the running turn: the agent's interrupt keys (Claude: Ctrl+C;
   * Codex: Esc, since its Ctrl+C quits an idle session).
   */
  async cancelInput(targetSession?: string): Promise<boolean> {
    const session = targetSession || this.activeSession;
    const checkResult = await this.runTmux(['has-session', '-t', session]);
    if (checkResult.status !== 0) return false;
    await this.dismissOverlayIfPresent(session);
    return this.runSteps(session, this.agentFor(session).terminal.interruptKeys(), 'interrupt');
  }

  /**
   * Capture the current content of a tmux pane
   */
  async capturePaneContent(
    targetSession?: string,
    lines = DEFAULT_PANE_CAPTURE_LINES
  ): Promise<string> {
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
