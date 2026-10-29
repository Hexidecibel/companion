import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ProfileBadge, ProfilePicker, pickProfile, profileButtonLabel } from '../ProfilePicker';
import type { AccountProfileInfo } from '../../types/profiles';

const P: AccountProfileInfo[] = [
  { id: 'claude', label: 'Claude', agent: 'claude', home: '/h/.claude', isDefault: true, loginState: 'logged_in' },
  { id: 'codex', label: 'Codex', agent: 'codex', home: '/h/.codex', isDefault: true, loginState: 'logged_in' },
  { id: 'work', label: 'Work', agent: 'claude', home: '/h/.claude-work', isDefault: false, loginState: 'logged_out' },
];

describe('pickProfile', () => {
  it('stored profile if it exists, else the default of the agent', () => {
    expect(pickProfile(P, 'work', 'codex')?.id).toBe('work');
    expect(pickProfile(P, 'gone', 'codex')?.id).toBe('codex');
    expect(pickProfile(P, null, 'claude')?.id).toBe('claude');
  });
  it('labels', () => {
    expect(P.map(profileButtonLabel)).toEqual(['Claude', 'Codex', 'Work']);
  });
});

describe('ProfilePicker', () => {
  it('lists every profile, marks the active one and reports the pick', () => {
    const onChange = vi.fn();
    render(<ProfilePicker profiles={P} value="claude" onChange={onChange} />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
    expect(screen.getByLabelText('not logged in')).toBeTruthy();
    fireEvent.click(radios[2]);
    expect(onChange).toHaveBeenCalledWith(P[2]);
  });
  it('badge renders only with a label', () => {
    const { container, rerender } = render(<ProfileBadge label={undefined} />);
    expect(container.textContent).toBe('');
    rerender(<ProfileBadge label="Work" />);
    expect(container.textContent).toBe('Work');
  });
});
