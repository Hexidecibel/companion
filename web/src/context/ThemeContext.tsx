import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';

export type ThemeId = 'midnight' | 'ocean' | 'forest' | 'warm' | 'rose';

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
];

const THEME_STORAGE_KEY = 'companion_theme';

interface ThemeContextValue {
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
  presets: ThemePreset[];
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'midnight',
  setTheme: () => {},
  presets: THEME_PRESETS,
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

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY) as ThemeId | null;
    return saved && THEME_PRESETS.some(p => p.id === saved) ? saved : 'midnight';
  });

  const setTheme = useCallback((id: ThemeId) => {
    setThemeState(id);
    localStorage.setItem(THEME_STORAGE_KEY, id);
    applyTheme(id);
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, presets: THEME_PRESETS }}>
      {children}
    </ThemeContext.Provider>
  );
}
