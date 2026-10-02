import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('../../hooks/useFileExistence', () => ({ useFileExistence: () => new Set<string>() }));

import { MessageBubble } from '../MessageBubble';
import type { ConversationHighlight } from '../../types';

describe('local command marker', () => {
  it('renders a directly-run slash command as a quiet marker, not a bubble', () => {
    const message: ConversationHighlight = {
      id: 'cmd',
      type: 'system',
      content: 'Ran /login · Login successful',
      timestamp: 1,
      localCommand: { name: '/login', output: 'Login successful' },
    };
    const { container } = render(<MessageBubble message={message} />);
    const marker = container.querySelector('.local-command-marker');
    expect(marker).not.toBeNull();
    expect(marker!.textContent).toContain('Ran /login');
    expect(marker!.textContent).toContain('Login successful');
    expect(container.querySelector('.msg-bubble')).toBeNull();
    expect(container.querySelector('.system-notification')).toBeNull();
    expect(container.textContent).not.toMatch(/<\/?(local-command|command-)/);
  });

  it('flags an error output', () => {
    const message: ConversationHighlight = {
      id: 'cmd2',
      type: 'system',
      content: 'Ran /foo · Unknown command',
      timestamp: 1,
      localCommand: { name: '/foo', output: 'Unknown command', isError: true },
    };
    const { container } = render(<MessageBubble message={message} />);
    expect(container.querySelector('.local-command-marker-error')).not.toBeNull();
  });
});
