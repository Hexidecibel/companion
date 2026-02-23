import { useState, useEffect, useCallback, useRef } from 'react';
import { TaskItem } from '../types';
import { connectionManager } from '../services/ConnectionManager';

const POLL_INTERVAL = 5000;

interface UseTasksReturn {
  tasks: TaskItem[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useTasks(
  serverId: string | null,
  sessionId: string | null,
): UseTasksReturn {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchTasks = useCallback(async () => {
    if (!serverId || !sessionId) {
      setTasks([]);
      return;
    }

    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) return;

    try {
      const response = await conn.sendRequest('get_tasks', { sessionId });
      if (!mountedRef.current) return;
      if (response.success && response.payload) {
        const payload = response.payload as { tasks: TaskItem[]; sessionId: string };
        setTasks(payload.tasks);
        setError(null);
      } else if (!response.success) {
        setError(response.error || 'Failed to load tasks');
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load tasks');
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [serverId, sessionId]);

  useEffect(() => {
    mountedRef.current = true;

    if (!serverId || !sessionId) {
      setTasks([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    fetchTasks();

    const timer = setInterval(fetchTasks, POLL_INTERVAL);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [serverId, sessionId, fetchTasks]);

  return { tasks, loading, error, refresh: fetchTasks };
}
