import { AuthenticatedClient, HandlerContext, MessageHandler } from '../handler-context';

/**
 * Code Review endpoints. Each request is answered with a response of the SAME
 * type ({ type, success, payload | error, requestId }); failures carry
 * `payload: { code: ReviewErrorCode }`. `get_session_diff` is the legacy shape
 * (response type `session_diff`), rebuilt on the ledger + one bounded git diff.
 */
export function registerReviewHandlers(ctx: HandlerContext): Record<string, MessageHandler> {
  const fail = (
    client: AuthenticatedClient,
    type: string,
    code: string,
    error: string,
    requestId?: string
  ) => ctx.send(client.ws, { type, success: false, error, payload: { code }, requestId });

  return {
    async get_session_diff(client, payload, requestId) {
      const p = payload as { sessionId?: string } | undefined;
      const sessionId = p?.sessionId || ctx.watcher.getActiveSessionId();
      if (!sessionId) {
        ctx.send(client.ws, {
          type: 'session_diff',
          success: false,
          error: 'No session specified',
          requestId,
        });
        return;
      }
      if (!ctx.review) {
        fail(client, 'session_diff', 'unavailable', 'Code review is not available', requestId);
        return;
      }
      try {
        const fileChanges = await ctx.review.compatSessionDiff(sessionId);
        ctx.send(client.ws, {
          type: 'session_diff',
          success: true,
          payload: { fileChanges, sessionId },
          requestId,
        });
      } catch (err) {
        ctx.send(client.ws, {
          type: 'session_diff',
          success: false,
          error: `Failed to get session diff: ${err}`,
          requestId,
        });
      }
    },
  };
}
