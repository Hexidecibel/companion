import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { WaitingIndicator } from '../WaitingIndicator';
import type { ConversationHighlight, SessionStatus } from '../../types';

vi.mock('../../services/ConnectionManager', () => ({ connectionManager: { getConnection: () => null } }));

const status: SessionStatus = { isRunning: true, isWaitingForInput: false, lastActivity: 0, currentActivity: 'x' };
const T0 = 1_000_000_000_000;
const highlights: ConversationHighlight[] = [
  { id: 'u', type: 'user', content: 'go', timestamp: T0 },
  { id: 'a', type: 'assistant', content: '', timestamp: T0 + 1000, toolCalls: [
    { id: 't1', name: 'Read', input: { file_path: '/a.ts' }, status: 'completed' },
    { id: 't2', name: 'Bash', input: { command: 'npm test' }, status: 'running' },
  ] },
];

describe('WaitingIndicator', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0 + 10_000); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('shows one line, ticks, and opens the steps only when tapped', () => {
    render(<WaitingIndicator status={status} highlights={highlights} sessionId="s" />);
    expect(screen.getByText('Running tests')).toBeTruthy();
    expect(screen.getByText('10s · 2 tools')).toBeTruthy();
    expect(screen.queryByText('Reading a.ts')).toBeNull();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText('13s · 2 tools')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('Reading a.ts')).toBeTruthy();
  });

  it('holds a fast tool change until the next tick', () => {
    const { rerender } = render(<WaitingIndicator status={status} highlights={highlights} sessionId="s" />);
    const next: ConversationHighlight[] = [...highlights, { id: 'b', type: 'assistant', content: '', timestamp: T0 + 2000, toolCalls: [
      { id: 't3', name: 'Edit', input: { file_path: '/b.ts' }, status: 'running' },
    ] }];
    rerender(<WaitingIndicator status={status} highlights={next} sessionId="s" />);
    expect(screen.getByText('Running tests')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText('Editing b.ts')).toBeTruthy();
  });

  it('cancel works and does not toggle the steps', () => {
    const onCancel = vi.fn();
    render(<WaitingIndicator status={status} highlights={highlights} sessionId="s" canCancel onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(screen.queryByText('Reading a.ts')).toBeNull();
  });

  it('feedback prompts still take priority', () => {
    render(<WaitingIndicator
      status={{ ...status, feedbackPrompt: { question: 'How was it?', options: [{ key: '1', label: 'Bad' }] } }}
      highlights={highlights} sessionId="s" />);
    expect(screen.getByText('How was it?')).toBeTruthy();
    expect(screen.queryByText('Running tests')).toBeNull();
  });

  it('no Cancel on a finished turn', () => {
    render(<WaitingIndicator status={{ ...status, isWaitingForInput: true, currentActivity: undefined }}
      highlights={[highlights[0], { id: 'z', type: 'assistant', content: 'ok', timestamp: T0 + 60_000 }]} sessionId="s" canCancel onCancel={() => {}} />);
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.getByText('1m')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});
