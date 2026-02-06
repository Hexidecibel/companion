import { useState, useEffect, useCallback } from 'react';
import { connectionManager } from '../services/ConnectionManager';
import { Skill } from '../types';

interface UseSkillsReturn {
  skills: Skill[];
  loading: boolean;
  error: string | null;
  installSkill: (skillId: string, target: 'project' | 'global') => Promise<boolean>;
  uninstallSkill: (skillId: string, source: 'project' | 'global') => Promise<boolean>;
  refresh: () => void;
}

export function useSkills(serverId: string | null): UseSkillsReturn {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSkills = useCallback(() => {
    if (!serverId) {
      setSkills([]);
      return;
    }

    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) {
      setError('Not connected');
      return;
    }

    setLoading(true);
    setError(null);

    conn
      .sendRequest('list_skills')
      .then((response) => {
        if (response.success && response.payload) {
          const payload = response.payload as { skills: Skill[] };
          setSkills(payload.skills || []);
        } else {
          setError(response.error || 'Failed to fetch skills');
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to fetch skills');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [serverId]);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  const installSkill = useCallback(
    async (skillId: string, target: 'project' | 'global'): Promise<boolean> => {
      if (!serverId) return false;
      const conn = connectionManager.getConnection(serverId);
      if (!conn || !conn.isConnected()) return false;

      try {
        const response = await conn.sendRequest('install_skill', { skillId, target });
        if (response.success) {
          fetchSkills(); // Refresh list
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    [serverId, fetchSkills]
  );

  const uninstallSkill = useCallback(
    async (skillId: string, source: 'project' | 'global'): Promise<boolean> => {
      if (!serverId) return false;
      const conn = connectionManager.getConnection(serverId);
      if (!conn || !conn.isConnected()) return false;

      try {
        const response = await conn.sendRequest('uninstall_skill', { skillId, source });
        if (response.success) {
          fetchSkills(); // Refresh list
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    [serverId, fetchSkills]
  );

  return { skills, loading, error, installSkill, uninstallSkill, refresh: fetchSkills };
}
