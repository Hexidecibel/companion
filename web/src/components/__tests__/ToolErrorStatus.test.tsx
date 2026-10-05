import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('../../hooks/useFileExistence', () => ({ useFileExistence: () => new Set<string>() }));

import { MessageBubble } from '../MessageBubble';
import { ToolCard } from '../ToolCard';
import type { ConversationHighlight, ToolCall } from '../../types';

const tool = (over: Partial<ToolCall>): ToolCall => ({
  id: 't1',
  name: 'Bash',
  input: { command: 'npm test' },
  output: 'Exit code 1\nFAIL a.test.ts',
  status: 'error',
  isError: true,
  ...over,
});

describe("tool calls with status 'error'", () => {
  it('ToolCard labels a failed tool "Error"', () => {
    const { container } = render(<ToolCard tool={tool({})} />);
    const badge = container.querySelector('.tool-card-status');
    expect(badge?.textContent).toBe('Error');
    expect(badge?.className).toContain('tool-status-error');
  });

  it('a rejected ExitPlanMode reads "Not approved", not "Pending", and offers no approve buttons', () => {
    const message: ConversationHighlight = {
      id: 'm1',
      type: 'assistant',
      content: '',
      timestamp: 1,
      toolCalls: [tool({ id: 'p1', name: 'ExitPlanMode', input: { plan: 'do it' }, output: "The user doesn't want to proceed" })],
    };
    const { container } = render(<MessageBubble message={message} onSelectOption={() => {}} />);
    const badge = container.querySelector('.plan-card .tool-card-status');
    expect(badge?.textContent).toBe('Not approved');
    expect(badge?.className).toContain('tool-status-error');
    expect(container.querySelector('.plan-card-actions')).toBeNull();
  });
});
