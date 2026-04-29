import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNewSession } from '../hooks/useNewSession';
import { isMobileViewport } from '../utils/platform';

interface NewSessionPanelProps {
  serverId: string;
  serverName: string;
  onCreated: (serverId: string, sessionName: string) => void;
  onClose: () => void;
}

type Tab = 'recent' | 'browse';

const TAB_STORAGE_PREFIX = 'new-session-tab:';

function readStoredTab(serverId: string): Tab | null {
  try {
    const raw = localStorage.getItem(TAB_STORAGE_PREFIX + serverId);
    if (raw === 'recent' || raw === 'browse') return raw;
  } catch {
    // ignore
  }
  return null;
}

function writeStoredTab(serverId: string, tab: Tab) {
  try {
    localStorage.setItem(TAB_STORAGE_PREFIX + serverId, tab);
  } catch {
    // ignore
  }
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

  // Tab state — load from storage, fall back to mobile-default 'browse',
  // desktop-default 'recent'.
  const [tab, setTab] = useState<Tab>(() => {
    const stored = readStoredTab(serverId);
    if (stored) return stored;
    return mobile ? 'browse' : 'recent';
  });

  // If recents are empty after loading and the user hasn't picked a tab
  // explicitly this session, snap to 'browse'.
  const userPickedRef = useRef(false);
  useEffect(() => {
    if (userPickedRef.current) return;
    if (!recentsLoading && recents.length === 0 && tab === 'recent') {
      setTab('browse');
    }
  }, [recentsLoading, recents.length, tab]);

  const selectTab = (next: Tab) => {
    userPickedRef.current = true;
    setTab(next);
    writeStoredTab(serverId, next);
  };

  // Per-path scroll cache. Key is the currentPath being viewed in Browse;
  // value is the most recent scrollTop for that path's list. Preserved
  // across navigations so '..' restores the previous position.
  const scrollCache = useRef<Map<string, number>>(new Map());
  const browseScrollRef = useRef<HTMLDivElement | null>(null);

  // Restore scrollTop when entries for a new currentPath have rendered.
  useLayoutEffect(() => {
    if (tab !== 'browse') return;
    const el = browseScrollRef.current;
    if (!el) return;
    const cached = scrollCache.current.get(currentPath);
    el.scrollTop = cached ?? 0;
  }, [currentPath, entries, tab]);

  const handleBrowseScroll = () => {
    const el = browseScrollRef.current;
    if (!el) return;
    scrollCache.current.set(currentPath, el.scrollTop);
  };

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

  const dirs = useMemo(
    () => entries.filter((e) => e.isDirectory && e.name !== '..'),
    [entries],
  );
  const parentPath = currentPath && currentPath !== '/'
    ? currentPath.replace(/\/[^/]+\/?$/, '') || '/'
    : null;

  const recentBadge = recents.length;

  const recentPanel = (
    <div
      className="new-session-tabpanel new-session-tabpanel-recent"
      role="tabpanel"
      id="new-session-panel-recent"
      aria-labelledby="new-session-tab-recent"
      hidden={tab !== 'recent'}
    >
      {recentsLoading && recents.length === 0 ? (
        <div className="new-session-loading">Loading...</div>
      ) : recents.length === 0 ? (
        <div className="new-session-empty-state">
          <div className="new-session-empty-title">No recent projects</div>
          <div className="new-session-empty-hint">
            Switch to Browse to pick a directory.
          </div>
        </div>
      ) : (
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
      )}
    </div>
  );

  const browsePanel = (
    <div
      className="new-session-tabpanel new-session-tabpanel-browse"
      role="tabpanel"
      id="new-session-panel-browse"
      aria-labelledby="new-session-tab-browse"
      hidden={tab !== 'browse'}
      ref={browseScrollRef}
      onScroll={handleBrowseScroll}
    >
      <div className="new-session-path-row">
        <input
          type="text"
          className="new-session-input"
          value={manualPath}
          onChange={(e) => setManualPath(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="/path/to/project"
          spellCheck={false}
          autoFocus={!mobile && tab === 'browse'}
        />
        <button
          className="new-session-go-btn"
          onClick={navigateToInput}
          disabled={!manualPath.trim() || browsing}
          title="Navigate to path"
        >
          {browsing ? '...' : '▸'}
        </button>
      </div>

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
  );

  const content = (
    <div className={`new-session-panel ${mobile ? 'new-session-sheet' : ''}`}>
      <div className="new-session-header">
        <span className="new-session-title">New Session</span>
        <button className="new-session-close" onClick={onClose} title="Close">
          &times;
        </button>
      </div>

      <div
        className="new-session-tabs"
        role="tablist"
        aria-label="New session source"
      >
        <button
          id="new-session-tab-recent"
          className={`new-session-tab ${tab === 'recent' ? 'active' : ''}`}
          role="tab"
          aria-selected={tab === 'recent'}
          aria-controls="new-session-panel-recent"
          tabIndex={tab === 'recent' ? 0 : -1}
          onClick={() => selectTab('recent')}
        >
          <span className="new-session-tab-label">Recent</span>
          {recentBadge > 0 && (
            <span className="new-session-tab-badge">{recentBadge}</span>
          )}
        </button>
        <button
          id="new-session-tab-browse"
          className={`new-session-tab ${tab === 'browse' ? 'active' : ''}`}
          role="tab"
          aria-selected={tab === 'browse'}
          aria-controls="new-session-panel-browse"
          tabIndex={tab === 'browse' ? 0 : -1}
          onClick={() => selectTab('browse')}
        >
          <span className="new-session-tab-label">Browse</span>
        </button>
      </div>

      {error && <div className="new-session-error">{error}</div>}

      <div className="new-session-body">
        {recentPanel}
        {browsePanel}
      </div>

      {tab === 'browse' && (
        <div className="new-session-footer">
          <button
            className="new-session-create-btn"
            disabled={!manualPath.trim() || creating}
            onClick={handleCreate}
          >
            {creating && !creatingPath ? 'Creating...' : 'Create Session'}
          </button>
        </div>
      )}
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
