import { DaemonPool } from '../daemon-client';
import {
  CapabilityDisabled,
  CommandBlocked,
  DaemonRequestFailed,
  InvalidCwd,
  RateLimited,
  TransportInsecure,
} from '../errors';

interface DaemonResponse {
  success: boolean;
  payload?: unknown;
  error?: string;
}

interface ExecSuccessPayload {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  signal: string | null;
}

export interface RemoteExecResult {
  server: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  signal: string | null;
}

export async function remoteExec(
  pool: DaemonPool,
  args: { server: string; command: string; cwd?: string; timeout?: number }
): Promise<RemoteExecResult> {
  const client = pool.get(args.server);
  await client.ensureConnected();
  client.requireCapability('exec');

  const response = await client.sendRequest<DaemonResponse>('exec_command', {
    command: args.command,
    cwd: args.cwd,
    timeout: args.timeout,
  });

  if (!response.success) {
    const code = response.error || 'unknown_error';
    const payload = (response.payload || {}) as {
      retryAfterMs?: number;
      cwd?: string;
      command?: string;
      detail?: string;
    };

    if (code === 'capability_disabled') {
      throw new CapabilityDisabled('exec', args.server);
    }
    if (code === 'transport_insecure') {
      throw new TransportInsecure(args.server);
    }
    if (code === 'rate_limited') {
      throw new RateLimited(args.server, payload.retryAfterMs);
    }
    if (code === 'invalid_cwd') {
      throw new InvalidCwd(args.server, payload.cwd ?? args.cwd ?? '', payload.detail);
    }
    if (code === 'command_blocked') {
      throw new CommandBlocked(args.server, payload.command ?? args.command);
    }
    const message = payload.detail ? `${code}: ${payload.detail}` : code;
    throw new DaemonRequestFailed('exec_command', message);
  }

  const payload = response.payload as ExecSuccessPayload;
  return {
    server: args.server,
    exitCode: payload.exitCode,
    stdout: payload.stdout,
    stderr: payload.stderr,
    truncated: payload.truncated,
    durationMs: payload.durationMs,
    signal: payload.signal,
  };
}
