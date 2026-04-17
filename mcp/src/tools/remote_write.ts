import { DaemonPool } from '../daemon-client';
import {
  CapabilityDisabled,
  DaemonRequestFailed,
  InvalidPath,
  RateLimited,
  TransportInsecure,
} from '../errors';

interface DaemonResponse {
  success: boolean;
  payload?: unknown;
  error?: string;
}

interface WriteSuccessPayload {
  path: string;
  bytesWritten: number;
}

export interface RemoteWriteResult {
  server: string;
  path: string;
  bytesWritten: number;
}

export async function remoteWrite(
  pool: DaemonPool,
  args: {
    server: string;
    path: string;
    content: string;
    encoding?: 'utf8' | 'base64';
    createDirs?: boolean;
  }
): Promise<RemoteWriteResult> {
  const client = pool.get(args.server);
  await client.ensureConnected();
  client.requireCapability('write');

  const response = await client.sendRequest<DaemonResponse>('write_file', {
    path: args.path,
    content: args.content,
    encoding: args.encoding,
    createDirs: args.createDirs,
  });

  if (!response.success) {
    const code = response.error || 'unknown_error';
    const payload = (response.payload || {}) as {
      retryAfterMs?: number;
      path?: string;
      reason?: string;
      detail?: string;
    };

    if (code === 'capability_disabled') {
      throw new CapabilityDisabled('write', args.server);
    }
    if (code === 'transport_insecure') {
      throw new TransportInsecure(args.server);
    }
    if (code === 'rate_limited') {
      throw new RateLimited(args.server, payload.retryAfterMs);
    }
    if (code === 'invalid_path') {
      throw new InvalidPath(args.server, payload.path ?? args.path, payload.reason);
    }
    const message = payload.detail ? `${code}: ${payload.detail}` : code;
    throw new DaemonRequestFailed('write_file', message);
  }

  const payload = response.payload as WriteSuccessPayload;
  return {
    server: args.server,
    path: payload.path,
    bytesWritten: payload.bytesWritten,
  };
}
