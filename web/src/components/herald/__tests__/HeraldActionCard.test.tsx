import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { HeraldActionCard, HeraldPendingMarker } from '../HeraldActionCard';
import type { HeraldAction } from '../../../types/herald';

function card(over: Partial<HeraldAction> = {}): HeraldAction {
  return {
    id: 'a1',
    tier: 'hard_confirm',
    kind: 'send_input',
    serverId: 'local',
    sessionId: 'out4',
    sessionName: 'Out4',
    payload: 'deploy',
    readback: 'Out4: "deploy to prod"',
    reasons: ['your request involves: deploy'],
    status: 'pending',
    createdAt: 1,
    confirmPhrase: 'confirm deploy',
    voiceAttemptsLeft: 3,
    ...over,
  };
}

const props = { skewMs: 0, onDecide: vi.fn(async () => {}), onOpenSession: vi.fn() };

describe('HeraldActionCard voice phrase', () => {
  it('shows the phrase to say on a red card, with tries left once used', () => {
    const { rerender } = render(<HeraldActionCard action={card()} {...props} />);
    expect(screen.getByLabelText('Or say: confirm deploy')).toBeTruthy();
    expect(screen.getByText('confirm deploy')).toBeTruthy();
    expect(screen.getByText('Hold to confirm')).toBeTruthy();
    rerender(<HeraldActionCard action={card({ voiceAttemptsLeft: 1 })} {...props} />);
    expect(screen.getByText(/1 try left/)).toBeTruthy();
    rerender(<HeraldActionCard action={card({ voiceAttemptsLeft: 0 })} {...props} />);
    expect(screen.getByText(/Voice tries used up/)).toBeTruthy();
    // Holding still works.
    expect(screen.getByText('Hold to confirm')).toBeTruthy();
  });

  it('a new-session card has no session to open yet', () => {
    render(<HeraldActionCard action={card({ kind: 'spawn_session', sessionId: 'spawn:/x/companion', sessionName: 'companion', confirmPhrase: 'confirm launch' })} {...props} />);
    expect(screen.getByTitle('New session').tagName).toBe('SPAN');
    expect(screen.getByText('confirm launch')).toBeTruthy();
  });
});

describe('HeraldActionCard babysitter cards', () => {
  const suggestion = (over: Partial<HeraldAction> = {}) => card({
    tier: 'echo',
    kind: 'answer_choice',
    payload: '2',
    readback: 'Out4: option 2, Keep the old API',
    reasons: [],
    confirmPhrase: undefined,
    voiceAttemptsLeft: undefined,
    suggested: true,
    babysitId: 'b1',
    suggestedWhy: 'The brief does not say which API to keep.',
    ...over,
  });

  it('a suggested answer shows why, Send and Cancel, and never a countdown', async () => {
    const onDecide = vi.fn(async () => {});
    const { container } = render(<HeraldActionCard action={suggestion()} {...props} onDecide={onDecide} />);
    expect(screen.getByText('Suggested answer')).toBeTruthy();
    expect(screen.getByText('Out4: option 2, Keep the old API')).toBeTruthy();
    expect(screen.getByText('The brief does not say which API to keep.')).toBeTruthy();
    expect(container.querySelector('.herald-countdown')).toBeNull();
    expect(screen.queryByText(/Sending in/)).toBeNull();
    expect(screen.queryByText('Send now')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(onDecide).toHaveBeenCalledWith('a1', 'confirm');
  });

  it('Cancel on a suggested answer cancels it', async () => {
    const onDecide = vi.fn(async () => {});
    render(<HeraldActionCard action={suggestion()} {...props} onDecide={onDecide} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    expect(onDecide).toHaveBeenCalledWith('a1', 'cancel');
  });

  it('a risky suggestion keeps the hold-to-confirm card and still says why', () => {
    render(<HeraldActionCard action={suggestion({ tier: 'hard_confirm', reasons: ['the option involves: delete'], confirmPhrase: 'confirm delete', voiceAttemptsLeft: 3 })} {...props} />);
    expect(screen.getByText('Suggested answer, needs your confirmation')).toBeTruthy();
    expect(screen.getByText('The brief does not say which API to keep.')).toBeTruthy();
    expect(screen.getByText('Hold to confirm')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('the in-stream marker of a suggestion does not claim it is about to send', () => {
    const { rerender } = render(<HeraldPendingMarker action={suggestion()} />);
    expect(screen.getByText(/Suggested answer, waiting for you/)).toBeTruthy();
    rerender(<HeraldPendingMarker action={suggestion({ suggested: undefined, autoSendAt: 99 })} />);
    expect(screen.getByText(/About to send/)).toBeTruthy();
  });

  it('a babysit_start card asks to start, with the phrase, and resolves as Started', () => {
    const start = card({ kind: 'babysit_start', payload: 'get this production ready', readback: 'Babysit Out4: "get this production ready"', reasons: [], confirmPhrase: 'confirm babysit' });
    const { rerender } = render(<HeraldActionCard action={start} {...props} />);
    expect(screen.getByText('Start babysitting?')).toBeTruthy();
    expect(screen.getByText('Babysit Out4: "get this production ready"')).toBeTruthy();
    expect(screen.getByText('confirm babysit')).toBeTruthy();
    expect(screen.getByText(/never answers permission prompts/)).toBeTruthy();
    expect(screen.getByText('Hold to confirm')).toBeTruthy();
    rerender(<HeraldActionCard action={{ ...start, status: 'sent' }} {...props} />);
    expect(screen.getByText('Started')).toBeTruthy();
    rerender(<HeraldActionCard action={{ ...start, status: 'cancelled' }} {...props} />);
    expect(screen.getByText('Not started')).toBeTruthy();
  });

  it('a suggestion nobody sent reads as expired or dismissed, not as a failed send', () => {
    const { rerender } = render(<HeraldActionCard action={suggestion({ status: 'expired' })} {...props} />);
    expect(screen.getByText('Suggestion expired')).toBeTruthy();
    rerender(<HeraldActionCard action={suggestion({ status: 'cancelled' })} {...props} />);
    expect(screen.getByText('Suggestion dismissed')).toBeTruthy();
    rerender(<HeraldActionCard action={suggestion({ status: 'sent' })} {...props} />);
    expect(screen.getByText('Sent')).toBeTruthy();
  });
});
