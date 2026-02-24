import { useState, useEffect, useCallback, useMemo, lazy, Suspense } from 'react';
import { ConnectionProvider } from './context/ConnectionContext';
import { ThemeProvider } from './context/ThemeContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { StatusPage } from './components/StatusPage';
import { Dashboard } from './components/Dashboard';
import { CommandPalette, CommandAction } from './components/CommandPalette';

const SettingsScreen = lazy(() => import('./components/SettingsScreen').then(m => ({ default: m.SettingsScreen })));
const UsageDashboard = lazy(() => import('./components/UsageDashboard').then(m => ({ default: m.UsageDashboard })));

type Screen =
  | { name: 'dashboard' }
  | { name: 'status' }
  | { name: 'settings' }
  | { name: 'cost-dashboard'; serverId: string };

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

  // Cmd+Alt+K / Ctrl+Alt+K to open command palette
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.altKey && e.key === 'k') {
        e.preventDefault();
        setShowCommandPalette((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Ensure there's always a base history entry so back gesture doesn't exit the app.
  // Include both 'screen' and 'base' keys so both App and Dashboard popstate handlers
  // recognize this as the floor entry.
  useEffect(() => {
    if (!history.state?.screen) {
      history.replaceState({ screen: 'dashboard', base: true }, '');
    }
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
      // Dashboard has its own popstate handler — don't double-handle
      if (screen.name === 'dashboard') return;

      // If an overlay/modal is open in the current screen, close it first
      if (document.body.dataset.overlay === 'true') {
        window.dispatchEvent(new CustomEvent('close-overlay'));
        // Re-push the current screen's history entry so next back still works
        history.pushState({ screen: screen.name }, '');
        return;
      }
      // No overlay — go back to dashboard
      setScreen({ name: 'dashboard' });
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [screen.name]);

  // Listen for open-cost-dashboard events from child components
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ serverId: string }>).detail;
      if (detail?.serverId) {
        history.pushState({ screen: 'cost-dashboard' }, '');
        setScreen({ name: 'cost-dashboard', serverId: detail.serverId });
      }
    };
    window.addEventListener('open-cost-dashboard', handler);
    return () => window.removeEventListener('open-cost-dashboard', handler);
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
      id: 'new-project',
      label: 'New Project',
      icon: 'P',
      execute: () => {
        navigateTo('dashboard');
        window.dispatchEvent(new CustomEvent('open-new-project'));
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
      <ThemeProvider>
        <ConnectionProvider>
          <div id="app" className={isDashboard ? 'app-dashboard' : ''}>
            {screen.name === 'dashboard' && (
              <Dashboard
                onSettings={() => navigateTo('settings')}
              />
            )}
            {screen.name === 'status' && (
              <StatusPage />
            )}
            {screen.name === 'settings' && (
              <Suspense fallback={<div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: '#9ca3af' }}>Loading...</div>}>
                <SettingsScreen
                  onBack={() => setScreen({ name: 'dashboard' })}
                />
              </Suspense>
            )}
            {screen.name === 'cost-dashboard' && (
              <Suspense fallback={<div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: '#9ca3af' }}>Loading...</div>}>
                <UsageDashboard
                  serverId={screen.serverId}
                  onBack={() => setScreen({ name: 'dashboard' })}
                />
              </Suspense>
            )}

            {showCommandPalette && (
              <CommandPalette
                actions={actions}
                onClose={() => setShowCommandPalette(false)}
              />
            )}
          </div>
        </ConnectionProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
