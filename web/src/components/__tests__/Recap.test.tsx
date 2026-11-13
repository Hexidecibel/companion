import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('../../hooks/useFileExistence', () => ({ useFileExistence: () => new Set<string>() }));

import { MessageBubble } from '../MessageBubble';
import { SessionRecap } from '../SessionRecap';
import type { ConversationHighlight } from '../../types';

describe('recap rendering', () => {
  it('renders a recap highlight as a muted Recap card, not a bubble', () => {
    const message: ConversationHighlight = {
      id: 'recap-1',
      type: 'system',
      content: 'Companion is back up.',
      timestamp: Date.now(),
      isRecap: true,
    };
    const { container } = render(<MessageBubble message={message} />);
    const card = container.querySelector('.recap-card');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('Recap');
    expect(card!.textContent).toContain('Companion is back up.');
    expect(container.querySelector('.msg-bubble')).toBeNull();
    expect(container.querySelector('.system-notification')).toBeNull();
  });

  it('shows the session subtitle only when a recap exists', () => {
    const { container, rerender } = render(<SessionRecap recap={undefined} />);
    expect(container.querySelector('.session-recap')).toBeNull();
    rerender(<SessionRecap recap={{ text: 'Did the thing.', timestamp: new Date().toISOString() }} />);
    expect(container.querySelector('.session-recap')!.textContent).toBe('Did the thing.');
  });
});
