import { useState, useEffect, useCallback } from 'react';
import { connectionManager } from '../services/ConnectionManager';
import {
  RecentDirectory,
  getRecentDirectories,
  addRecentDirectory,
  combineRecents,
} from '../services/recentDirectories';
import {
  fetchProjectDirs,
  addFavoriteDir,
  removeFavoriteDir,
} from '../services/projectDirs';
import type { CodingAgent } from '../types';
import type { FavoriteDirGroup } from '../types/projectDirs';

/** How many recents the panel keeps (it shows the top few, the rest on demand). */
const MAX_RECENTS = 12;

export interface DirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface UseNewSessionResult {
  recents: RecentDirectory[];
  recentsLoading: boolean;
  /** Favorite roots with their subfolders (empty on older daemons). */
  favorites: FavoriteDirGroup[];
  /** True when the daemon supports project dirs (favorites can be pinned). */
  favoritesSupported: boolean;
  pinFavorite: (path: string) => Promise<boolean>;
  unpinFavorite: (root: string) => Promise<boolean>;
  currentPath: string;
  entries: DirectoryEntry[];
  browsing: boolean;
  browseTo: (path: string) => void;
  manualPath: string;
  setManualPath: (path: string) => void;
  creating: boolean;
  creatingPath: string | null;
  error: string | null;
  create: () => Promise<boolean>;
  createFromRecent: (path: string) => Promise<boolean>;
  navigateToInput: () => void;
  reset: () => void;
}

/**
 * `agent`: which coding agent a new session starts (default Claude Code).
 * `profileId`: a non-default account profile (the daemon checks it matches the agent).
 */
export function useNewSession(
  serverId: string,
  agent: CodingAgent = 'claude',
  profileId?: string,
): UseNewSessionResult {
  const [recents, setRecents] = useState<RecentDirectory[]>([]);
  const [recentsLoading, setRecentsLoading] = useState(true);
  const [favorites, setFavorites] = useState<FavoriteDirGroup[]>([]);
  const [favoritesSupported, setFavoritesSupported] = useState(false);
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [manualPath, setManualPath] = useState('');
  const [creating, setCreating] = useState(false);
  const [creatingPath, setCreatingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Clear error when path changes
  useEffect(() => {
    setError(null);
  }, [manualPath]);

  // Fetch recents + initial browse on mount
  useEffect(() => {
    let cancelled = false;
    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) {
      setRecentsLoading(false);
      return;
    }

    async function init() {
      // Local (legacy, per-device) recents stay merged in so nothing saved
      // before the daemon kept recents is lost.
      const stored = getRecentDirectories(serverId);

      const [daemonDirs, sessionDirs] = await Promise.all([
        fetchProjectDirs(conn!),
        // Working dirs of live tmux sessions.
        conn!
          .sendRequest('list_tmux_sessions')
          .then((resp): RecentDirectory[] => {
            if (!resp.success || !resp.payload) return [];
            const raw = resp.payload as
              | { sessions?: Array<{ workingDir?: string }> }
              | Array<{ workingDir?: string }>;
            const sessions = Array.isArray(raw) ? raw : raw.sessions ?? [];
            const now = Date.now();
            return sessions
              .filter((s) => s.workingDir)
              .map((s) => ({
                path: s.workingDir!,
                name: s.workingDir!.split('/').filter(Boolean).pop() || s.workingDir!,
                lastUsed: now,
              }));
          })
          .catch(() => [] as RecentDirectory[]),
      ]);
      if (cancelled) return;

      if (daemonDirs) {
        setFavoritesSupported(true);
        setFavorites(daemonDirs.favorites);
      }
      setRecents(combineRecents(daemonDirs?.recents ?? [], stored, sessionDirs, MAX_RECENTS));

      if (!cancelled) setRecentsLoading(false);

      // Browse home directory
      try {
        const browseResp = await conn!.sendRequest('browse_directories');
        if (!cancelled && browseResp.success && browseResp.payload) {
          const payload = browseResp.payload as {
            currentPath: string;
            entries: DirectoryEntry[];
          };
          setCurrentPath(payload.currentPath);
          setManualPath(payload.currentPath);
          setEntries(payload.entries ?? []);
        }
      } catch {
        // browsing is optional
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  const browseTo = useCallback(
    async (path: string) => {
      const conn = connectionManager.getConnection(serverId);
      if (!conn || !conn.isConnected()) return;

      setBrowsing(true);
      try {
        const resp = await conn.sendRequest('browse_directories', { path });
        if (resp.success && resp.payload) {
          const payload = resp.payload as {
            currentPath: string;
            entries: DirectoryEntry[];
          };
          setCurrentPath(payload.currentPath);
          setManualPath(payload.currentPath);
          setEntries(payload.entries ?? []);
        }
      } catch {
        // ignore
      } finally {
        setBrowsing(false);
      }
    },
    [serverId],
  );

  const navigateToInput = useCallback(() => {
    const trimmed = manualPath.trim();
    if (trimmed) {
      browseTo(trimmed);
    }
  }, [manualPath, browseTo]);

  const createSession = useCallback(async (dirPath: string): Promise<boolean> => {
    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected() || !dirPath.trim()) return false;

    setCreating(true);
    setCreatingPath(dirPath);
    setError(null);

    try {
      const resp = await conn.sendRequest('create_tmux_session', {
        workingDir: dirPath.trim(),
        startCli: true,
        // Older daemons ignore the field and start Claude.
        ...(agent !== 'claude' ? { agent } : {}),
        ...(profileId ? { profileId } : {}),
      });

      if (resp.success) {
        addRecentDirectory(serverId, dirPath.trim());
        setCreating(false);
        setCreatingPath(null);
        return true;
      } else {
        setError(resp.error || 'Failed to create session');
        setCreating(false);
        setCreatingPath(null);
        return false;
      }
    } catch (err) {
      setError(String(err));
      setCreating(false);
      setCreatingPath(null);
      return false;
    }
  }, [serverId, agent, profileId]);

  const applyFavoriteResult = useCallback(
    async (op: typeof addFavoriteDir, path: string): Promise<boolean> => {
      const conn = connectionManager.getConnection(serverId);
      if (!conn || !conn.isConnected() || !path.trim()) return false;
      setError(null);
      const r = await op(conn, path.trim());
      if (r.ok) {
        setFavorites(r.data.favorites);
        return true;
      }
      setError(r.error);
      return false;
    },
    [serverId],
  );

  const pinFavorite = useCallback(
    (path: string) => applyFavoriteResult(addFavoriteDir, path),
    [applyFavoriteResult],
  );
  const unpinFavorite = useCallback(
    (root: string) => applyFavoriteResult(removeFavoriteDir, root),
    [applyFavoriteResult],
  );

  const create = useCallback(async (): Promise<boolean> => {
    return createSession(manualPath);
  }, [manualPath, createSession]);

  const createFromRecent = useCallback(async (path: string): Promise<boolean> => {
    return createSession(path);
  }, [createSession]);

  const reset = useCallback(() => {
    setManualPath('');
    setError(null);
    setCreating(false);
    setCreatingPath(null);
  }, []);

  return {
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
  };
}
