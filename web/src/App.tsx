import { useState } from 'react';
import { ConnectionProvider } from './context/ConnectionContext';
import { StatusPage } from './components/StatusPage';
import { ServerList } from './components/ServerList';
import { ServerForm } from './components/ServerForm';
import { Dashboard } from './components/Dashboard';

type Screen =
  | { name: 'dashboard' }
  | { name: 'status' }
  | { name: 'servers' }
  | { name: 'editServer'; serverId?: string };

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'dashboard' });

  const isDashboard = screen.name === 'dashboard';

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
      </div>
    </ConnectionProvider>
  );
}
