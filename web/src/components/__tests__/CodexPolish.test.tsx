import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AgentPicker, readStoredAgent, writeStoredAgent } from '../AgentPicker';
import { SettingsModal } from '../SettingsModal';

describe('AgentPicker', () => {
  beforeEach(() => localStorage.clear());

  it('shows Claude / Codex and reports the pick', () => {
    const onChange = vi.fn();
    render(<AgentPicker value="claude" onChange={onChange} />);
    expect(screen.getByRole('radio', { name: 'Claude' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Codex' }));
    expect(onChange).toHaveBeenCalledWith('codex');
  });

  it('remembers the agent per server (shared by New Session and New Project)', () => {
    expect(readStoredAgent('s1')).toBe('claude');
    writeStoredAgent('s1', 'codex');
    expect(readStoredAgent('s1')).toBe('codex');
    expect(readStoredAgent('s2')).toBe('claude');
  });
});

describe('SettingsModal bypass row', () => {
  const base = {
    open: true,
    onClose: () => {},
    notifyEnabled: true,
    onToggleNotify: () => {},
    bypassLoading: false,
    hideTools: false,
    onToggleHideTools: () => {},
  };

  it('Codex: read-only, shows the launch state and why', () => {
    const onToggleBypass = vi.fn();
    render(
      <SettingsModal
        {...base}
        bypassEnabled
        onToggleBypass={onToggleBypass}
        bypassReadOnly
        bypassNote="This Codex session was started without approval prompts or sandbox."
      />
    );
    expect(screen.getByText(/started without approval prompts/)).toBeTruthy();
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    const bypass = boxes[1];
    expect(bypass.checked).toBe(true);
    expect(bypass.disabled).toBe(true);
  });

  it('Claude: the usual switch', () => {
    render(<SettingsModal {...base} bypassEnabled={false} onToggleBypass={() => {}} />);
    expect(screen.getByText('Tools run without permission prompts')).toBeTruthy();
    expect((screen.getAllByRole('checkbox')[1] as HTMLInputElement).disabled).toBe(false);
  });
});
