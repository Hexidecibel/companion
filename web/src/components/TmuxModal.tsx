import { useState, useEffect } from 'react';
import { TmuxSessionInfo } from '../types';
import { useTmuxSessions } from '../hooks/useTmuxSessions';
import { connectionManager } from '../services/ConnectionManager';

interface TmuxModalProps {
  serverId: string;
  serverName: string;
  onClose: () => void;
}

export function TmuxModal({ serverId, serverName, onClose }: TmuxModalProps) {
  const { sessions, loading, error, refresh, killSession, killAllManaged, createSession } = useTmuxSessions(serverId);
  const [createDir, setCreateDir] = useState('');
  const [startCli, setStartCli] = useState(true);
  const [creating, setCreating] = useState(false);
  const [killingName, setKillingName] = useState<string | null>(null);
  const [killingAll, setKillingAll] = useState(false);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleKill = async (name: string) => {
    setKillingName(name);
    await killSession(name);
    setKillingName(null);
  };

  const handleAdopt = async (name: string) => {
    // Switch tmux session triggers the daemon to start monitoring it
    const conn = connectionManager.getConnection(serverId);
    if (conn && conn.isConnected()) {
      await conn.sendRequest('switch_tmux_session', { sessionName: name });
      await refresh();
    }
  };

  const handleCreate = async () => {
    if (!createDir.trim()) return;
    setCreating(true);
    await createSession(createDir.trim(), startCli);
    setCreating(false);
    setCreateDir('');
  };

  const tagged = sessions.filter((s) => s.tagged);
  const untagged = sessions.filter((s) => !s.tagged);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content tmux-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Tmux Sessions - {serverName}</h3>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>

        <div className="tmux-modal-body">
          {loading && sessions.length === 0 && (
            <div className="tmux-loading">Loading sessions...</div>
          )}

          {error && (
            <div className="tmux-error">{error}</div>
          )}

          {!loading && sessions.length === 0 && !error && (
            <div className="tmux-empty">No tmux sessions found</div>
          )}

          {tagged.length > 0 && (
            <div className="tmux-section">
              <div className="tmux-section-title">
                Companion-managed
                {tagged.length > 1 && (
                  <button
                    className="tmux-kill-all-btn"
                    disabled={killingAll}
                    onClick={async () => {
                      setKillingAll(true);
                      await killAllManaged();
                      setKillingAll(false);
                    }}
                  >
                    {killingAll ? 'Killing...' : `Kill All (${tagged.length})`}
                  </button>
                )}
              </div>
              {tagged.map((s) => (
                <TmuxSessionCard
                  key={s.name}
                  session={s}
                  killing={killingName === s.name}
                  onKill={() => handleKill(s.name)}
                />
              ))}
            </div>
          )}

          {untagged.length > 0 && (
            <div className="tmux-section">
              <div className="tmux-section-title">Other tmux sessions</div>
              {untagged.map((s) => (
                <TmuxSessionCard
                  key={s.name}
                  session={s}
                  killing={killingName === s.name}
                  onKill={() => handleKill(s.name)}
                  onAdopt={() => handleAdopt(s.name)}
                />
              ))}
            </div>
          )}

          <div className="tmux-create-section">
            <div className="tmux-section-title">Create new session</div>
            <input
              className="tmux-create-input"
              type="text"
              value={createDir}
              onChange={(e) => setCreateDir(e.target.value)}
              placeholder="Working directory (e.g. /home/user/project)"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
              }}
            />
            <div className="tmux-create-options">
              <label className="tmux-create-checkbox">
                <input
                  type="checkbox"
                  checked={startCli}
                  onChange={(e) => setStartCli(e.target.checked)}
                />
                Start Claude CLI
              </label>
              <button
                className="tmux-create-btn"
                onClick={handleCreate}
                disabled={!createDir.trim() || creating}
              >
                {creating ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface TmuxSessionCardProps {
  session: TmuxSessionInfo;
  killing: boolean;
  onKill: () => void;
  onAdopt?: () => void;
}

function TmuxSessionCard({ session, killing, onKill, onAdopt }: TmuxSessionCardProps) {
  return (
    <div className="tmux-session-card">
      <div className="tmux-session-header">
        <span className="tmux-session-name">{session.name}</span>
        {session.tagged ? (
          <span className="tmux-tagged-badge">managed</span>
        ) : (
          <span className="tmux-untagged-badge">unmanaged</span>
        )}
      </div>
      {session.workingDir && (
        <div className="tmux-session-dir">{session.workingDir}</div>
      )}
      <div className="tmux-session-meta">
        <span>{session.windows} window{session.windows !== 1 ? 's' : ''}</span>
        <span>{session.attached ? 'attached' : 'detached'}</span>
      </div>
      <div className="tmux-session-actions">
        <button
          className="tmux-kill-btn"
          onClick={onKill}
          disabled={killing}
        >
          {killing ? 'Killing...' : 'Kill'}
        </button>
        {onAdopt && (
          <button className="tmux-adopt-btn" onClick={onAdopt}>
            Adopt
          </button>
        )}
      </div>
    </div>
  );
}
