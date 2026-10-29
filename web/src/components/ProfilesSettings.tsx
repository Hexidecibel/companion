import { useState } from 'react';
import { useProfiles } from '../hooks/useProfiles';
import type { AccountProfileInfo, ProfileLoginState } from '../types/profiles';

const STATE_TEXT: Record<ProfileLoginState, string> = {
  logged_in: 'Logged in',
  api_key: 'API key',
  logged_out: 'Not logged in',
};

/**
 * Settings > Accounts for one server: every account profile with its login
 * state and a Log in button (opens a `login-<id>` session running the
 * agent's login in that profile's environment).
 */
export function ProfilesCard({ serverId, serverName }: { serverId: string; serverName: string }) {
  const { profiles, supported, error, login, refresh } = useProfiles(serverId);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; text: string; error?: boolean } | null>(null);

  if (!supported) return null;

  const startLogin = async (p: AccountProfileInfo) => {
    setBusy(p.id);
    setNote(null);
    const r = await login(p.id);
    setBusy(null);
    if ('error' in r) {
      setNote({ id: p.id, text: r.error, error: true });
      return;
    }
    setNote({
      id: p.id,
      text: `${r.alreadyRunning ? 'Already open' : 'Opened'}: session "${r.sessionName}" runs ${r.command}. Open it from the session list to finish logging in.`,
    });
  };

  return (
    <div className="settings-card profiles-card">
      <div className="settings-card-row">
        <div className="settings-card-row-info">
          <span className="status-dot status-dot-green" />
          <span className="settings-card-label">{serverName}</span>
        </div>
        <button className="settings-action-btn" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      {error && <div className="settings-card-detail profiles-error">{error}</div>}
      <ul className="profiles-list">
        {profiles.map((p) => (
          <li key={p.id} className="profiles-item">
            <div className="profiles-item-info">
              <span className="profiles-item-name">
                {p.isDefault ? (p.agent === 'codex' ? 'Codex' : 'Claude') : p.label}
                <span className="profiles-item-agent">
                  {p.isDefault ? ' default' : ` ${p.agent === 'codex' ? 'Codex' : 'Claude'}`}
                </span>
              </span>
              <span className="profiles-item-home" title={p.home}>
                {p.home}
              </span>
            </div>
            <span className={`profiles-item-state profiles-state-${p.loginState}`}>
              {STATE_TEXT[p.loginState]}
            </span>
            <button
              className="settings-action-btn"
              disabled={busy !== null}
              onClick={() => void startLogin(p)}
              title="Start the agent's login in this account's environment"
            >
              {busy === p.id ? 'Starting...' : 'Log in'}
            </button>
            {note?.id === p.id && (
              <div className={`profiles-note${note.error ? ' profiles-error' : ''}`}>{note.text}</div>
            )}
          </li>
        ))}
      </ul>
      <div className="settings-card-detail profiles-help">
        Add an account on the server: <code>bin/companion profile add work --agent claude</code>
      </div>
    </div>
  );
}
