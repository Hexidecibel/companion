/**
 * HeraldToolbox: the stateful side of Herald's knowledge + cush-tools tools.
 * Owns the KnowledgeBase (cached retrieval), the set of cush tools Herald itself
 * opened (persisted with Herald state), and the validate / run entry points the
 * tool layer and ActionManager call.
 */

import type { CushExecOutcome } from '../actions';
import { KnowledgeBase, KnowledgePaths } from './sources';
import {
  CushCommand,
  CushProposalInput,
  CushRunResult,
  CushStatus,
  CushValidation,
  fetchCushStatus,
  runCushCommand,
  validateCushCommand,
} from './cush';
import type { guardedExecFile } from './guarded-exec';

export const MAX_CUSH_OPENED = 100;

export interface ToolboxDeps {
  paths: KnowledgePaths;
  /** Persist hook: called whenever the opened set changes. */
  onOpenedChange?: () => void;
  /** Test seams. */
  exec?: typeof guardedExecFile;
  isListening?: (port: number) => Promise<boolean>;
  run?: (cmd: CushCommand) => Promise<CushRunResult>;
  status?: () => Promise<CushStatus>;
}

export class HeraldToolbox {
  readonly knowledge: KnowledgeBase;
  private deps: ToolboxDeps;
  private opened: string[] = [];

  constructor(deps: ToolboxDeps) {
    this.deps = deps;
    this.knowledge = new KnowledgeBase(deps.paths);
  }

  /** Set the persist hook (the service wires it after construction). */
  setOnOpenedChange(fn: () => void): void {
    this.deps.onOpenedChange = fn;
  }

  loadOpened(names: string[] | undefined): void {
    this.opened = (names || []).slice(-MAX_CUSH_OPENED);
  }

  openedNames(): string[] {
    return this.opened.slice();
  }

  openedByHerald(): ReadonlySet<string> {
    return new Set(this.opened);
  }

  private markOpened(name: string, open: boolean): void {
    const had = this.opened.includes(name);
    if (open && !had) this.opened = [...this.opened, name].slice(-MAX_CUSH_OPENED);
    else if (!open && had) this.opened = this.opened.filter((n) => n !== name);
    else return;
    this.deps.onOpenedChange?.();
  }

  cushStatus(): Promise<CushStatus> {
    if (this.deps.status) return this.deps.status();
    return fetchCushStatus({
      cushToolsDir: this.deps.paths.cushToolsDir,
      userHome: this.deps.paths.userHome,
      exec: this.deps.exec,
    });
  }

  async validateCush(input: CushProposalInput): Promise<CushValidation> {
    const status = await this.cushStatus();
    return validateCushCommand(input, {
      userHome: this.deps.paths.userHome,
      cushToolsDir: this.deps.paths.cushToolsDir,
      active: status.ok ? status.tools : null,
      openedByHerald: this.openedByHerald(),
      portInfo: (p) => this.knowledge.infraPortInfo(p),
      isListening: this.deps.isListening,
      display: (p) => this.knowledge.display(p),
    });
  }

  /**
   * ActionManager hook: re-validate against the live state (the folder or the
   * running tools may have changed since the proposal), then run and verify.
   */
  async runCush(cmd: CushCommand): Promise<CushExecOutcome & { result?: CushRunResult }> {
    const again = await this.validateCush({
      operation: cmd.op,
      name: cmd.name,
      dir: cmd.dir,
      port: cmd.port,
    });
    if (!again.ok) return { ok: false, message: again.error, error: `Not run: ${again.error}` };
    // Re-validation must describe the very same command that was confirmed.
    const same =
      again.cmd.op === cmd.op &&
      again.cmd.name === cmd.name &&
      again.cmd.dir === cmd.dir &&
      again.cmd.port === cmd.port;
    if (!same)
      return {
        ok: false,
        message: 'The command changed; nothing was run.',
        error: 'The command changed; nothing was run.',
      };
    const result = this.deps.run
      ? await this.deps.run(cmd)
      : await runCushCommand(cmd, {
          cushToolsDir: this.deps.paths.cushToolsDir,
          userHome: this.deps.paths.userHome,
          exec: this.deps.exec,
        });
    if (result.ok) {
      if (cmd.op === 'close') this.markOpened(cmd.name, false);
      else if (cmd.op !== 'extend') this.markOpened(cmd.name, true);
    }
    return { ok: result.ok, message: result.message, error: result.error, result };
  }
}
