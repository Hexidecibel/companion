import { DaemonPool } from '../daemon-client';
import {
  CapabilityDisabled,
  DaemonRequestFailed,
  TransportInsecure,
} from '../errors';

interface DaemonResponse {
  success: boolean;
  payload?: unknown;
  error?: string;
}

export async function remoteCancel(
  pool: DaemonPool,
  args: { server: string; sessionId: string }
): Promise<unknown> {
  const client = pool.get(args.server);
  await client.ensureConnected();
  client.requireCapability('dispatch');

  const response = await client.sendRequest<DaemonResponse>('cancel_input', {
    sessionId: args.sessionId,
  });

  if (!response.success) {
    // Daemon encodes the machine-readable code in `response.error`. Details
    // (such as `detail`) come in `response.payload`.
    const code = response.error || 'unknown_error';
    const payload = (response.payload || {}) as { detail?: string };

    if (code === 'capability_disabled') {
      throw new CapabilityDisabled('dispatch', args.server);
    }
    if (code === 'transport_insecure') {
      throw new TransportInsecure(args.server);
    }
    const message = payload.detail ? `${code}: ${payload.detail}` : code;
    throw new DaemonRequestFailed('cancel_input', message);
  }
  return response.payload;
}
