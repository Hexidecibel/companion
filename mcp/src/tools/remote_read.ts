import { DaemonPool } from '../daemon-client';
import { DaemonRequestFailed } from '../errors';

interface DaemonResponse {
  success: boolean;
  payload?: unknown;
  error?: string;
}

export async function remoteRead(
  pool: DaemonPool,
  args: { server: string; path: string }
): Promise<unknown> {
  const client = pool.get(args.server);
  const response = await client.sendRequest<DaemonResponse>('read_file', {
    path: args.path,
  });

  if (!response.success) {
    throw new DaemonRequestFailed('read_file', response.error || 'unknown error');
  }
  return response.payload;
}
