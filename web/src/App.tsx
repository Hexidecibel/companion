import { useState, useEffect, useCallback, useMemo } from 'react';
import { ConnectionProvider } from './context/ConnectionContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { StatusPage } from './components/StatusPage';
import { Dashboard } from './components/Dashboard';
import { SettingsScreen } from './components/SettingsScreen';
import { CommandPalette, CommandAction } from './components/CommandPalette';

type Screen =
  | { name: 'dashboard' }
  | { name: 'status' }
  | { name: 'settings' };

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'dashboard' });
  const [showCommandPalette, setShowCommandPalette] = useState(false);

  const isDashboard = screen.name === 'dashboard';

  // Prevent browser default file-drop behavior (navigating to the file)
  // so that only the InputBar drop zone handles file drops
  useEffect(() => {
    const preventDrop = (e: DragEvent) => { e.preventDefault(); };
    document.addEventListener('dragover', preventDrop);
    document.addEventListener('drop', preventDrop);
    return () => {
      document.removeEventListener('dragover', preventDrop);
      document.removeEventListener('drop', preventDrop);
    };
  }, []);

  // Cmd+K / Ctrl+K to open command palette
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setShowCommandPalette((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Navigate with history.pushState for Android back gesture support
  const navigateTo = useCallback((name: Screen['name']) => {
    if (name !== 'dashboard') {
      history.pushState({ screen: name }, '');
    }
    setScreen({ name } as Screen);
  }, []);

  // Handle browser back (Android back gesture triggers popstate via WebView goBack)
  useEffect(() => {
    const handler = (_e: PopStateEvent) => {
      // Always go back to dashboard on popstate at this level
      setScreen({ name: 'dashboard' });
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  const focusInput = useCallback(() => {
    const textarea = document.querySelector('.input-bar-textarea') as HTMLTextAreaElement | null;
    textarea?.focus();
  }, []);

  const actions: CommandAction[] = useMemo(() => [
    {
      id: 'go-dashboard',
      label: 'Go to Dashboard',
      icon: '\u2302',
      execute: () => navigateTo('dashboard'),
    },
    {
      id: 'add-server',
      label: 'Add Server',
      icon: '+',
      execute: () => {
        navigateTo('dashboard');
        window.dispatchEvent(new CustomEvent('open-add-server'));
      },
    },
    {
      id: 'go-settings',
      label: 'Go to Settings',
      icon: '\u2731',
      execute: () => navigateTo('settings'),
    },
    {
      id: 'notifications',
      label: 'Notification Settings',
      icon: '\u{1F514}',
      execute: () => {
        navigateTo('dashboard');
        window.dispatchEvent(new CustomEvent('open-notification-settings'));
      },
    },
    {
      id: 'focus-input',
      label: 'Focus Input',
      icon: '/',
      shortcut: '/',
      execute: focusInput,
    },
  ], [navigateTo, focusInput]);

  return (
    <ErrorBoundary>
      <ConnectionProvider>
        <div id="app" className={isDashboard ? 'app-dashboard' : ''}>
          {screen.name === 'dashboard' && (
            <Dashboard
              onSettings={() => setScreen({ name: 'settings' })}
            />
          )}
          {screen.name === 'status' && (
            <StatusPage />
          )}
          {screen.name === 'settings' && (
            <SettingsScreen
              onBack={() => setScreen({ name: 'dashboard' })}
            />
          )}

          {showCommandPalette && (
            <CommandPalette
              actions={actions}
              onClose={() => setShowCommandPalette(false)}
            />
          )}
        </div>
      </ConnectionProvider>
    </ErrorBoundary>
  );
}
