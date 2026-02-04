import { useState, useEffect, useRef, useCallback } from 'react';
import { WorkGroup } from '../types';
import { connectionManager } from '../services/ConnectionManager';

const POLL_INTERVAL = 5000;

interface UseWorkGroupsReturn {
  groups: WorkGroup[];
  loading: boolean;
  /** Get the work group that a given session belongs to (as foreman or worker) */
  getGroupForSession: (sessionId: string) => WorkGroup | undefined;
  /** Send input to a specific worker */
  sendWorkerInput: (serverId: string, groupId: string, workerId: string, text: string) => Promise<boolean>;
  /** Trigger merge of a work group */
  mergeGroup: (serverId: string, groupId: string) => Promise<{ success: boolean; error?: string }>;
  /** Cancel a work group */
  cancelGroup: (serverId: string, groupId: string) => Promise<{ success: boolean; error?: string }>;
  /** Retry a failed worker */
  retryWorker: (serverId: string, groupId: string, workerId: string) => Promise<{ success: boolean; error?: string }>;
  /** Dismiss a completed/cancelled work group from the list */
  dismissGroup: (serverId: string, groupId: string) => Promise<{ success: boolean; error?: string }>;
}

export function useWorkGroups(serverId: string | null): UseWorkGroupsReturn {
  const [groups, setGroups] = useState<WorkGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    if (!serverId) {
      setGroups([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    async function fetchGroups() {
      const conn = connectionManager.getConnection(serverId!);
      if (!conn || !conn.isConnected()) return;

      try {
        const response = await conn.sendRequest('get_work_groups', {});
        if (!mountedRef.current) return;

        if (response.success && response.payload) {
          const payload = response.payload as { groups: WorkGroup[] };
          setGroups(payload.groups);
        }
      } catch {
        // Silently ignore
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    }

    fetchGroups();
    const timer = setInterval(fetchGroups, POLL_INTERVAL);

    // Also listen for broadcast updates
    const conn = connectionManager.getConnection(serverId);
    const unsubscribe = conn?.onMessage((msg) => {
      if (msg.type === 'work_group_update' && msg.payload && mountedRef.current) {
        const updatedGroup = msg.payload as WorkGroup;
        setGroups(prev => {
          const idx = prev.findIndex(g => g.id === updatedGroup.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = updatedGroup;
            return next;
          }
          return [...prev, updatedGroup];
        });
      }
    });

    return () => {
      mountedRef.current = false;
      clearInterval(timer);
      unsubscribe?.();
    };
  }, [serverId]);

  const getGroupForSession = useCallback((sessionId: string): WorkGroup | undefined => {
    return groups.find(g =>
      g.foremanSessionId === sessionId ||
      g.workers.some(w => w.sessionId === sessionId)
    );
  }, [groups]);

  const sendWorkerInput = useCallback(async (
    sid: string, groupId: string, workerId: string, text: string
  ): Promise<boolean> => {
    const conn = connectionManager.getConnection(sid);
    if (!conn?.isConnected()) return false;
    try {
      const res = await conn.sendRequest('send_worker_input', { groupId, workerId, text });
      return res.success;
    } catch {
      return false;
    }
  }, []);

  const mergeGroup = useCallback(async (
    sid: string, groupId: string
  ): Promise<{ success: boolean; error?: string }> => {
    const conn = connectionManager.getConnection(sid);
    if (!conn?.isConnected()) return { success: false, error: 'Not connected' };
    try {
      const res = await conn.sendRequest('merge_work_group', { groupId }, 30000);
      return { success: res.success, error: res.error };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }, []);

  const cancelGroup = useCallback(async (
    sid: string, groupId: string
  ): Promise<{ success: boolean; error?: string }> => {
    const conn = connectionManager.getConnection(sid);
    if (!conn?.isConnected()) return { success: false, error: 'Not connected' };
    try {
      const res = await conn.sendRequest('cancel_work_group', { groupId }, 30000);
      return { success: res.success, error: res.error };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }, []);

  const retryWorker = useCallback(async (
    sid: string, groupId: string, workerId: string
  ): Promise<{ success: boolean; error?: string }> => {
    const conn = connectionManager.getConnection(sid);
    if (!conn?.isConnected()) return { success: false, error: 'Not connected' };
    try {
      const res = await conn.sendRequest('retry_worker', { groupId, workerId });
      return { success: res.success, error: res.error };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }, []);

  const dismissGroup = useCallback(async (
    sid: string, groupId: string
  ): Promise<{ success: boolean; error?: string }> => {
    const conn = connectionManager.getConnection(sid);
    if (!conn?.isConnected()) return { success: false, error: 'Not connected' };
    try {
      const res = await conn.sendRequest('dismiss_work_group', { groupId });
      if (res.success) {
        // Remove from local state immediately
        setGroups(prev => prev.filter(g => g.id !== groupId));
      }
      return { success: res.success, error: res.error };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }, []);

  return { groups, loading, getGroupForSession, sendWorkerInput, mergeGroup, cancelGroup, retryWorker, dismissGroup };
}
