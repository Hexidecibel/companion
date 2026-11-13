/**
 * driveClaudeAuq against real Claude Code screens (fixtures/cc-contract): a
 * fake terminal shows a capture and switches to the next one on the keys the
 * real picker reacts to, so every step's verification runs for real.
 */
import * as fs from 'fs';
import * as path from 'path';
import { driveClaudeAuq, type AuqIO } from '../agents/claude/auq-driver';
import type { KeyStep } from '../agents/types';

const DIR = path.join(__dirname, 'fixtures', 'cc-contract');
const fx = (name: string): string =>
  fs.readFileSync(path.join(DIR, `auq-cc2.1.323-${name}.txt`), 'utf8');
const GONE = '❯ \n──────\n  ? for shortcuts';

const SINGLE = fx('single-w120-s1');
const MQ1 = fx('multi-question-w120-s1');
const MQ2 = fx('multi-question-w120-s2');
const MQ3 = fx('multi-question-w120-s3');
const REVIEW = fx('multi-question-w120-s4');
const MQ3_BACK = fx('multi-question-w120-s5');
const MULTI = fx('multi-w120-s1');
const PREVIEW = fx('preview-w120-s1');

/** Check row n of a multi-select capture ("2.<esc>[39m [ ] Soup" -> "[✔]"). */
function check(pane: string, ...rows: number[]): string {
  return pane
    .split('\n')
    .map((l) =>
      rows.some((n) => new RegExp(`(m|\\s)${n}\\.(\\x1b\\[39m)? ?\\[ \\]`).test(l))
        ? l.replace('[ ]', '[✔]')
        : l
    )
    .join('\n');
}

/** A fake pane: `on(screen, key)` returns the next screen, or undefined to stay. */
function fakeIO(start: string, on: (screen: string, key: string) => string | undefined) {
  let screen = start;
  const keys: string[] = [];
  const io: AuqIO = {
    capture: async () => screen,
    send: async (steps: KeyStep[]) => {
      for (const s of steps) {
        if (s.type === 'key') {
          keys.push(s.key);
          screen = on(screen, s.key) ?? screen;
        } else if (s.type === 'text') {
          keys.push(`text:${s.text}`);
          screen = on(screen, `text:${s.text}`) ?? screen;
        }
      }
      return true;
    },
    sleep: async () => {},
  };
  return { io, keys };
}

