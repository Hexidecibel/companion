import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SubagentSummary } from '../../types/subagents';
import { buildAgentsOverview, type AgentsOverview } from '../../services/agentsOverview';

let live: AgentsOverview;
vi.mock('../../hooks/useAgentsOverview', () => ({
  useAgentsOverview: () => ({ overview: live, servers: [], loaded: true }),
}));
vi.mock('../../hooks/useSubAgentDetail', () => ({ useSubAgentDetail: () => ({ agent: null, highlights: [], loading: false }) }));
vi.mock('../MessageBubble', () => ({ MessageBubble: () => null }));
vi.mock('../../services/ConnectionManager', () => ({ connectionManager: { getConnection: () => undefined, getSnapshots: () => [], onChange: () => () => undefined } }));

import { AgentsPage } from '../agents/AgentsPage';
import { AgentsNavButton } from '../agents/AgentsNavButton';

const MIN = 60_000;
const NOW = Date.now();
const ag = (p: Partial<SubagentSummary> & { agentId: string }): SubagentSummary => ({
  sessionId: 'conv-a', depth: 1, name: p.agentId, status: 'running', startedAt: NOW - 12 * MIN, lastEntryAt: NOW - MIN,
  toolCalls: 1, edits: 0, filesTouched: 0, tokens: 0, recent: [], version: 1, ...p,
});
const labels = {
  'conv-a': { session: 'companion', sessionId: 'companion' },
  'conv-b': { session: 'out4', sessionId: 'out4' },
  'conv-c': { session: 'dox', sessionId: 'dox' },
};

function model(agents: SubagentSummary[]) {
  return buildAgentsOverview([{ serverId: 's1', serverName: 'hexi', agents, labels }], NOW);
}

describe('AgentsPage', () => {
  it('renders the approved layout: headline, attention, cards, folds, finished line', () => {
    live = model([
      ag({ agentId: 'p', name: 'perf-batch', pendingTool: 'Edit', activity: 'src/watcher.ts' }),
      ag({ agentId: 'c', name: 'tests', parentAgentId: 'p', startedAt: NOW - 3 * MIN }),
      ...['d1', 'd2', 'd3'].map((id) => ag({ agentId: id, status: 'done', endedAt: NOW - 5 * MIN })),
      ag({ agentId: 'st', sessionId: 'conv-b', name: 'test-runner', stuck: { kind: 'repeated_failure', severity: 'high', headline: 'same test failing 4x', summary: '', since: NOW - 6 * MIN } }),
      ag({ agentId: 'x1', sessionId: 'conv-c', status: 'done', endedAt: NOW - 20 * MIN }),
      ag({ agentId: 'x2', sessionId: 'conv-c', status: 'done', endedAt: NOW - 25 * MIN }),
    ]);
    const onOpen = vi.fn();
    render(<AgentsPage onOpenSession={onOpen} />);
    expect(screen.getByText('3 running · 1 stuck')).toBeTruthy();
    const attention = screen.getByLabelText('Needs attention');
    expect(within(attention).getByText('out4 › test-runner')).toBeTruthy();
    expect(within(attention).getByText('STUCK 6m')).toBeTruthy();
    fireEvent.click(within(attention).getByText('Open'));
    expect(onOpen).toHaveBeenCalledWith('s1', 'out4');

    const cards = screen.getAllByTestId('agents-card');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText('out4')).toBeTruthy(); // attention first
    const comp = cards[1];
    expect(within(comp).getByText('3/5 done')).toBeTruthy();
    expect(within(comp).getByText('editing watcher.ts')).toBeTruthy();
    expect(within(comp).queryByText('d1')).toBeNull(); // folded
    fireEvent.click(within(comp).getByText('✓ 3 done'));
    expect(within(comp).getByText('d1')).toBeTruthy();
    fireEvent.click(within(comp).getByText('companion'));
    expect(onOpen).toHaveBeenLastCalledWith('s1', 'companion');

    const fin = screen.getByText(/Finished in last 2h: dox \(2\)/);
    expect(screen.getAllByTestId('agents-card')).toHaveLength(2);
    fireEvent.click(fin);
    expect(screen.getAllByTestId('agents-card')).toHaveLength(3);
  });

  it('agent row opens the detail, back returns', () => {
    live = model([ag({ agentId: 'p', name: 'perf-batch' })]);
    render(<AgentsPage onOpenSession={() => undefined} />);
    fireEvent.click(screen.getByText('perf-batch'));
    expect(screen.getByText('in companion')).toBeTruthy();
    expect(screen.getByText('Transcript')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Back to agents'));
    expect(screen.getByText('Agents')).toBeTruthy();
  });

  it('empty states', () => {
    live = model([]);
    const { unmount } = render(<AgentsPage onOpenSession={() => undefined} />);
    expect(screen.getByText('No agents in the last 2 hours.')).toBeTruthy();
    unmount();
    live = model([ag({ agentId: 'd', sessionId: 'conv-c', status: 'done', endedAt: NOW - 14 * MIN })]);
    render(<AgentsPage onOpenSession={() => undefined} />);
    expect(screen.getByText('Nothing running. Last batch finished 14 min ago in dox.')).toBeTruthy();
  });

  it('+N more behind a fold', () => {
    live = model(Array.from({ length: 7 }, (_, i) => ag({ agentId: `a${i}`, lastEntryAt: NOW - i * 1000 })));
    render(<AgentsPage onOpenSession={() => undefined} />);
    expect(screen.queryByText('a6')).toBeNull();
    fireEvent.click(screen.getByText('+2 more running'));
    expect(screen.getByText('a6')).toBeTruthy();
  });
});

describe('AgentsNavButton', () => {
  it('hides the badge at zero, shows count, red on stuck/failed', () => {
    live = model([]);
    const { unmount } = render(<AgentsNavButton onClick={() => undefined} />);
    expect(screen.queryByTestId('agents-badge')).toBeNull();
    unmount();
    live = model([ag({ agentId: 'a' }), ag({ agentId: 'b' })]);
    const r2 = render(<AgentsNavButton onClick={() => undefined} />);
    expect(screen.getByTestId('agents-badge').textContent).toBe('2');
    expect(screen.getByTestId('agents-badge').className).not.toMatch(/alert/);
    r2.unmount();
    live = model([ag({ agentId: 'a' }), ag({ agentId: 'f', status: 'failed', endedAt: NOW })]);
    render(<AgentsNavButton onClick={() => undefined} />);
    expect(screen.getByTestId('agents-badge').className).toMatch(/alert/);
  });
});
