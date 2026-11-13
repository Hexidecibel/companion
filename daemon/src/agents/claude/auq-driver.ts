/**
 * Answers Claude Code's AskUserQuestion picker step by step, checking the
 * screen after every step instead of firing a fixed key sequence and hoping.
 *
 * Why not a key plan: the picker's keys depend on state the plan cannot see.
 * A digit on the Other row is TYPED into it (and a digit on an Other row that
 * already holds text submits that text); Enter on a multi-select row toggles
 * it; Right moves to the NEXT QUESTION on a multi-question box (the old
 * "toggle digits, Right, 1" answered the next question's option 1); toggling
 * by digit inverts whatever the user already checked in the terminal; options
 * with a preview only move the cursor on a digit. So: read the box, act, read
 * again, and report what really happened (or that it did not).
 *
 * Never submits the review screen on its own: only an explicit Submit (the
 * chat's final action, `submit`) or a review-card answer does.
 */
import type { KeyStep } from '../types';
import { parseClaudeAuqBox, type ParsedAuqBox } from './auq-box';

export interface AuqIO {
  /** A fresh capture of the pane (ANSI kept), or null when it cannot be read. */
  capture(): Promise<string | null>;
  send(steps: KeyStep[]): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export interface AuqAnswer {
  selectedIndices: number[];
  otherText?: string;
  /** Move between questions instead of answering ('back' from the review = last question). */
  navigate?: 'back' | 'next';
  /**
   * Multi-select on a one-question box: after checking, also confirm the
   * review screen. Set only for the user's own explicit Submit.
   */
  submit?: boolean;
}

export type AuqOutcome =
  /** The box is gone (Claude has the answer). */
  | 'answered'
  /** The next question is on screen. */
  | 'next_question'
  /** The review ("Submit answers / Cancel") screen is on screen, waiting. */
  | 'review'
  | 'submitted'
  | 'cancelled'
  | 'navigated';

export type AuqError =
  /** No AskUserQuestion box on screen. */
  | 'prompt_gone'
  /** Keys went out but the screen did not change as expected. */
  | 'choice_not_applied'
  /** Something this box cannot take (Other on a preview box, ...). */
  | 'unsupported'
  | 'send_failed';

export interface AuqResult {
  ok: boolean;
  outcome?: AuqOutcome;
  error?: AuqError;
  message?: string;
  /** Log lines (what was pressed, what was seen). */
  trace: string[];
}

/** Pause between keys: the picker repaints between key presses. */
export const AUQ_KEY_DELAY_MS = 120;
/** Re-capture this often, this many times, while waiting for a step to show. */
export const AUQ_VERIFY_DELAY_MS = 150;
export const AUQ_VERIFY_POLLS = 14;

function sig(b: ParsedAuqBox): string {
  return [b.header || '', b.question, ...b.options.map((o) => o.label)].join('\u0001');
}

function samePage(a: ParsedAuqBox, b: ParsedAuqBox | null): boolean {
  return (
    !!b &&
    b.auq.screen === a.auq.screen &&
    sig(a) === sig(b) &&
    (b.auq.activeTab ?? 0) === (a.auq.activeTab ?? 0)
  );
}

function squash(s: string): string {
  return s.replace(/\s+/g, '');
}

/** Row index of the cursor: options 0..n-1, n = Other, then Submit, then Chat. */
function cursorRow(b: ParsedAuqBox): number | null {
  const c = b.auq.cursor;
  const n = b.options.length;
  if (typeof c === 'number') return c;
  if (c === 'submit') return n + 1;
  if (c === 'chat') return b.auq.submitRow ? n + 2 : n + 1;
  return null;
}

export async function driveClaudeAuq(io: AuqIO, ans: AuqAnswer): Promise<AuqResult> {
  const trace: string[] = [];
  const read = async (): Promise<ParsedAuqBox | null> => {
    const pane = await io.capture();
    return pane === null ? null : parseClaudeAuqBox(pane);
  };
  const keys = async (...ks: string[]): Promise<boolean> => {
    const steps: KeyStep[] = [];
    for (const k of ks) {
      steps.push({ type: 'key', key: k });
      steps.push({ type: 'delay', ms: AUQ_KEY_DELAY_MS });
    }
    trace.push(`keys ${ks.join(' ')}`);
    return io.send(steps);
  };
  const waitFor = async (
    pred: (b: ParsedAuqBox | null) => boolean
  ): Promise<{ hit: boolean; box: ParsedAuqBox | null }> => {
    let box: ParsedAuqBox | null = null;
    for (let i = 0; i < AUQ_VERIFY_POLLS; i++) {
      box = await read();
      if (pred(box)) return { hit: true, box };
      await io.sleep(AUQ_VERIFY_DELAY_MS);
    }
    return { hit: false, box };
  };
  const fail = (error: AuqError, message: string): AuqResult => {
    trace.push(`fail ${error}: ${message}`);
    return { ok: false, error, message, trace };
  };
  const done = (outcome: AuqOutcome): AuqResult => {
    trace.push(`ok ${outcome}`);
    return { ok: true, outcome, trace };
  };
  /** Where an answer left the picker: gone, the next question, or the review. */
  const afterAnswer = (from: ParsedAuqBox, b: ParsedAuqBox | null): AuqOutcome => {
    if (!b) return 'answered';
    if (b.auq.screen === 'review') return 'review';
    return samePage(from, b) ? 'answered' : from.auq.tabs ? 'next_question' : 'answered';
  };

  let box = await read();
  if (!box) return fail('prompt_gone', 'No question box on screen');
  trace.push(
    `box ${box.auq.screen} tab ${box.auq.activeTab ?? '-'} cursor ${String(box.auq.cursor)}${box.auq.textMode ? ' text' : ''}`
  );

  /** Leave the Other row's text field: digits and arrows would edit the text. */
  const leaveText = async (): Promise<boolean> => {
    if (!box!.auq.textMode) return true;
    if (!(await keys('Up'))) return false;
    const r = await waitFor((b) => !!b && !b.auq.textMode);
    if (!r.hit) return false;
    box = r.box;
    return true;
  };

  /** Arrow the cursor onto a row (see cursorRow) and confirm it got there. */
  const moveTo = async (row: number): Promise<boolean> => {
    const from = cursorRow(box!);
    if (from === null) return false;
    const steps: string[] = [];
    for (let r = from; r !== row; r += row > from ? 1 : -1) steps.push(row > from ? 'Down' : 'Up');
    if (steps.length && !(await keys(...steps))) return false;
    const r = await waitFor((b) => !!b && cursorRow(b) === row);
    if (r.hit) box = r.box;
    return r.hit;
  };

  /** Arrow onto the Other row, clear it, type the text, confirm it shows. */
  const typeOther = async (text: string): Promise<AuqResult | null> => {
    const n = box!.options.length;
    if (!(await moveTo(n))) return fail('choice_not_applied', 'Could not reach the Other row');
    if (!(await keys('C-u'))) return fail('send_failed', 'Could not clear the Other row');
    trace.push(`text ${JSON.stringify(text.slice(0, 60))}`);
    if (
      !(await io.send([
        { type: 'text', text },
        { type: 'delay', ms: AUQ_KEY_DELAY_MS },
      ]))
    ) {
      return fail('send_failed', 'Could not type the answer');
    }
    const r = await waitFor((b) => !!b && squash(b.auq.other?.text ?? '') === squash(text));
    if (!r.hit) return fail('choice_not_applied', 'The typed answer did not show in the terminal');
    box = r.box;
    return null;
  };

  // ---- between questions ------------------------------------------------
  if (ans.navigate) {
    if (!box.auq.tabs)
      return fail('unsupported', 'This question has no other questions to move to');
    if (!(await leaveText())) return fail('choice_not_applied', 'Could not leave the text field');
    const start = box;
    if (!(await keys(ans.navigate === 'back' ? 'Left' : 'Right'))) {
      return fail('send_failed', 'Could not send the key');
    }
    const r = await waitFor(
      (b) =>
        !b ||
        b.auq.screen !== start.auq.screen ||
        b.auq.activeTab !== start.auq.activeTab ||
        sig(b) !== sig(start)
    );
    return r.hit ? done('navigated') : fail('choice_not_applied', 'The terminal did not move');
  }

  // ---- review screen ----------------------------------------------------
  if (box.auq.screen === 'review') {
    const idx = ans.selectedIndices[0];
    if (idx !== 0 && idx !== 1) return fail('unsupported', 'The review takes Submit or Cancel');
    if (!(await keys(String(idx + 1)))) return fail('send_failed', 'Could not send the key');
    const r = await waitFor((b) => !b || b.auq.screen !== 'review');
    if (!r.hit) return fail('choice_not_applied', 'The review screen is still up');
    return done(idx === 0 ? 'submitted' : 'cancelled');
  }

  const start = box;
  const n = box.options.length;

  // ---- single select ----------------------------------------------------
  if (!box.multiSelect) {
    if (ans.otherText !== undefined) {
      if (!box.auq.other) return fail('unsupported', 'This question takes no typed answer');
      const err = await typeOther(ans.otherText);
      if (err) return err;
      if (!(await keys('Enter'))) return fail('send_failed', 'Could not send Enter');
    } else {
      const idx = ans.selectedIndices[0];
      if (typeof idx !== 'number' || idx < 0 || idx >= n) {
        return fail('unsupported', `No option ${idx} (the question has ${n})`);
      }
      if (!(await leaveText())) return fail('choice_not_applied', 'Could not leave the text field');
      if (box.auq.preview || idx + 1 > 9) {
        // Preview boxes: a digit only moves the cursor (to show its preview).
        const ok = idx + 1 <= 9 ? await keys(String(idx + 1)) : await moveTo(idx);
        if (!ok) return fail('send_failed', 'Could not send the key');
        const r = await waitFor((b) => !!b && b.auq.cursor === idx);
        if (!r.hit) return fail('choice_not_applied', 'The cursor did not reach the option');
        if (!(await keys('Enter'))) return fail('send_failed', 'Could not send Enter');
      } else if (!(await keys(String(idx + 1)))) {
        return fail('send_failed', 'Could not send the key');
      }
    }
    const r = await waitFor((b) => !samePage(start, b));
    if (!r.hit) return fail('choice_not_applied', 'The question is still on screen');
    return done(afterAnswer(start, r.box));
  }

  // ---- multi select -----------------------------------------------------
  const target = new Set(ans.selectedIndices.filter((i) => i >= 0 && i < n));
  const wantOther = ans.otherText !== undefined && ans.otherText.trim() !== '';
  if (ans.otherText !== undefined && !box.auq.other) {
    return fail('unsupported', 'This question takes no typed answer');
  }
  if (wantOther && squash(box.auq.other?.text ?? '') !== squash(ans.otherText!)) {
    // Typing checks the Other row; then leave it before any digit.
    const err = await typeOther(ans.otherText!.trim());
    if (err) return err;
  }
  if (!(await leaveText())) return fail('choice_not_applied', 'Could not leave the text field');

  const toggles: string[] = [];
  box.options.forEach((o, i) => {
    if (!!o.selected !== target.has(i)) toggles.push(String(i + 1));
  });
  const other = box.auq.other;
  if (other && !!other.checked !== wantOther) toggles.push(String(other.number));
  if (toggles.some((k) => Number(k) > 9)) return fail('unsupported', 'More than 9 rows');
  if (toggles.length && !(await keys(...toggles)))
    return fail('send_failed', 'Could not send the keys');

  const matches = (b: ParsedAuqBox | null): boolean =>
    !!b &&
    samePage(start, b) &&
    b.options.every((o, i) => !!o.selected === target.has(i)) &&
    (!b.auq.other || !!b.auq.other.checked === wantOther);
  const checked = await waitFor(matches);
  if (!checked.hit) {
    return fail('choice_not_applied', 'The checkboxes in the terminal do not match the selection');
  }
  box = checked.box;

  // Next question, or the review screen after the last one.
  if (!(await keys('Right'))) return fail('send_failed', 'Could not send the key');
  const moved = await waitFor((b) => !samePage(start, b));
  if (!moved.hit) return fail('choice_not_applied', 'The terminal did not move on');
  const outcome = afterAnswer(start, moved.box);
  const single = (start.auq.tabs?.length ?? 1) === 1;
  if (outcome === 'review' && ans.submit && single && !moved.box!.auq.incomplete) {
    if (!(await keys('1'))) return fail('send_failed', 'Could not send the key');
    const r = await waitFor((b) => !b || b.auq.screen !== 'review');
    if (!r.hit) return fail('choice_not_applied', 'The review screen is still up');
    return done('submitted');
  }
  return done(outcome);
}
