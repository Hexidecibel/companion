import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { THEME_KEY, FLAIR_KEY } from '../services/storageKeys';
import { syncToStore } from '../services/persistentStorage';

export type ThemeId = 'midnight' | 'ocean' | 'forest' | 'warm' | 'rose' | 'graphite';

/** Aurora flair: extra glow, gradient borders and motion on top of the theme. */
export type FlairLevel = 'off' | 'subtle' | 'full';

export interface ThemePreset {
  id: ThemeId;
  name: string;
  description: string;
  accentColor: string;
  secondaryColor: string;
}

export const THEME_PRESETS: ThemePreset[] = [
  { id: 'midnight', name: 'Midnight', description: 'Blue & purple', accentColor: '#3b82f6', secondaryColor: '#8b5cf6' },
  { id: 'ocean', name: 'Ocean', description: 'Teal & cyan', accentColor: '#06b6d4', secondaryColor: '#0ea5e9' },
  { id: 'forest', name: 'Forest', description: 'Green & emerald', accentColor: '#10b981', secondaryColor: '#22c55e' },
  { id: 'warm', name: 'Warm', description: 'Amber & orange', accentColor: '#f59e0b', secondaryColor: '#f97316' },
  { id: 'rose', name: 'Rose', description: 'Pink & magenta', accentColor: '#ec4899', secondaryColor: '#d946ef' },
  { id: 'graphite', name: 'Graphite', description: 'Charcoal & silver', accentColor: '#64748b', secondaryColor: '#cbd5e1' },
];

export const FLAIR_LEVELS: { id: FlairLevel; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'subtle', label: 'Subtle' },
  { id: 'full', label: 'Full' },
];

export const DEFAULT_FLAIR: FlairLevel = 'full';

interface ThemeContextValue {
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
  presets: ThemePreset[];
  flair: FlairLevel;
  setFlair: (level: FlairLevel) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'midnight',
  setTheme: () => {},
  presets: THEME_PRESETS,
  flair: DEFAULT_FLAIR,
  setFlair: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

function applyTheme(id: ThemeId) {
  const root = document.documentElement;
  // Remove all theme classes
  THEME_PRESETS.forEach(p => root.classList.remove(`theme-${p.id}`));
  // Add the selected one (midnight = no class, uses :root defaults)
  if (id !== 'midnight') {
    root.classList.add(`theme-${id}`);
  }
}

/** Sets data-flair on <html>; flair-tokens.css / flair.css key off it. */
export function applyFlair(level: FlairLevel) {
  document.documentElement.dataset.flair = level;
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore (private mode / quota)
  }
  syncToStore(key, value);
}

export function loadFlair(): FlairLevel {
  const saved = readStored(FLAIR_KEY);
  return FLAIR_LEVELS.some(l => l.id === saved) ? (saved as FlairLevel) : DEFAULT_FLAIR;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(() => {
    const saved = readStored(THEME_KEY) as ThemeId | null;
    return saved && THEME_PRESETS.some(p => p.id === saved) ? saved : 'midnight';
  });
  const [flair, setFlairState] = useState<FlairLevel>(loadFlair);

  const setTheme = useCallback((id: ThemeId) => {
    setThemeState(id);
    persist(THEME_KEY, id);
    applyTheme(id);
  }, []);

  const setFlair = useCallback((level: FlairLevel) => {
    setFlairState(level);
    persist(FLAIR_KEY, level);
    applyFlair(level);
  }, []);

  useEffect(() => {
    applyTheme(theme);
    applyFlair(flair);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, presets: THEME_PRESETS, flair, setFlair }}>
      {children}
    </ThemeContext.Provider>
  );
}
