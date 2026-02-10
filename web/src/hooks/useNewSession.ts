import { useState, useEffect, useCallback } from 'react';
import { connectionManager } from '../services/ConnectionManager';
import {
  RecentDirectory,
  getRecentDirectories,
  addRecentDirectory,
} from '../services/recentDirectories';

export interface DirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface UseNewSessionResult {
  recents: RecentDirectory[];
  recentsLoading: boolean;
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

export function useNewSession(serverId: string): UseNewSessionResult {
  const [recents, setRecents] = useState<RecentDirectory[]>([]);
  const [recentsLoading, setRecentsLoading] = useState(true);
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
      const stored = getRecentDirectories(serverId);

      // Also pull working dirs from existing tmux sessions
      try {
        const sessResp = await conn!.sendRequest('list_tmux_sessions');
        if (sessResp.success && sessResp.payload) {
          const sessions = sessResp.payload as Array<{
            name: string;
            workingDir?: string;
          }>;
          const now = Date.now();
          const sessionDirs: RecentDirectory[] = sessions
            .filter((s) => s.workingDir)
            .map((s) => ({
              path: s.workingDir!,
              name: s.workingDir!.split('/').filter(Boolean).pop() || s.workingDir!,
              lastUsed: now - 1, // slightly older so explicit recents come first
            }));

          // Merge: stored takes priority, dedup by path
          const seen = new Set(stored.map((d) => d.path));
          const merged = [...stored];
          for (const sd of sessionDirs) {
            if (!seen.has(sd.path)) {
              seen.add(sd.path);
              merged.push(sd);
            }
          }
          merged.sort((a, b) => b.lastUsed - a.lastUsed);
          if (!cancelled) setRecents(merged.slice(0, 8));
        } else {
          if (!cancelled) setRecents(stored);
        }
      } catch {
        if (!cancelled) setRecents(stored);
      }

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
  }, [serverId]);

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
