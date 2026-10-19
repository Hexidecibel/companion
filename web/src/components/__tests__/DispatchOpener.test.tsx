import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let mobile = false;
vi.mock('../../utils/platform', async (orig) => ({
  ...(await orig<typeof import('../../utils/platform')>()),
  isMobileViewport: () => mobile,
}));
vi.mock('../../hooks/useSubAgentDetail', () => ({ useSubAgentDetail: () => ({ agent: null, highlights: [], loading: false }) }));
vi.mock('../MessageBubble', () => ({ MessageBubble: () => null }));

import { DispatchOpener } from '../DispatchOpener';
import { DispatchPanel } from '../DispatchPanel';

afterEach(() => { mobile = false; });

describe('DispatchOpener (desktop header chip)', () => {
  it('shows running and done counts with an animated dot, and toggles', () => {
    const onToggle = vi.fn();
    const { container } = render(<DispatchOpener runningCount={2} totalAgents={5} open={false} onToggle={onToggle} />);
    expect(screen.getByText('2 running / 3 done')).toBeTruthy();
    expect(container.querySelector('.dispatch-dot-running')).toBeTruthy();
    fireEvent.click(screen.getByTestId('dispatch-opener'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('stays visible when every agent is done, without the running animation', () => {
    const { container } = render(<DispatchOpener runningCount={0} totalAgents={3} open={false} onToggle={() => {}} />);
    expect(screen.getByText('3 agents')).toBeTruthy();
    expect(container.querySelector('.dispatch-dot-running')).toBeNull();
    expect(container.querySelector('.dispatch-dot-done')).toBeTruthy();
  });

  it('is hidden with no agents', () => {
    const { container } = render(<DispatchOpener runningCount={0} totalAgents={0} open={false} onToggle={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('is never rendered on mobile viewports', () => {
    mobile = true;
    const { container } = render(<DispatchOpener runningCount={1} totalAgents={2} open={false} onToggle={() => {}} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('DispatchPanel collapsed', () => {
  const base = { serverId: 's', agents: [], height: 200, collapsed: true };

  it('renders nothing on desktop (the header chip opens it)', () => {
    const { container } = render(<DispatchPanel {...base} runningCount={1} totalAgents={2} onCollapse={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('mobile: shows the running bar while agents run', () => {
    mobile = true;
    render(<DispatchPanel {...base} runningCount={1} totalAgents={2} onCollapse={() => {}} />);
    expect(screen.getByText('1 agent running')).toBeTruthy();
  });

  it('mobile: shows a quiet done bar when all agents finished, which opens and can be closed', () => {
    mobile = true;
    const onCollapse = vi.fn();
    const onDismiss = vi.fn();
    const { container } = render(
      <DispatchPanel {...base} runningCount={0} totalAgents={3} onCollapse={onCollapse} onDismissDoneBar={onDismiss} />,
    );
    expect(screen.getByText('3 agents done')).toBeTruthy();
    expect(container.querySelector('.dispatch-mobile-bar-done')).toBeTruthy();
    fireEvent.click(screen.getByText('3 agents done'));
    expect(onCollapse).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('Hide finished agents bar'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it('mobile: the done bar stays hidden once dismissed', () => {
    mobile = true;
    const { container } = render(
      <DispatchPanel {...base} runningCount={0} totalAgents={3} onCollapse={() => {}} doneBarDismissed />,
    );
    expect(container.innerHTML).toBe('');
  });
});
