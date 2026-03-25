import { InputInjector } from './input-injector';
import { TmuxManager } from './tmux-manager';
import { APPROVAL_SEND_DELAY_MS, AUTO_APPROVAL_MAX_TRACKED_IDS } from './constants';
import { BoundedSet } from './utils';

export interface AutoApprovalDeps {
  /** Tools configured for auto-approval in config */
  autoApproveTools: string[];
  /** Returns true if the given session has client-toggled auto-approve */
  isSessionAutoApproveEnabled: (sessionId: string) => boolean;
  /** Injector for sending input to tmux */
  injector: InputInjector;
}

export class AutoApprovalService {
  private approvedToolIds: BoundedSet<string>;
  private deps: AutoApprovalDeps;

  private static readonly APPROVAL_PROMPT_RE =
    /\(Y\)es\s*\/\s*\(N\)o|Do you want to (proceed|run|allow|execute)|Approve\?|Allow this|Yes\/No/i;

  constructor(deps: AutoApprovalDeps) {
    this.deps = deps;
    this.approvedToolIds = new BoundedSet<string>(AUTO_APPROVAL_MAX_TRACKED_IDS);
    console.log(
      `Auto-approve tools from config: ${deps.autoApproveTools.length > 0 ? deps.autoApproveTools.join(', ') : '(none - client toggle only)'}`
    );
  }

  /**
   * Handle a pending-approval event from the watcher.
   * Checks config and per-session toggle, deduplicates by tool ID,
   * verifies the tmux approval prompt, then sends "yes".
   */
  async handlePendingApproval(
    sessionId: string,
    projectPath: string | undefined,
    tools: Array<{ name: string; id: string }>
  ): Promise<void> {
    // Check per-session toggle OR config-level tools
    const sessionEnabled = this.deps.isSessionAutoApproveEnabled(sessionId);
    if (this.deps.autoApproveTools.length === 0 && !sessionEnabled) {
      return;
    }

    // Only approve tools in the config list OR if the session toggle is on
    const autoApprovable = tools.filter((tool) => {
      if (this.deps.autoApproveTools.includes(tool.name)) return true;
      if (sessionEnabled) return true;
      return false;
    });

    if (autoApprovable.length === 0) {
      console.log(
        `[AUTO-APPROVE] No auto-approvable tools in: [${tools.map((t) => t.name).join(', ')}]`
      );
      return;
    }

    // Dedup by tool IDs — each unique tool use ID gets approved exactly once.
    const unapproved = autoApprovable.filter((t) => !this.approvedToolIds.has(t.id));
    if (unapproved.length === 0) {
      console.log(
        `[AUTO-APPROVE] Dedup: all tool IDs already approved [${autoApprovable.map((t) => t.name).join(', ')}]`
      );
      return;
    }

    // Mark all tool IDs as approved before sending
    for (const t of autoApprovable) {
      this.approvedToolIds.add(t.id);
    }

    // Resolve tmux session target
    let targetTmuxSession: string | undefined = sessionId;
    if (!targetTmuxSession && projectPath) {
      const tmux = new TmuxManager('companion');
      const tmuxSessions = await tmux.listSessions();
      const normalizedPath = projectPath.replace(/\/+$/, '');
      const match = tmuxSessions.find(
        (ts) =>
          ts.workingDir === projectPath || ts.workingDir?.replace(/\/+$/, '') === normalizedPath
      );
      if (match) {
        targetTmuxSession = match.name;
      }
    }

    const target = targetTmuxSession || undefined;
    console.log(
      `[AUTO-APPROVE] Approving [${autoApprovable.map((t) => t.name).join(', ')}] -> tmux="${target || 'active'}" (session: ${sessionId.substring(0, 8)})`
    );

    try {
      await this.verifyAndSendApproval(target);
    } catch (err) {
      console.error(`[AUTO-APPROVE] Error: ${err}`);
    }
  }

  /**
   * Check the tmux pane for an approval prompt, retry once if not found,
   * then send "yes".
   */
  private async verifyAndSendApproval(target: string | undefined): Promise<void> {
    const { injector } = this.deps;

    const paneContent = await injector.capturePaneContent(target);
    const hasApprovalPrompt = AutoApprovalService.APPROVAL_PROMPT_RE.test(paneContent);

    if (!hasApprovalPrompt) {
      // Prompt may not have rendered yet — wait and retry once
      console.log(`[AUTO-APPROVE] No approval prompt detected, waiting ${APPROVAL_SEND_DELAY_MS}ms...`);
      await new Promise((resolve) => setTimeout(resolve, APPROVAL_SEND_DELAY_MS));
      const paneContent2 = await injector.capturePaneContent(target);
      const hasPrompt2 = AutoApprovalService.APPROVAL_PROMPT_RE.test(paneContent2);
      if (!hasPrompt2) {
        console.log(`[AUTO-APPROVE] Still no prompt after wait, sending anyway`);
      }
    }

    const success = await injector.sendInput('yes', target);
    if (!success) {
      console.log(`[AUTO-APPROVE] Send failed, retrying after ${APPROVAL_SEND_DELAY_MS}ms...`);
      await new Promise((resolve) => setTimeout(resolve, APPROVAL_SEND_DELAY_MS));
      await injector.sendInput('yes', target);
    } else {
      console.log(`[AUTO-APPROVE] Sent "yes" successfully`);
    }
  }
}
