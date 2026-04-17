import { DaemonPool } from '../daemon-client';
import {
  CapabilityDisabled,
  ClaudeNotFound,
  DaemonRequestFailed,
  InvalidCwd,
  TransportInsecure,
} from '../errors';

interface DaemonResponse {
  success: boolean;
  payload?: unknown;
  error?: string;
}

interface DispatchPayload {
  tmuxSessionName: string;
  createdAt: number;
  sessionId: string | null;
  claudePath: string;
}

export interface RemoteDispatchResult {
  server: string;
  tmuxSessionName: string;
  sessionId: string | null;
  createdAt: number;
  claudePath: string;
}

export async function remoteDispatch(
  pool: DaemonPool,
  args: { server: string; prompt: string; cwd: string; sessionName?: string }
): Promise<RemoteDispatchResult> {
  const client = pool.get(args.server);
  await client.ensureConnected();
  client.requireCapability('dispatch');

  const response = await client.sendRequest<DaemonResponse>(
    'remote_dispatch_spawn',
    {
      prompt: args.prompt,
      cwd: args.cwd,
      sessionName: args.sessionName,
    }
  );

  if (!response.success) {
    // Daemon encodes the machine-readable code in `response.error`. Details
    // (searchedPath, cwd, detail) come in `response.payload`.
    const code = response.error || 'unknown_error';
    const payload = (response.payload || {}) as {
      searchedPath?: string;
      cwd?: string;
      detail?: string;
    };

    if (code === 'capability_disabled') {
      throw new CapabilityDisabled('dispatch', args.server);
    }
    if (code === 'transport_insecure') {
      throw new TransportInsecure(args.server);
    }
    if (code === 'claude_not_found') {
      throw new ClaudeNotFound(args.server, payload.searchedPath);
    }
    if (code === 'invalid_cwd') {
      throw new InvalidCwd(args.server, payload.cwd ?? args.cwd, payload.detail);
    }
    // invalid_payload, tmux_create_failed, and any other code.
    const message = payload.detail ? `${code}: ${payload.detail}` : code;
    throw new DaemonRequestFailed('remote_dispatch_spawn', message);
  }

  const payload = response.payload as DispatchPayload;
  return {
    server: args.server,
    tmuxSessionName: payload.tmuxSessionName,
    sessionId: payload.sessionId,
    createdAt: payload.createdAt,
    claudePath: payload.claudePath,
  };
}
