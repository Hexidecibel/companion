import { useNewSession } from '../hooks/useNewSession';
import { isMobileViewport } from '../utils/platform';

interface NewSessionPanelProps {
  serverId: string;
  serverName: string;
  onCreated: (serverId: string, sessionName: string) => void;
  onClose: () => void;
}

export function NewSessionPanel({
  serverId,
  onCreated,
  onClose,
}: NewSessionPanelProps) {
  const {
    recents,
    recentsLoading,
    currentPath,
    entries,
    browsing,
    browseTo,
    manualPath,
    setManualPath,
    creating,
    creatingPath,
    error,
    create,
    createFromRecent,
    navigateToInput,
    reset,
  } = useNewSession(serverId);

  const mobile = isMobileViewport();

  const handleCreate = async () => {
    const ok = await create();
    if (ok) {
      reset();
      onCreated(serverId, '');
    }
  };

  const handleRecent = async (path: string) => {
    const ok = await createFromRecent(path);
    if (ok) {
      reset();
      onCreated(serverId, '');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      navigateToInput();
    }
  };

  // Abbreviate path for display: /home/user/projects/foo → ~/projects/foo
  const abbreviate = (p: string) => {
    const home = currentPath?.match(/^\/home\/[^/]+/)?.[0] || '/home';
    if (p.startsWith(home + '/')) return '~' + p.slice(home.length);
    if (p === home) return '~';
    return p;
  };

  const dirs = entries.filter((e) => e.isDirectory && e.name !== '..');
  const parentPath = currentPath && currentPath !== '/'
    ? currentPath.replace(/\/[^/]+\/?$/, '') || '/'
    : null;

  const content = (
    <div className={`new-session-panel ${mobile ? 'new-session-sheet' : ''}`}>
      <div className="new-session-header">
        <span className="new-session-title">New Session</span>
        <button className="new-session-close" onClick={onClose} title="Close">
          &times;
        </button>
      </div>

      <div className="new-session-body">
        {/* Unified path input */}
        <div className="new-session-path-row">
          <input
            type="text"
            className="new-session-input"
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="/path/to/project"
            spellCheck={false}
            autoFocus={!mobile}
          />
          <button
            className="new-session-go-btn"
            onClick={navigateToInput}
            disabled={!manualPath.trim() || browsing}
            title="Navigate to path"
          >
            {browsing ? '...' : '\u25B8'}
          </button>
        </div>

        {error && <div className="new-session-error">{error}</div>}

        {/* Recent Projects */}
        {recents.length > 0 && (
          <div className="new-session-section">
            <div className="new-session-section-title">Recent</div>
            <div className="new-session-recent-list">
              {recents.map((r) => {
                const isCreating = creating && creatingPath === r.path;
                return (
                  <button
                    key={r.path}
                    className={`new-session-recent-card ${isCreating ? 'creating' : ''}`}
                    onClick={() => handleRecent(r.path)}
                    disabled={creating}
                  >
                    <span className="new-session-recent-name">{r.name}</span>
                    <span className="new-session-recent-path">{abbreviate(r.path)}</span>
                    {isCreating && <span className="new-session-recent-spinner" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {recentsLoading && recents.length === 0 && (
          <div className="new-session-loading">Loading...</div>
        )}

        {/* Directory Browser */}
        <div className="new-session-section new-session-browser-section">
          <div className="new-session-section-title">Browse</div>
          <div className="new-session-browser-list">
            {parentPath !== null && (
              <button
                className="new-session-browser-item"
                onClick={() => browseTo(parentPath)}
                disabled={browsing}
              >
                <span className="new-session-folder-icon">..</span>
              </button>
            )}
            {dirs.map((entry) => (
              <button
                key={entry.path}
                className="new-session-browser-item"
                onClick={() => browseTo(entry.path)}
                disabled={browsing}
              >
                <span className="new-session-folder-icon">{entry.name}</span>
              </button>
            ))}
            {!browsing && dirs.length === 0 && currentPath && (
              <div className="new-session-empty-dir">No subdirectories</div>
            )}
          </div>
        </div>
      </div>

      <div className="new-session-footer">
        <button
          className="new-session-create-btn"
          disabled={!manualPath.trim() || creating}
          onClick={handleCreate}
        >
          {creating && !creatingPath ? 'Creating...' : 'Create Session'}
        </button>
      </div>
    </div>
  );

  // On mobile, wrap in a full-screen overlay
  if (mobile) {
    return (
      <div className="new-session-overlay" onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}>
        {content}
      </div>
    );
  }

  return content;
}
