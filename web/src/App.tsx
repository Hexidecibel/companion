import { useState, useEffect, useCallback, useMemo } from 'react';
import { ConnectionProvider } from './context/ConnectionContext';
import { StatusPage } from './components/StatusPage';
import { ServerList } from './components/ServerList';
import { ServerForm } from './components/ServerForm';
import { Dashboard } from './components/Dashboard';
import { CommandPalette, CommandAction } from './components/CommandPalette';

type Screen =
  | { name: 'dashboard' }
  | { name: 'status' }
  | { name: 'servers' }
  | { name: 'editServer'; serverId?: string };

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'dashboard' });
  const [showCommandPalette, setShowCommandPalette] = useState(false);

  const isDashboard = screen.name === 'dashboard';

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

  const navigateTo = useCallback((name: Screen['name']) => {
    setScreen({ name } as Screen);
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
      id: 'go-servers',
      label: 'Go to Servers',
      icon: '\u2699',
      execute: () => navigateTo('servers'),
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
    <ConnectionProvider>
      <div id="app" className={isDashboard ? 'app-dashboard' : ''}>
        {screen.name === 'dashboard' && (
          <Dashboard
            onManageServers={() => setScreen({ name: 'servers' })}
          />
        )}
        {screen.name === 'status' && (
          <StatusPage
            onManageServers={() => setScreen({ name: 'servers' })}
          />
        )}
        {screen.name === 'servers' && (
          <ServerList
            onBack={() => setScreen({ name: 'dashboard' })}
            onAddServer={() => setScreen({ name: 'editServer' })}
            onEditServer={(id) => setScreen({ name: 'editServer', serverId: id })}
          />
        )}
        {screen.name === 'editServer' && (
          <ServerForm
            serverId={screen.serverId}
            onBack={() => setScreen({ name: 'servers' })}
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
  );
}
