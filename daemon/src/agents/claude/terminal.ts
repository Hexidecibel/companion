/**
 * Claude Code's terminal side: launch line, TUI reading (prompt box, overlays,
 * choice / permission boxes, start-up screens) and the keys that answer a
 * choice box. Thin wrappers over the existing parser / prompt-guard code; the
 * Claude-only pieces that had no better home (launch command, start-up screen,
 * approval regex, choice key sequence) live here and are re-exported from their
 * old modules.
 */
import {
  detectActiveChoicePrompt as parserDetectActiveChoicePrompt,
  parsePermissionPrompt,
  parseTextChoicePrompt,
} from '../../parser';
import { detectOverlay, readPromptBox } from '../../prompt-guard';
import {
  POST_ENTER_DELAY_MS,
  POST_OTHER_SELECT_DELAY_MS,
  POST_TEXT_DELAY_MS,
  POST_TEXT_INPUT_DELAY_MS,
} from '../../constants';
import { CLAUDE_TRUST, parseTrustPrompt } from '../trust';
import type { TerminalChoicePrompt } from '../../types';
import type {
  AgentTerminal,
  ChoiceKeyPlan,
  ChoiceRequest,
  KeyStep,
  StartupPaneState,
} from '../types';

/** Permission modes the app may start Claude with (`claude --permission-mode`). */
export type ClaudePermissionMode = 'bypassPermissions';

/** The shell line typed into a new session to start Claude. */
export function claudeCommand(permissionMode?: ClaudePermissionMode): string {
  return permissionMode === 'bypassPermissions'
    ? 'claude --permission-mode bypassPermissions'
    : 'claude';
}

/**
 * What a freshly started session's screen shows. Claude Code in
 * bypass-permissions mode parks at a one-time "Yes, I accept" warning per
 * folder; a new folder may ask whether to trust it. Herald never answers either
 * on the user's behalf.
 */