describe('driveClaudeAuq', () => {
  it('single select: one digit, box gone -> answered', async () => {
    const { io, keys } = fakeIO(SINGLE, (_s, k) => (k === '2' ? GONE : undefined));
    const r = await driveClaudeAuq(io, { selectedIndices: [1] });
    expect(r).toMatchObject({ ok: true, outcome: 'answered' });
    expect(keys).toEqual(['2']);
  });

  it('reports choice_not_applied when the terminal ignores the key', async () => {
    const { io } = fakeIO(SINGLE, () => undefined);
    const r = await driveClaudeAuq(io, { selectedIndices: [1] });
    expect(r).toMatchObject({ ok: false, error: 'choice_not_applied' });
  });

  it('reports prompt_gone when no box is on screen', async () => {
    const { io, keys } = fakeIO(GONE, () => undefined);
    const r = await driveClaudeAuq(io, { selectedIndices: [0] });
    expect(r).toMatchObject({ ok: false, error: 'prompt_gone' });
    expect(keys).toEqual([]);
  });

  it('refuses an option the question does not have', async () => {
    const { io, keys } = fakeIO(SINGLE, () => undefined);
    const r = await driveClaudeAuq(io, { selectedIndices: [7] });
    expect(r).toMatchObject({ ok: false, error: 'unsupported' });
    expect(keys).toEqual([]);
  });

  it('multi-question: first answer moves to the next question', async () => {
    const { io } = fakeIO(MQ1, (_s, k) => (k === '2' ? MQ2 : undefined));
    expect(await driveClaudeAuq(io, { selectedIndices: [1] })).toMatchObject({
      ok: true,
      outcome: 'next_question',
    });
  });

  it('multi-select tab: toggles only the wanted rows, verifies, then Right (never "1")', async () => {
    const { io, keys } = fakeIO(MQ2, (s, k) => {
      if (k === '2') return check(s, 2);
      if (k === '3') return check(s, 3);
      if (k === 'Right') return MQ3;
      return undefined;
    });
    const r = await driveClaudeAuq(io, { selectedIndices: [1, 2] });
    expect(r).toMatchObject({ ok: true, outcome: 'next_question' });
    expect(keys).toEqual(['2', '3', 'Right']);
  });

  it('multi-select: a row the user already checked in the terminal is not toggled off', async () => {
    const { io, keys } = fakeIO(check(MQ2, 2), (s, k) => {
      if (k === '3') return check(s, 3);
      if (k === 'Right') return MQ3;
      return undefined;
    });
    await driveClaudeAuq(io, { selectedIndices: [1, 2] });
    expect(keys).toEqual(['3', 'Right']);
  });

  it('last question -> review, and the review is not submitted on its own', async () => {
    const { io, keys } = fakeIO(MQ3, (_s, k) => (k === '2' ? REVIEW : undefined));
    const r = await driveClaudeAuq(io, { selectedIndices: [1], submit: true });
    expect(r).toMatchObject({ ok: true, outcome: 'review' });
    expect(keys).toEqual(['2']);
  });

  it('review: back goes to the last question', async () => {
    const { io, keys } = fakeIO(REVIEW, (_s, k) => (k === 'Left' ? MQ3_BACK : undefined));
    const r = await driveClaudeAuq(io, { selectedIndices: [], navigate: 'back' });
    expect(r).toMatchObject({ ok: true, outcome: 'navigated' });
    expect(keys).toEqual(['Left']);
  });

  it('review: Submit and Cancel', async () => {
    const sub = fakeIO(REVIEW, (_s, k) => (k === '1' ? GONE : undefined));
    expect(await driveClaudeAuq(sub.io, { selectedIndices: [0] })).toMatchObject({
      outcome: 'submitted',
    });
    const can = fakeIO(REVIEW, (_s, k) => (k === '2' ? GONE : undefined));
    expect(await driveClaudeAuq(can.io, { selectedIndices: [1] })).toMatchObject({
      outcome: 'cancelled',
    });
  });

  it('one-question multi-select with the explicit Submit confirms the review', async () => {
    const { io, keys } = fakeIO(MULTI, (s, k) => {
      if (k === '1' && s !== REVIEW) return check(s, 1);
      if (k === '3') return check(s, 3);
      if (k === 'Right') return REVIEW;
      if (k === '1' && s === REVIEW) return GONE;
      return undefined;
    });
    const r = await driveClaudeAuq(io, { selectedIndices: [0, 2], submit: true });
    expect(r).toMatchObject({ ok: true, outcome: 'submitted' });
    expect(keys).toEqual(['1', '3', 'Right', '1']);
  });

  it('preview box: digit moves the cursor, Enter submits', async () => {
    const moved = PREVIEW.split('\n')
      .map((l) =>
        l.includes('❯') && l.includes(' 1.')
          ? l.replace('❯', ' ')
          : l.startsWith(' \x1b[38;5;246m 2.')
            ? '❯' + l.slice(1)
            : l
      )
      .join('\n');
    const { io, keys } = fakeIO(PREVIEW, (s, k) => {
      if (k === '2') return moved;
      if (k === 'Enter' && s === moved) return GONE;
      return undefined;
    });
    const r = await driveClaudeAuq(io, { selectedIndices: [1] });
    expect(keys).toEqual(['2', 'Enter']);
    expect(r).toMatchObject({ ok: true, outcome: 'answered' });
  });

  it('preview box takes no typed answer', async () => {
    const { io } = fakeIO(PREVIEW, () => undefined);
    expect(await driveClaudeAuq(io, { selectedIndices: [], otherText: 'x' })).toMatchObject({
      ok: false,
      error: 'unsupported',
    });
  });
});
