import * as fs from 'fs';
import * as path from 'path';
import { parseClaudeAuqBox } from '../agents/claude/auq-box';
import { liveAuqState } from '../handlers/session';

const fx = (name: string) =>
  parseClaudeAuqBox(
    fs.readFileSync(
      path.join(__dirname, 'fixtures', 'cc-contract', `auq-cc2.1.323-${name}.txt`),
      'utf8'
    )
  )!;

describe('liveAuqState (the chat card state of a live AskUserQuestion box)', () => {
  it('multi-question tab: index, count, tabs, Other, Next row', () => {
    expect(liveAuqState(fx('multi-question-w120-s2'), 'sig')).toEqual({
      signature: 'sig',
      screen: 'question',
      questionIndex: 1,
      questionCount: 3,
      tabs: [
        { label: 'Food', answered: true },
        { label: 'Sides', answered: false },
        { label: 'Drink', answered: false },
      ],
      allowOther: true,
      submitRow: 'Next',
    });
  });

  it('review screen: the answers and the review index', () => {
    const s = liveAuqState(fx('multi-question-w120-s4'), 'sig');
    expect(s.screen).toBe('review');
    expect(s.questionIndex).toBe(3);
    expect(s.review).toEqual([
      { question: 'Which main course?', answer: 'Curry' },
      { question: 'Which sides?', answer: 'Soup, Fries' },
      { question: 'Which drink?', answer: 'Lemonade' },
    ]);
  });

  it('single question: no tabs; preview box: no Other', () => {
    expect(liveAuqState(fx('single-w120-s1'), 'a')).toEqual({
      signature: 'a',
      screen: 'question',
      allowOther: true,
    });
    expect(liveAuqState(fx('preview-w60-s1'), 'b')).toEqual({
      signature: 'b',
      screen: 'question',
      preview: true,
    });
  });
});
