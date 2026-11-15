import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

vi.mock('../../services/persistentStorage', () => ({
  syncToStore: vi.fn(),
}));

import { syncToStore } from '../../services/persistentStorage';
import {
  ThemeProvider,
  useTheme,
  THEME_PRESETS,
  DEFAULT_FLAIR,
  loadFlair,
  type FlairLevel,
  type ThemeId,
} from '../ThemeContext';

let api: ReturnType<typeof useTheme>;

function Probe() {
  api = useTheme();
  return (
    <div>
      <span data-testid="theme">{api.theme}</span>
      <span data-testid="flair">{api.flair}</span>
    </div>
  );
}

function mount() {
  return render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
}

const root = () => document.documentElement;

describe('ThemeContext flair', () => {
  beforeEach(() => {
    localStorage.clear();
    root().className = '';
    delete root().dataset.flair;
    vi.mocked(syncToStore).mockClear();
  });

  it('defaults to Full and applies data-flair on mount', () => {
    mount();
    expect(DEFAULT_FLAIR).toBe('full');
    expect(screen.getByTestId('flair').textContent).toBe('full');
    expect(root().dataset.flair).toBe('full');
  });

  it('restores a stored level', () => {
    localStorage.setItem('companion_flair', 'subtle');
    mount();
    expect(screen.getByTestId('flair').textContent).toBe('subtle');
    expect(root().dataset.flair).toBe('subtle');
  });

  it('falls back to Full for an unknown stored value', () => {
    localStorage.setItem('companion_flair', 'sparkly');
    expect(loadFlair()).toBe('full');
    mount();
    expect(root().dataset.flair).toBe('full');
  });

  it.each<FlairLevel>(['off', 'subtle', 'full'])('setFlair(%s) updates state, root and storage', (level) => {
    mount();
    act(() => api.setFlair(level));
    expect(screen.getByTestId('flair').textContent).toBe(level);
    expect(root().dataset.flair).toBe(level);
    expect(localStorage.getItem('companion_flair')).toBe(level);
    expect(syncToStore).toHaveBeenCalledWith('companion_flair', level);
  });
});

describe('ThemeContext themes', () => {
  beforeEach(() => {
    localStorage.clear();
    root().className = '';
    vi.mocked(syncToStore).mockClear();
  });

  it('includes the Graphite preset', () => {
    const graphite = THEME_PRESETS.find(p => p.id === 'graphite');
    expect(graphite).toMatchObject({ name: 'Graphite', accentColor: '#64748b' });
    expect(THEME_PRESETS).toHaveLength(6);
  });

  it('setTheme switches the root class and persists', () => {
    mount();
    act(() => api.setTheme('graphite' as ThemeId));
    expect(root().classList.contains('theme-graphite')).toBe(true);
    expect(localStorage.getItem('companion_theme')).toBe('graphite');
    expect(syncToStore).toHaveBeenCalledWith('companion_theme', 'graphite');

    act(() => api.setTheme('midnight'));
    expect(root().classList.contains('theme-graphite')).toBe(false);
    expect(localStorage.getItem('companion_theme')).toBe('midnight');
  });

  it('restores a stored theme and ignores unknown ids', () => {
    localStorage.setItem('companion_theme', 'graphite');
    const { unmount } = mount();
    expect(root().classList.contains('theme-graphite')).toBe(true);
    unmount();

    root().className = '';
    localStorage.setItem('companion_theme', 'neon');
    mount();
    expect(screen.getAllByTestId('theme').slice(-1)[0]?.textContent).toBe('midnight');
  });
});
