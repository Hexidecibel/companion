import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const detail = vi.fn((..._args: unknown[]) => ({ agent: null, highlights: [], loading: false }));
vi.mock('../../hooks/useSubAgentDetail', () => ({ useSubAgentDetail: (...a: unknown[]) => detail(...a) }));
vi.mock('../MessageBubble', () => ({ MessageBubble: () => null }));

import { AgentTile } from '../AgentTile';
import { summaryToSubAgent } from '../../services/subagents';

describe('AgentTile', () => {
  it('shows tracker state without fetching the conversation until expanded', () => {
    const now = Date.now();
    const agent = summaryToSubAgent({
      agentId: 'a1', sessionId: 'c', depth: 1, name: 'Fix tests', status: 'running', startedAt: now - 120_000,
      lastEntryAt: now, toolCalls: 4, edits: 1, filesTouched: 1, tokens: 12_000, version: 3,
      activity: 'Bash: npx jest', pendingTool: 'Bash', pendingSince: now,
      tests: { runs: 2, failed: 1, lastFailed: true, lastAt: now },
      checklist: { done: 1, total: 3, source: 'steps' },
      recent: [{ id: 't1', at: now, kind: 'tool', tool: 'Bash', display: 'npx jest', pending: true }],
    });
    render(<AgentTile serverId="srv" agent={agent} />);
    expect(screen.getByText('running')).toBeTruthy();
    expect(screen.getByText(/Tests: 2 runs, 1 failed/)).toBeTruthy();
    expect(screen.getByText('12k tok')).toBeTruthy();
    expect(detail.mock.calls.every((c) => (c[2] as { enabled: boolean }).enabled === false)).toBe(true);
    fireEvent.click(screen.getByText('Conversation'));
    expect((detail.mock.calls[detail.mock.calls.length - 1][2] as { enabled: boolean }).enabled).toBe(true);
  });
});
