import { AuthenticatedClient, HandlerContext, MessageHandler } from '../handler-context';
import { HeraldRequestError } from '../herald/service';
import type { AuditOrigin } from '../audit-log';

/**
 * Herald WS endpoints. Each request is answered with a response of the SAME type
 * as the request ({ type, success, payload | error, requestId }). Streaming replies
 * and state changes arrive separately as global `herald_event` pushes.
 */

function auditOrigin(ctx: HandlerContext, client: AuthenticatedClient): AuditOrigin {
  const listener = ctx.config.listeners.find((l) => l.port === client.listenerPort);
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addr: ((client.ws as any)?._socket?.remoteAddress as string | undefined) || '',
    clientId: client.id,
    isLocal: client.isLocal,
    tls: Boolean(listener?.tls),
    origin: client.origin,
  };
}

export function registerHeraldHandlers(ctx: HandlerContext): Record<string, MessageHandler> {
  const reply = (
    client: AuthenticatedClient,
    type: string,
    requestId: string | undefined,
    run: () => unknown | Promise<unknown>
  ) =>
    (async () => {
      if (!ctx.herald) {
        ctx.send(client.ws, {
          type,
          success: false,
          error: 'Herald is not available on this daemon',
          requestId,
        });
        return;
      }
      try {
        const payload = await run();
        ctx.send(client.ws, { type, success: true, payload, requestId });
      } catch (err) {
        const known =
          err instanceof HeraldRequestError ||
          (err instanceof Error && err.message === 'Unknown action');
        if (!known) console.error(`Herald: ${type} failed:`, err);
        ctx.send(client.ws, {
          type,
          success: false,
          error: known ? (err as Error).message : `Internal error handling ${type}`,
          requestId,
        });
      }
    })();

  return {
    herald_get_state(client, _payload, requestId) {
      return reply(client, 'herald_get_state', requestId, () => ctx.herald!.getState());
    },

    herald_send(client, payload, requestId) {
      return reply(client, 'herald_send', requestId, () =>
        ctx.herald!.send((payload as { text?: unknown } | undefined)?.text)
      );
    },

    herald_confirm(client, payload, requestId) {
      const p = (payload || {}) as { actionId?: unknown; decision?: unknown };
      return reply(client, 'herald_confirm', requestId, () =>
        ctx.herald!.confirm(p.actionId, p.decision, auditOrigin(ctx, client))
      );
    },

    herald_mark_heard(client, payload, requestId) {
      return reply(client, 'herald_mark_heard', requestId, () => {
        const ids = (payload as { itemIds?: unknown } | undefined)?.itemIds;
        if (!Array.isArray(ids))
          throw new HeraldRequestError('itemIds must be an array of strings');
        ctx.herald!.markHeard(ids as string[]);
        return { ok: true };
      });
    },

    herald_reset(client, _payload, requestId) {
      return reply(client, 'herald_reset', requestId, () => ctx.herald!.reset());
    },
  };
}
