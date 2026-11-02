import { useCallback, useEffect, useState } from 'react';
import { connectionManager } from '../services/ConnectionManager';
import type {
  AccountProfileInfo,
  ProfileLoginFlow,
  ProfileLoginResponse,
  ProfileLoginStatusResponse,
  ProfileLoginUpdate,
  ProfilesListResponse,
} from '../types/profiles';
import { PROFILE_LOGIN_UPDATE_EVENT, PROFILES_CHANGED_EVENT } from '../types/profiles';

export interface UseProfilesResult {
  profiles: AccountProfileInfo[];
  /** More than the two default profiles exist (the UI shows profile choices only then). */
  hasExtra: boolean;
  /** false = the daemon predates profiles. */
  supported: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  login: (profileId: string) => Promise<ProfileLoginResponse | { error: string }>;
  /** Login flows by profile id: running, or recently ended. */
  loginFlows: Record<string, ProfileLoginFlow>;
  submitLoginCode: (profileId: string, code: string) => Promise<{ error?: string }>;
  cancelLogin: (profileId: string) => Promise<{ error?: string }>;
}

/** Account profiles of one server (`profiles_list`, live via `profiles_changed`). */
export function useProfiles(serverId: string | null | undefined): UseProfilesResult {
  const [profiles, setProfiles] = useState<AccountProfileInfo[]>([]);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loginFlows, setLoginFlows] = useState<Record<string, ProfileLoginFlow>>({});

  const applyFlow = useCallback((flow: ProfileLoginFlow) => {
    setLoginFlows((prev) => ({ ...prev, [flow.profileId]: flow }));
  }, []);

  /** Restores a login after the socket dropped or the app reloaded. */
  const refreshFlows = useCallback(async () => {
    const conn = serverId ? connectionManager.getConnection(serverId) : null;
    if (!conn || !conn.isConnected()) return;
    try {
      const r = await conn.sendRequest('profile_login_status', {}, 10000);
      if (!r.success || !r.payload) return; // older daemon, or not allowed
      const next: Record<string, ProfileLoginFlow> = {};
      for (const f of (r.payload as ProfileLoginStatusResponse).flows ?? []) next[f.profileId] = f;
      setLoginFlows(next);
    } catch {
      /* the next reconnect retries */
    }
  }, [serverId]);

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
    void refreshFlows();
    if (!serverId) return;
    const conn = connectionManager.getConnection(serverId);
    if (!conn) return;
    const offMessage = conn.onMessage((msg) => {
      if (msg.type === PROFILE_LOGIN_UPDATE_EVENT) {
        const u = msg.payload as ProfileLoginUpdate | undefined;
        if (u?.flow) applyFlow(u.flow);
        return;
      }
      if (msg.type !== PROFILES_CHANGED_EVENT) return;
      const p = msg.payload as ProfilesListResponse | undefined;
      if (p && Array.isArray(p.profiles)) setProfiles(p.profiles);
    });
    const offReconnect = conn.onReconnect(() => {
      void refresh();
      void refreshFlows();
    });
    return () => {
      offMessage();
      offReconnect();
    };
  }, [serverId, refresh, refreshFlows, applyFlow]);

  const login = useCallback(
    async (profileId: string): Promise<ProfileLoginResponse | { error: string }> => {
      const conn = serverId ? connectionManager.getConnection(serverId) : null;
      if (!conn || !conn.isConnected()) return { error: 'Not connected' };
      try {
        const r = await conn.sendRequest('profile_login', { profileId }, 20000);
        if (r.success && r.payload) {
          const out = r.payload as ProfileLoginResponse;
          if (out.flow) applyFlow(out.flow);
          return out;
        }
        return { error: r.error ?? 'Could not start the login' };
      } catch (e) {
        return { error: String(e) };
      }
    },
    [serverId, applyFlow],
  );

  const flowRequest = useCallback(
    async (type: string, payload: object): Promise<{ error?: string }> => {
      const conn = serverId ? connectionManager.getConnection(serverId) : null;
      if (!conn || !conn.isConnected()) return { error: 'Not connected' };
      try {
        const r = await conn.sendRequest(type, payload, 20000);
        if (r.success && r.payload) {
          const flow = (r.payload as ProfileLoginResponse).flow;
          if (flow) applyFlow(flow);
          return {};
        }
        return { error: r.error ?? 'The request failed' };
      } catch {
        return { error: 'The request failed' };
      }
    },
    [serverId, applyFlow],
  );

  const submitLoginCode = useCallback(
    (profileId: string, code: string) => flowRequest('profile_login_code', { profileId, code }),
    [flowRequest],
  );
  const cancelLogin = useCallback(
    (profileId: string) => flowRequest('profile_login_cancel', { profileId }),
    [flowRequest],
  );

  return {
    profiles,
    hasExtra: profiles.some((p) => !p.isDefault),
    supported,
    error,
    refresh,
    login,
    loginFlows,
    submitLoginCode,
    cancelLogin,
  };
}
