import { HandlerContext, MessageHandler } from '../handler-context';
import { getMetrics } from '../metrics';

export function registerMetricsHandlers(
  ctx: HandlerContext
): Record<string, MessageHandler> {
  return {
    get_metrics(client, _payload, requestId) {
      const activeClients = ctx.clients.size;
      const sessionsWatched = ctx.watcher.getSessions().length;
      const metrics = getMetrics(activeClients, sessionsWatched);

      ctx.send(client.ws, {
        type: 'metrics',
        success: true,
        payload: metrics,
        requestId,
      });
    },
  };
}
