import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNewSession } from '../hooks/useNewSession';
import { isMobileViewport } from '../utils/platform';
import type { CodingAgent } from '../types';
import { AgentPicker, readStoredAgent, writeStoredAgent } from './AgentPicker';
import { ProfilePicker, pickProfile, readStoredProfile, writeStoredProfile } from './ProfilePicker';
import { useProfiles } from '../hooks/useProfiles';
import type { AccountProfileInfo } from '../types/profiles';

interface NewSessionPanelProps {
  serverId: string;
  serverName: string;
  onCreated: (serverId: string, sessionName: string) => void;
  onClose: () => void;
}

type Tab = 'recent' | 'browse';

const TAB_STORAGE_PREFIX = 'new-session-tab:';
const FAV_OPEN_STORAGE_PREFIX = 'new-session-fav-open:';
/** Recents shown before "Show more". */
const RECENTS_VISIBLE = 5;

/** Expanded favorite roots (per-viewer convenience); null = never chosen. */
function readOpenFavorites(serverId: string): string[] | null {
  try {
    const raw = localStorage.getItem(FAV_OPEN_STORAGE_PREFIX + serverId);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

function writeOpenFavorites(serverId: string, roots: string[]) {
  try {
    localStorage.setItem(FAV_OPEN_STORAGE_PREFIX + serverId, JSON.stringify(roots));
  } catch {
    // ignore
  }
}

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
  const [agent, setAgent] = useState<CodingAgent>(() => readStoredAgent(serverId));
  const pickAgent = (next: CodingAgent) => {
    setAgent(next);
    writeStoredAgent(serverId, next);
  };
  // Account profiles: shown only when more than the default logins exist.
  const { profiles, hasExtra } = useProfiles(serverId);
  const [storedProfile, setStoredProfile] = useState(() => readStoredProfile(serverId));
  const profile = hasExtra ? pickProfile(profiles, storedProfile, agent) : undefined;
  const effectiveAgent = profile ? profile.agent : agent;
  const chooseProfile = (p: AccountProfileInfo) => {
    setStoredProfile(p.id);
    writeStoredProfile(serverId, p.id);
    pickAgent(p.agent);
  };
  const {
    recents,
    recentsLoading,
    favorites,
    favoritesSupported,
    pinFavorite,
    unpinFavorite,
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
  } = useNewSession(serverId, effectiveAgent, profile && !profile.isDefault ? profile.id : undefined);

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
    if (!recentsLoading && recents.length === 0 && favorites.length === 0 && tab === 'recent') {
      setTab('browse');
    }
  }, [recentsLoading, recents.length, favorites.length, tab]);

  const [showAllRecents, setShowAllRecents] = useState(false);
  const [openFavorites, setOpenFavorites] = useState<string[] | null>(() =>
    readOpenFavorites(serverId),
  );
  // Never chosen: the first favorite starts open.
  const isFavoriteOpen = (root: string) =>
    openFavorites ? openFavorites.includes(root) : favorites[0]?.root === root;
  const toggleFavorite = (root: string) => {
    const current = openFavorites ?? (favorites[0] ? [favorites[0].root] : []);
    const next = current.includes(root)
      ? current.filter((r) => r !== root)
      : [...current, root];
    setOpenFavorites(next);
    writeOpenFavorites(serverId, next);
  };
  const [pinBusy, setPinBusy] = useState(false);
  const currentIsFavorite = favorites.some((f) => f.root === currentPath);
  const togglePinCurrent = async () => {
    if (!currentPath || pinBusy) return;
    setPinBusy(true);
    try {
      await (currentIsFavorite ? unpinFavorite(currentPath) : pinFavorite(currentPath));
    } finally {
      setPinBusy(false);
    }
  };
  const handleUnpin = async (root: string) => {
    if (pinBusy) return;
    setPinBusy(true);
    try {
      await unpinFavorite(root);
    } finally {
      setPinBusy(false);
    }
  };
  const browseFavorite = (root: string) => {
    selectTab('browse');
    browseTo(root);
  };

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
  const visibleRecents = showAllRecents ? recents : recents.slice(0, RECENTS_VISIBLE);

  const renderRecentCard = (r: { path: string; name: string }) => {
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
  };

  const recentPanel = (
    <div
      className="new-session-tabpanel new-session-tabpanel-recent"
      role="tabpanel"
      id="new-session-panel-recent"
      aria-labelledby="new-session-tab-recent"
      hidden={tab !== 'recent'}
    >
      {recentsLoading && recents.length === 0 && favorites.length === 0 ? (
        <div className="new-session-loading">Loading...</div>
      ) : recents.length === 0 && favorites.length === 0 ? (
        <div className="new-session-empty-state">
          <div className="new-session-empty-title">No recent projects</div>
          <div className="new-session-empty-hint">
            {favoritesSupported
              ? 'Switch to Browse to pick a directory, or pin a folder there to list its projects here.'
              : 'Switch to Browse to pick a directory.'}
          </div>
        </div>
      ) : (
        <>
          {recents.length > 0 && (
            <div className="new-session-section">
              <div className="new-session-section-title">Recent</div>
              <div className="new-session-recent-list">
                {visibleRecents.map(renderRecentCard)}
                {recents.length > RECENTS_VISIBLE && (
                  <button
                    className="new-session-more-btn"
                    onClick={() => setShowAllRecents((v) => !v)}
                  >
                    {showAllRecents ? 'Show fewer' : `Show ${recents.length - RECENTS_VISIBLE} more`}
                  </button>
                )}
              </div>
            </div>
          )}
          {favorites.map((fav) => {
            const open = isFavoriteOpen(fav.root);
            return (
              <div key={fav.root} className="new-session-section new-session-fav">
                <div className="new-session-fav-header">
                  <button
                    className="new-session-fav-toggle"
                    onClick={() => toggleFavorite(fav.root)}
                    aria-expanded={open}
                  >
                    <span className={`new-session-fav-chevron ${open ? 'open' : ''}`}>&#9656;</span>
                    <span className="new-session-fav-name">{fav.name}</span>
                    <span className="new-session-fav-root">{abbreviate(fav.root)}</span>
                    <span className="new-session-fav-count">{fav.entries.length}</span>
                  </button>
                  <button
                    className="new-session-fav-action"
                    onClick={() => browseFavorite(fav.root)}
                    title="Browse this folder"
                  >
                    Browse
                  </button>
                  <button
                    className="new-session-fav-action"
                    onClick={() => handleUnpin(fav.root)}
                    disabled={pinBusy}
                    title="Remove from favorites"
                  >
                    Unpin
                  </button>
                </div>
                {open && (
                  <div className="new-session-recent-list">
                    {fav.entries.length === 0 ? (
                      <div className="new-session-empty-dir">No subdirectories</div>
                    ) : (
                      fav.entries.map(renderRecentCard)
                    )}
                    {fav.truncated && (
                      <div className="new-session-empty-dir">
                        List truncated. Browse the folder to see the rest.
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </>
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
        {favoritesSupported && currentPath && (
          <button
            className={`new-session-pin-btn ${currentIsFavorite ? 'pinned' : ''}`}
            onClick={togglePinCurrent}
            disabled={pinBusy || browsing}
            title={
              currentIsFavorite
                ? 'Remove this folder from favorites'
                : 'Pin this folder: its subfolders show up under Projects'
            }
          >
            {currentIsFavorite ? 'Pinned' : 'Pin'}
          </button>
        )}
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
          <span className="new-session-tab-label">
            {favoritesSupported ? 'Projects' : 'Recent'}
          </span>
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

      {profile ? (
        <ProfilePicker profiles={profiles} value={profile.id} onChange={chooseProfile} disabled={creating} />
      ) : (
        <AgentPicker value={agent} onChange={pickAgent} disabled={creating} />
      )}

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
