import { useState, useEffect } from 'react';
import { useConnections } from '../hooks/useConnections';
import { connectionManager } from '../services/ConnectionManager';
import { getFontScale, saveFontScale } from '../services/storage';
import { clearAllArchives } from '../services/archiveService';
import { NotificationSettingsModal } from './NotificationSettingsModal';

const isTauri = () => !!(window as any).__TAURI_INTERNALS__;

interface SettingsScreenProps {
  onBack: () => void;
}

const FONT_PRESETS = [
  { label: 'S', value: 0.85 },
  { label: 'M', value: 1.0 },
  { label: 'L', value: 1.15 },
  { label: 'XL', value: 1.3 },
] as const;

export function SettingsScreen({ onBack }: SettingsScreenProps) {
  const { snapshots } = useConnections();
  const [fontScale, setFontScale] = useState(getFontScale);
  const [notifServerId, setNotifServerId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);
  const [rotatingServer, setRotatingServer] = useState<string | null>(null);
  const [rotateResult, setRotateResult] = useState<{ serverId: string; token?: string; error?: string } | null>(null);
  const [autostart, setAutostart] = useState<boolean | null>(null);

  // Load autostart state in Tauri
  useEffect(() => {
    if (!isTauri()) return;
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const enabled = await invoke<boolean>('get_autostart_enabled');
        setAutostart(enabled);
      } catch {
        // Not available
      }
    })();
  }, []);

  const handleToggleAutostart = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const newValue = !autostart;
      await invoke('set_autostart_enabled', { enabled: newValue });
      setAutostart(newValue);
    } catch {
      // Failed
    }
  };

  const handleFontScale = (value: number) => {
    saveFontScale(value);
    setFontScale(value);
  };

  const handleClearHistory = () => {
    if (!confirmClearHistory) {
      setConfirmClearHistory(true);
      return;
    }
    clearAllArchives();
    setConfirmClearHistory(false);
  };

  const handleClearData = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    localStorage.clear();
    window.location.reload();
  };

  const handleRotateToken = async (serverId: string) => {
    setRotatingServer(serverId);
    setRotateResult(null);
    try {
      const conn = connectionManager.getConnection(serverId);
      if (!conn) {
        setRotateResult({ serverId, error: 'Not connected' });
        return;
      }
      const response = await conn.sendRequest('rotate_token');
      if (response.success && response.payload) {
        const { newToken } = response.payload as { newToken: string };
        setRotateResult({ serverId, token: newToken });
      } else {
        setRotateResult({ serverId, error: response.error || 'Failed to rotate token' });
      }
    } catch {
      setRotateResult({ serverId, error: 'Request failed' });
    } finally {
      setRotatingServer(null);
    }
  };

  const connectedServers = snapshots.filter((s) => s.state.status === 'connected');

  return (
    <div className="screen">
      <header className="form-header">
        <button className="icon-btn" onClick={onBack}>
          &larr;
        </button>
        <h2>Settings</h2>
        <div className="header-spacer" />
      </header>

      <div className="settings-body">
        {/* Display */}
        <section className="settings-section">
          <h3 className="settings-section-title">Display</h3>
          <div className="settings-card">
            <div className="settings-card-label">Text Size</div>
            <div className="settings-font-btns">
              {FONT_PRESETS.map((p) => (
                <button
                  key={p.label}
                  className={`settings-font-btn ${fontScale === p.value ? 'active' : ''}`}
                  onClick={() => handleFontScale(p.value)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div
              className="settings-font-preview"
              style={{ fontSize: `calc(14px * ${fontScale})` }}
            >
              The quick brown fox jumps over the lazy dog.
            </div>
          </div>
        </section>

        {/* Desktop (Tauri only) */}
        {isTauri() && autostart !== null && (
          <section className="settings-section">
            <h3 className="settings-section-title">Desktop</h3>
            <div className="settings-card settings-card-row">
              <div className="settings-card-row-info">
                <span className="settings-card-label">Launch at Login</span>
              </div>
              <button
                className={`settings-toggle-btn ${autostart ? 'active' : ''}`}
                onClick={handleToggleAutostart}
              >
                {autostart ? 'On' : 'Off'}
              </button>
            </div>
          </section>
        )}

        {/* Notifications */}
        <section className="settings-section">
          <h3 className="settings-section-title">Notifications</h3>
          {connectedServers.length === 0 ? (
            <div className="settings-card">
              <div className="settings-card-detail">
                No connected servers. Connect to a server to configure notifications.
              </div>
            </div>
          ) : (
            connectedServers.map((snap) => (
              <div key={snap.serverId} className="settings-card settings-card-row">
                <div className="settings-card-row-info">
                  <span className="status-dot status-dot-green" />
                  <span className="settings-card-label">{snap.serverName}</span>
                </div>
                <button
                  className="settings-action-btn"
                  onClick={() => setNotifServerId(snap.serverId)}
                >
                  Configure
                </button>
              </div>
            ))
          )}
        </section>

        {/* Security */}
        <section className="settings-section">
          <h3 className="settings-section-title">Security</h3>
          {connectedServers.length === 0 ? (
            <div className="settings-card">
              <div className="settings-card-detail">
                No connected servers. Connect to a server to manage tokens.
              </div>
            </div>
          ) : (
            connectedServers.map((snap) => (
              <div key={snap.serverId} className="settings-card">
                <div className="settings-card-row">
                  <div className="settings-card-row-info">
                    <span className="status-dot status-dot-green" />
                    <span className="settings-card-label">{snap.serverName}</span>
                  </div>
                  <button
                    className="settings-action-btn settings-action-btn-danger"
                    onClick={() => handleRotateToken(snap.serverId)}
                    disabled={rotatingServer === snap.serverId}
                  >
                    {rotatingServer === snap.serverId ? 'Rotating...' : 'Rotate Token'}
                  </button>
                </div>
                {rotateResult && rotateResult.serverId === snap.serverId && (
                  <div className={`settings-rotate-result ${rotateResult.error ? 'error' : 'success'}`}>
                    {rotateResult.error
                      ? rotateResult.error
                      : `New token: ${rotateResult.token}`}
                  </div>
                )}
              </div>
            ))
          )}
        </section>

        {/* Data */}
        <section className="settings-section">
          <h3 className="settings-section-title">Data</h3>
          <div className="settings-card">
            <button
              className={`settings-action-btn ${confirmClearHistory ? 'settings-action-btn-danger' : ''}`}
              onClick={handleClearHistory}
              style={{ width: '100%', padding: '10px 14px', fontSize: 14 }}
            >
              {confirmClearHistory ? 'Confirm: Clear History' : 'Clear History'}
            </button>
            {confirmClearHistory && (
              <div className="settings-card-detail" style={{ marginTop: 8 }}>
                This will delete all saved conversation archives.{' '}
                <button className="settings-cancel-link" onClick={() => setConfirmClearHistory(false)}>
                  Cancel
                </button>
              </div>
            )}
          </div>
          <div className="settings-card">
            <button
              className={`settings-danger-btn ${confirmClear ? 'confirming' : ''}`}
              onClick={handleClearData}
            >
              {confirmClear ? 'Confirm: Clear All Data' : 'Clear All Data'}
            </button>
            {confirmClear && (
              <div className="settings-card-detail" style={{ marginTop: 8 }}>
                This will delete all saved servers and settings, then reload the page.{' '}
                <button className="settings-cancel-link" onClick={() => setConfirmClear(false)}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        </section>

        {/* About */}
        <section className="settings-section">
          <h3 className="settings-section-title">About</h3>
          <div className="settings-card">
            <div className="settings-card-label">Companion Web v{__APP_VERSION__}</div>
            <div className="settings-card-detail">
              A companion app for AI coding sessions that lets you monitor sessions
              and respond from your browser.
            </div>
            <div className="settings-card-detail" style={{ marginTop: 6, fontSize: 11 }}>
              Built {new Date(__BUILD_TIME__).toLocaleString()}
            </div>
          </div>
        </section>
      </div>

      {notifServerId && (
        <NotificationSettingsModal
          serverId={notifServerId}
          onClose={() => setNotifServerId(null)}
        />
      )}
    </div>
  );
}
