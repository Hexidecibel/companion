import { DaemonPool } from '../daemon-client';
import { DaemonRequestFailed } from '../errors';

interface DaemonResponse {
  success: boolean;
  payload?: unknown;
  error?: string;
}

export interface RemoteSession {
  id: string;
  name?: string;
  projectPath?: string;
  isWaitingForInput?: boolean;
  lastActivity?: number;
}

interface GetSessionsPayload {
  sessions?: RemoteSession[];
  activeSessionId?: string;
}

export interface RemoteListSessionsResult {
  server: string;
  cwd: string | null;
  resolved: string | null;
  sessions: RemoteSession[];
  activeSessionId?: string;
}

function normalizeCwd(cwd: string): string {
  // Strip trailing slashes (but keep a bare root "/" as "/").
  const trimmed = cwd.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

export async function remoteListSessions(
  pool: DaemonPool,
  args: { server: string; cwd?: string }
): Promise<RemoteListSessionsResult> {
  const client = pool.get(args.server);
  const response = await client.sendRequest<DaemonResponse>('get_sessions');

  if (!response.success) {
    throw new DaemonRequestFailed('get_sessions', response.error || 'unknown error');
  }

  const payload = (response.payload || {}) as GetSessionsPayload;
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];

  if (args.cwd === undefined) {
    return {
      server: args.server,
      cwd: null,
      resolved: null,
      sessions,
      activeSessionId: payload.activeSessionId,
    };
  }

  const targetCwd = normalizeCwd(args.cwd);
  const matching = sessions
    .filter((s) => s.projectPath !== undefined && normalizeCwd(s.projectPath) === targetCwd)
    // Newest first by lastActivity (undefined treated as oldest).
    .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));

  const resolved = matching.length > 0 ? matching[0].id : null;

  return {
    server: args.server,
    cwd: targetCwd,
    resolved,
    sessions,
    activeSessionId: payload.activeSessionId,
  };
}
