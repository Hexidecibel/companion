import { useNewSession } from '../hooks/useNewSession';

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
    startCli,
    setStartCli,
    creating,
    error,
    create,
    reset,
    branchMode,
    setBranchMode,
    branchName,
    setBranchName,
    createWorktree,
  } = useNewSession(serverId);

  const handleCreate = async () => {
    const ok = branchMode ? await createWorktree() : await create();
    if (ok) {
      reset();
      // Don't pass a fake sessionId - the new session's JSONL UUID isn't known yet.
      // Pass empty string so Dashboard knows creation succeeded but doesn't try to
      // select a non-existent session. The session will appear in server summary
      // once the CLI creates its JSONL file.
      onCreated(serverId, '');
    }
  };

  const parentPath = currentPath
    ? currentPath.replace(/\/[^/]+\/?$/, '') || '/'
    : null;

  return (
    <div className="new-session-panel">
      <div className="new-session-header">
        <span className="new-session-title">New Session</span>
        <button
          className="new-session-close"
          onClick={onClose}
          title="Close"
        >
          &times;
        </button>
      </div>

      <div className="new-session-body">
        {/* Path input */}
        <div className="new-session-field">
          <label className="new-session-label">Directory path</label>
          <input
            type="text"
            className="new-session-input"
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            placeholder="/home/user/project"
            spellCheck={false}
          />
        </div>

        {/* Start CLI checkbox */}
        <div className="new-session-checkbox">
          <input
            type="checkbox"
            id={`startCli-${serverId}`}
            checked={startCli}
            onChange={(e) => setStartCli(e.target.checked)}
          />
          <label htmlFor={`startCli-${serverId}`}>Start CLI in session</label>
        </div>

        {/* Branch session (git worktree) */}
        <div className="new-session-checkbox">
          <input
            type="checkbox"
            id={`branchMode-${serverId}`}
            checked={branchMode}
            onChange={(e) => setBranchMode(e.target.checked)}
          />
          <label htmlFor={`branchMode-${serverId}`}>Branch session (git worktree)</label>
        </div>

        {branchMode && (
          <div className="new-session-field">
            <label className="new-session-label">Branch name (optional)</label>
            <input
              type="text"
              className="new-session-input"
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              placeholder="feature-my-branch (auto-generated if empty)"
              spellCheck={false}
            />
          </div>
        )}

        {/* Error */}
        {error && <div className="new-session-error">{error}</div>}

        {/* Recent Projects */}
        {recents.length > 0 && (
          <div className="new-session-section">
            <div className="new-session-section-title">Recent Projects</div>
            {recents.map((r) => (
              <div
                key={r.path}
                className="new-session-recent-item"
                onClick={() => setManualPath(r.path)}
              >
                <span className="new-session-recent-name">{r.name}</span>
                <span className="new-session-recent-path">{r.path}</span>
              </div>
            ))}
          </div>
        )}

        {recentsLoading && recents.length === 0 && (
          <div className="new-session-loading">Loading recents...</div>
        )}

        {/* Directory Browser */}
        <div className="new-session-section">
          <div className="new-session-section-title">Browse</div>

          {currentPath && (
            <div className="new-session-browser-current">
              <span className="new-session-browser-path">{currentPath}</span>
              <button
                className="new-session-select-btn"
                onClick={() => setManualPath(currentPath)}
                title="Use this directory"
              >
                Select
              </button>
            </div>
          )}

          {browsing && (
            <div className="new-session-loading">Browsing...</div>
          )}

          {!browsing && (
            <div className="new-session-browser-list">
              {parentPath !== null && (
                <div
                  className="new-session-browser-item"
                  onClick={() => browseTo(parentPath)}
                >
                  <span className="new-session-folder-icon">..</span>
                </div>
              )}
              {entries
                .filter((e) => e.isDirectory)
                .map((entry) => (
                  <div
                    key={entry.path}
                    className="new-session-browser-item"
                    onClick={() => browseTo(entry.path)}
                  >
                    <span className="new-session-folder-icon">{entry.name}</span>
                  </div>
                ))}
              {entries.filter((e) => e.isDirectory).length === 0 && currentPath && (
                <div className="new-session-empty-dir">No subdirectories</div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="new-session-footer">
        <button
          className="new-session-create-btn"
          disabled={!manualPath.trim() || creating}
          onClick={handleCreate}
        >
          {creating ? 'Creating...' : branchMode ? 'Create Branch Session' : 'Create Session'}
        </button>
      </div>
    </div>
  );
}
