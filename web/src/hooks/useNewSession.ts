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
  startCli: boolean;
  setStartCli: (v: boolean) => void;
  creating: boolean;
  error: string | null;
  create: () => Promise<boolean>;
  reset: () => void;
  // Worktree support
  branchMode: boolean;
  setBranchMode: (v: boolean) => void;
  branchName: string;
  setBranchName: (v: string) => void;
  createWorktree: () => Promise<boolean>;
}

export function useNewSession(serverId: string): UseNewSessionResult {
  const [recents, setRecents] = useState<RecentDirectory[]>([]);
  const [recentsLoading, setRecentsLoading] = useState(true);
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [manualPath, setManualPath] = useState('');
  const [startCli, setStartCli] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branchMode, setBranchMode] = useState(false);
  const [branchName, setBranchName] = useState('');

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
          if (!cancelled) setRecents(merged.slice(0, 10));
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

  const create = useCallback(async (): Promise<boolean> => {
    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected() || !manualPath.trim()) return false;

    setCreating(true);
    setError(null);

    try {
      const resp = await conn.sendRequest('create_tmux_session', {
        workingDir: manualPath.trim(),
        startCli,
      });

      if (resp.success) {
        addRecentDirectory(serverId, manualPath.trim());
        setCreating(false);
        return true;
      } else {
        setError(resp.error || 'Failed to create session');
        setCreating(false);
        return false;
      }
    } catch (err) {
      setError(String(err));
      setCreating(false);
      return false;
    }
  }, [serverId, manualPath, startCli]);

  const createWorktree = useCallback(async (): Promise<boolean> => {
    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected() || !manualPath.trim()) return false;

    setCreating(true);
    setError(null);

    try {
      const resp = await conn.sendRequest('create_worktree_session', {
        parentDir: manualPath.trim(),
        branch: branchName.trim() || undefined,
        startCli,
      });

      if (resp.success) {
        addRecentDirectory(serverId, manualPath.trim());
        setCreating(false);
        return true;
      } else {
        setError(resp.error || 'Failed to create worktree session');
        setCreating(false);
        return false;
      }
    } catch (err) {
      setError(String(err));
      setCreating(false);
      return false;
    }
  }, [serverId, manualPath, branchName, startCli]);

  const reset = useCallback(() => {
    setManualPath('');
    setBranchMode(false);
    setBranchName('');
    setError(null);
    setCreating(false);
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
  };
}
