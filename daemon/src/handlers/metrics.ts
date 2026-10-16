import { HandlerContext, MessageHandler } from '../handler-context';
import { getMetrics } from '../metrics';
import { getImpactReport } from '../impact';

export function registerMetricsHandlers(ctx: HandlerContext): Record<string, MessageHandler> {
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

    /** Impact report (CPU, memory, loop lag, subprocesses); read-only, no payload. */
    get_impact(client, _payload, requestId) {
      try {
        ctx.send(client.ws, {
          type: 'get_impact',
          success: true,
          payload: getImpactReport(),
          requestId,
        });
      } catch (err) {
        console.error('Impact: get_impact failed:', err);
        ctx.send(client.ws, { type: 'get_impact', success: false, error: String(err), requestId });
      }
    },
  };
}
