import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HeraldActionCard } from '../HeraldActionCard';
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
