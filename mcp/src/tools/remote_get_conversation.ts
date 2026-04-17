import { DaemonPool } from '../daemon-client';
import { DaemonRequestFailed } from '../errors';

interface DaemonResponse {
  success: boolean;
  payload?: unknown;
  error?: string;
  sessionId?: string;
}

export type ConversationMode = 'highlights' | 'full';

export async function remoteGetConversation(
  pool: DaemonPool,
  args: { server: string; sessionId: string; mode?: ConversationMode }
): Promise<unknown> {
  const mode: ConversationMode = args.mode ?? 'highlights';
  const type = mode === 'full' ? 'get_full' : 'get_highlights';

  const client = pool.get(args.server);
  const response = await client.sendRequest<DaemonResponse>(type, {
    sessionId: args.sessionId,
  });

  if (!response.success) {
    throw new DaemonRequestFailed(type, response.error || 'unknown error');
  }
  return response.payload;
}
