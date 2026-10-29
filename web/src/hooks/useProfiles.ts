import { useCallback, useEffect, useState } from 'react';
import { connectionManager } from '../services/ConnectionManager';
import type {
  AccountProfileInfo,
  ProfileLoginResponse,
  ProfilesListResponse,
} from '../types/profiles';
import { PROFILES_CHANGED_EVENT } from '../types/profiles';

export interface UseProfilesResult {
  profiles: AccountProfileInfo[];
  /** More than the two default profiles exist (the UI shows profile choices only then). */
  hasExtra: boolean;
  /** false = the daemon predates profiles. */
  supported: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  login: (profileId: string) => Promise<ProfileLoginResponse | { error: string }>;
}

/** Account profiles of one server (`profiles_list`, live via `profiles_changed`). */
export function useProfiles(serverId: string | null | undefined): UseProfilesResult {
  const [profiles, setProfiles] = useState<AccountProfileInfo[]>([]);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!serverId) return;
    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) return;
    try {
      const r = await conn.sendRequest('profiles_list', {}, 10000);
      if (r.success && r.payload) {
        setProfiles((r.payload as ProfilesListResponse).profiles ?? []);
        setSupported(true);
        setError(null);
      } else if (/unknown message type/i.test(r.error ?? '')) {
        setSupported(false);
        setProfiles([]);
      } else {
        setError(r.error ?? 'Failed to load accounts');
      }
    } catch (e) {
      setError(String(e));
    }
  }, [serverId]);

  useEffect(() => {
    void refresh();
    if (!serverId) return;
    const conn = connectionManager.getConnection(serverId);
    if (!conn) return;
    return conn.onMessage((msg) => {
      if (msg.type !== PROFILES_CHANGED_EVENT) return;
      const p = msg.payload as ProfilesListResponse | undefined;
      if (p && Array.isArray(p.profiles)) setProfiles(p.profiles);
    });
  }, [serverId, refresh]);

  const login = useCallback(
    async (profileId: string): Promise<ProfileLoginResponse | { error: string }> => {
      const conn = serverId ? connectionManager.getConnection(serverId) : null;
      if (!conn || !conn.isConnected()) return { error: 'Not connected' };
      try {
        const r = await conn.sendRequest('profile_login', { profileId }, 20000);
        if (r.success && r.payload) return r.payload as ProfileLoginResponse;
        return { error: r.error ?? 'Could not start the login' };
      } catch (e) {
        return { error: String(e) };
      }
    },
    [serverId],
  );

  return {
    profiles,
    hasExtra: profiles.some((p) => !p.isDefault),
    supported,
    error,
    refresh,
    login,
  };
}
