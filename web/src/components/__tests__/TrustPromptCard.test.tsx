import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { TrustPromptCard } from '../TrustPromptCard';
import { MessageBubble } from '../MessageBubble';
import { buildStatusLine } from '../../utils/sessionStatusLine';
import type { ConversationHighlight, Question } from '../../types';

const FOLDER = '/home/hexi/.cache/trust-repro/plain';
const question: Question = {
  question: `Trust this folder?\n${FOLDER}`,
  header: 'Claude Code',
  multiSelect: false,
  kind: 'trust',
  options: [
    { label: 'Yes, trust', description: 'Claude Code can read, edit and run files here' },
    { label: 'No', description: 'Claude Code exits without opening this folder' },
  ],
};

describe('TrustPromptCard', () => {
  afterEach(cleanup);

  it('shows the title, full folder, what trusting means and both buttons', () => {
    render(<TrustPromptCard question={question} onAnswer={async () => true} />);
    expect(screen.getByText('Trust this folder?')).toBeTruthy();
    expect(screen.getByText(FOLDER)).toBeTruthy();
    expect(screen.getByText(/can read, edit and run files here/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Yes, trust' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'No' })).toBeTruthy();
    expect(screen.getByText(/No: Claude Code exits/)).toBeTruthy();
  });

  it('sends yes as option 0, disables both while sending, then says so', async () => {
    let done: (ok: boolean) => void = () => undefined;
    const onAnswer = vi.fn(() => new Promise<boolean>((r) => { done = r; }));
    render(<TrustPromptCard question={question} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, trust' }));
    expect(onAnswer).toHaveBeenCalledWith({
      selectedIndices: [0], optionCount: 2, multiSelect: false, promptKind: 'trust',
    });
    expect(screen.getByRole('button', { name: 'Sending...' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'No' })).toHaveProperty('disabled', true);
    done(true);
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Starting/));
  });

  it('No explains what happens', async () => {
    const onAnswer = vi.fn(async () => true);
    render(<TrustPromptCard question={question} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(onAnswer.mock.calls[0]).toEqual([expect.objectContaining({ selectedIndices: [1] })]);
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/exits without opening/));
  });

  it('a failed send shows an error and the buttons come back', async () => {
    render(<TrustPromptCard question={question} onAnswer={async () => false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, trust' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/did not reach/));
    expect(screen.getByRole('button', { name: 'Yes, trust' })).toHaveProperty('disabled', false);
  });

  it('the chat renders the card, not the terminal-style choice, for a trust question', () => {
    const message = {
      id: 'live', type: 'assistant', content: '', timestamp: 1,
      isWaitingForChoice: true, questions: [question], liveSourced: true,
    } as ConversationHighlight;
    const { container } = render(
      <MessageBubble message={message} onSelectOption={async () => true} onSelectChoice={async () => true} />
    );
    expect(container.querySelector('.trust-card')).toBeTruthy();
    expect(screen.getAllByText('Trust this folder?').length).toBe(1);
  });
});

describe('status line', () => {
  it('says it waits on you, with the title only', () => {
    const line = buildStatusLine({
      status: { isRunning: true, isWaitingForInput: true, lastActivity: 0 },
      highlights: [{ id: 'l', type: 'assistant', content: '', timestamp: 1, isWaitingForChoice: true, questions: [question] } as ConversationHighlight],
      now: 1,
    })!;
    expect(line.activity).toBe('Waiting on you: Trust this folder?');
  });
});