export function classifyStartupPane(pane: string): StartupPaneState {
  const p = pane || '';
  if (/Bypass Permissions mode/i.test(p) && /Yes,? I accept/i.test(p)) return 'bypass_warning';
  if (/Do you trust the files in this folder|trust this folder/i.test(p)) return 'trust_prompt';
  // Claude's own input box / footer. A bare "❯" is not enough: a shell prompt
  // (after "No, exit") can use it too, and the first prompt must never be typed
  // into a shell.
  if (/for shortcuts|bypass permissions on|shift\+tab to cycle|Try "/i.test(p)) return 'ready';
  if (/❯/.test(p) && /[─━]{10,}/.test(p)) return 'ready';
  return 'starting';
}

/**
 * The live choice box; the start-up trust prompt first, as "Yes, trust" / "No"
 * (same order as Claude's own options, so the digit keys answer it).
 */
export function detectActiveChoicePrompt(paneOutput: string): TerminalChoicePrompt | null {
  return parseTrustPrompt(paneOutput, CLAUDE_TRUST) ?? parserDetectActiveChoicePrompt(paneOutput);
}

/** A pane showing a tool-approval prompt (auto-approval verifies this before sending "yes"). */
export const CLAUDE_APPROVAL_PROMPT_RE =
  /\(Y\)es\s*\/\s*\(N\)o|Do you want to (proceed|run|allow|execute)|Approve\?|Allow this|Yes\/No/i;

/** ms between key presses: the picker repaints between keypresses. */
export const CHOICE_KEY_DELAY_MS = 120;

/**
 * Keys that answer Claude Code's choice box (AskUserQuestion picker).
 *
 * The picker renders NUMBERED options (1., 2., 3., ...). Pressing the option's
 * digit is far more robust than positional arrow walking (no cumulative cursor
 * drift), so digit keys are the primary mechanism. Verified against a live
 * picker (Claude Code 2.1.x):
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
export function claudeChoiceKeys(req: ChoiceRequest): ChoiceKeyPlan {
  const { selectedIndices, optionCount, multiSelect, otherText } = req;
  const steps: KeyStep[] = [];
  const warnings: string[] = [];
  const key = (k: string) => steps.push({ type: 'key', key: k });
  const delay = (ms: number) => steps.push({ type: 'delay', ms });

  if (otherText !== undefined) {
    // "Other" / free-text ("Type something.") is the numbered row AFTER the real
    // options, i.e. position (optionCount + 1). Pressing its digit highlights it and
    // opens an inline text field (no submit); then we type the text and press Enter.
    const otherNumber = optionCount + 1; // 1-based position of "Type something."
    if (otherNumber <= 9) {
      key(String(otherNumber));
    } else {
      // >9 options: digit can't address the Other row — walk down to it instead.
      for (let i = 0; i < optionCount; i++) {
        key('Down');
        delay(CHOICE_KEY_DELAY_MS);
      }
      key('Enter');
    }
    // Wait for the inline text field to open before typing.
    delay(POST_OTHER_SELECT_DELAY_MS);
    // Type the free-text (replaces the "Type something." label in place).
    steps.push({ type: 'text', text: otherText });
    delay(POST_TEXT_INPUT_DELAY_MS);
    key('Enter');
    return {
      description: `choice: Other "${otherText.substring(0, 60)}" (option ${otherNumber})`,
      warnings,
      steps,
    };
  }

  if (multiSelect) {
    // Multi-select: each option has a [ ] checkbox. Pressing the option's digit
    // toggles that checkbox in place (cursor stays put, nothing submits), so we can
    // address selected options directly with no positional drift. After toggling,
    // Right arrow opens the "Submit answers / Cancel" review screen and "1" confirms.
    const sorted = [...new Set(selectedIndices)].sort((a, b) => a - b);
    for (const idx of sorted) {
      const num = idx + 1; // 1-based option number
      if (num > 9) {
        // Digit keys can't address rows past 9; AskUserQuestion never has this many.
        warnings.push(`Multi-select option ${num} exceeds digit range, skipping`);
        continue;
      }
      key(String(num));
      delay(CHOICE_KEY_DELAY_MS);
    }
    // Open the review/Submit screen, then confirm with "1. Submit answers".
    key('Right');
    delay(POST_OTHER_SELECT_DELAY_MS);
    key('1');
    return {
      description: `multi-select choice: indices [${sorted.join(',')}] of ${optionCount}`,
      warnings,
      steps,
    };
  }

  // Single-select: pressing the option's digit selects AND submits in one keypress.
  const idx = selectedIndices[0] || 0;
  const num = idx + 1; // 1-based option number
  if (num <= 9) {
    key(String(num));
  } else {
    // >9 options: fall back to arrow navigation + Enter.
    for (let i = 0; i < idx; i++) {
      key('Down');
      delay(CHOICE_KEY_DELAY_MS);
    }
    key('Enter');
  }
  return {
    description: `single-select choice: index ${idx} (option ${num}) of ${optionCount}`,
    warnings,
    steps,
  };
}

/** Free text: typed literally, a pause for the TUI to take it, then Enter. */
export function claudeTextKeys(text: string): KeyStep[] {
  return [
    { type: 'text', text },
    { type: 'delay', ms: POST_TEXT_DELAY_MS },
    { type: 'key', key: 'Enter' },
    { type: 'delay', ms: POST_ENTER_DELAY_MS },
  ];
}

export const claudeTerminal: AgentTerminal<ClaudePermissionMode> = {
  launchCommand: claudeCommand,
  readPromptBox,
  detectOverlay,
  parsePermissionPrompt,
  parseTextChoicePrompt,
  detectActiveChoicePrompt,
  approvalPromptRe: CLAUDE_APPROVAL_PROMPT_RE,
  choiceKeys: claudeChoiceKeys,
  classifyStartupPane,
  textKeys: claudeTextKeys,
  interruptKeys: () => [{ type: 'key', key: 'C-c' }],
};
