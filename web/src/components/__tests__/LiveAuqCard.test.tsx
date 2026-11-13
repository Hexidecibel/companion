import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { LiveAuqCard } from '../LiveAuqCard';
import { MessageBubble } from '../MessageBubble';
import type { ConversationHighlight, Question } from '../../types';

const LONG =
  'Rewrite the whole persistence layer on top of the new storage engine, migrating every table and keeping the old reader around for a release';

const single: Question = {
  question: 'Which drink?',
  header: 'Drink',
  multiSelect: false,
  options: [
    { label: 'Water', description: '' },
    { label: LONG, description: 'x'.repeat(200) },
  ],
  live: {
    signature: 'sig-1',
    screen: 'question',
    questionIndex: 2,
    questionCount: 3,
    tabs: [
      { label: 'Food', answered: true },
      { label: 'Sides', answered: true },
      { label: 'Drink', answered: false },
    ],
    allowOther: true,
  },
};

const multi: Question = {
  question: 'Which sides?',
  header: 'Sides',
  multiSelect: true,
  options: [
    { label: 'Salad', description: '', selected: true },
    { label: 'Soup', description: '', selected: false },
    { label: 'Fries', description: '', selected: false },
  ],
  live: { signature: 'sig-2', screen: 'question', allowOther: true, submitRow: 'Submit' },
};

const review: Question = {
  question: 'Review your answers',
  header: '',
  multiSelect: false,
  options: [
    { label: 'Submit answers', description: '' },
    { label: 'Cancel', description: '' },
  ],
  live: {
    signature: 'sig-3',
    screen: 'review',
    questionIndex: 3,
    questionCount: 3,
    review: [
      { question: 'Which main course?', answer: 'Curry' },
      { question: 'Which sides?', answer: 'Soup, Fries' },
    ],
    incomplete: true,
  },
};

describe('LiveAuqCard', () => {
  afterEach(cleanup);

  it('shows progress, answered tabs, the full long label and Back', () => {
    render(<LiveAuqCard question={single} onSelectChoice={async () => true} />);
    expect(screen.getByText('Question 3 of 3')).toBeTruthy();
    expect(screen.getByText(LONG)).toBeTruthy();
    expect(screen.getByText(/show more/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
  });

  it('single select: one tap sends the index, label and signature, then stays disabled', async () => {
    const onSelectChoice = vi.fn(async () => true);
    render(<LiveAuqCard question={single} onSelectChoice={onSelectChoice} />);
    fireEvent.click(screen.getByText('Water'));
    expect(onSelectChoice).toHaveBeenCalledWith({
      selectedIndices: [0],
      optionCount: 2,
      multiSelect: false,
      selectedLabels: ['Water'],
      expectSignature: 'sig-1',
    });
    await waitFor(() => expect((screen.getByText('Water').closest('button') as HTMLButtonElement).disabled).toBe(true));
  });

  it('Back navigates; Other sends the typed text', () => {
    const onSelectChoice = vi.fn(async () => true);
    render(<LiveAuqCard question={single} onSelectChoice={onSelectChoice} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onSelectChoice).toHaveBeenLastCalledWith(expect.objectContaining({ navigate: 'back', expectSignature: 'sig-1' }));
  });

  it('Other: typed text goes as otherText', () => {
    const onSelectChoice = vi.fn(async () => true);
    render(<LiveAuqCard question={single} onSelectChoice={onSelectChoice} />);
    fireEvent.change(screen.getByPlaceholderText(/type your own/), { target: { value: ' Tacos ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSelectChoice).toHaveBeenCalledWith(
      expect.objectContaining({ selectedIndices: [], otherText: 'Tacos', expectSignature: 'sig-1' })
    );
  });

  it('multi select: starts from the terminal checks, toggles locally, sends only on Submit', () => {
    const onSelectChoice = vi.fn(async () => true);
    render(<LiveAuqCard question={multi} onSelectChoice={onSelectChoice} />);
    const boxes = screen.getAllByRole('checkbox', { checked: true });
    expect(boxes.length).toBe(1);
    fireEvent.click(screen.getByText('Fries'));
    expect(onSelectChoice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onSelectChoice).toHaveBeenCalledWith({
      selectedIndices: [0, 2],
      optionCount: 3,
      multiSelect: true,
      selectedLabels: ['Salad', 'Fries'],
      submit: true,
      expectSignature: 'sig-2',
    });
  });

  it('review: answers, incomplete warning, Submit and Cancel are explicit', () => {
    const onSelectChoice = vi.fn(async () => true);
    render(<LiveAuqCard question={review} onSelectChoice={onSelectChoice} />);
    expect(screen.getByText('Soup, Fries')).toBeTruthy();
    expect(screen.getByText(/Not every question/)).toBeTruthy();
    expect(onSelectChoice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }));
    expect(onSelectChoice).toHaveBeenCalledWith(
      expect.objectContaining({ selectedIndices: [0], submit: true, expectSignature: 'sig-3' })
    );
  });

  it('a refused answer re-enables the card and says why', async () => {
    render(<LiveAuqCard question={single} onSelectChoice={async () => false} />);
    fireEvent.click(screen.getByText('Water'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect((screen.getByText('Water').closest('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('MessageBubble renders the live card for a live question', () => {
    const message: ConversationHighlight = {
      id: 'live',
      type: 'assistant',
      content: 'Which drink?',
      timestamp: 1,
      isWaitingForChoice: true,
      questions: [single],
    };
    render(<MessageBubble message={message} onSelectChoice={async () => true} onSelectOption={() => undefined} />);
    expect(screen.getByTestId('live-auq-card')).toBeTruthy();
  });
});
