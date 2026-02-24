import { HandlerContext, MessageHandler } from '../handler-context';
import { extractUsageFromFile } from '../parser';
import { fetchTodayUsage, fetchMonthUsage, fetchAnthropicUsage } from '../anthropic-usage';
import { DEFAULT_DIGEST_PERIOD_MS } from '../constants';

export function registerUsageHandlers(
  ctx: HandlerContext
): Record<string, MessageHandler> {
  return {
    get_usage(client, _payload, requestId) {
      try {
        const sessions = ctx.watcher.getSessions();
        const sessionUsages = [];

        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalCacheCreationTokens = 0;
        let totalCacheReadTokens = 0;

        for (const session of sessions) {
          if (session.conversationPath) {
            const usage = extractUsageFromFile(session.conversationPath, session.name);
            sessionUsages.push(usage);

            totalInputTokens += usage.totalInputTokens;
            totalOutputTokens += usage.totalOutputTokens;
            totalCacheCreationTokens += usage.totalCacheCreationTokens;
            totalCacheReadTokens += usage.totalCacheReadTokens;
          }
        }

        ctx.send(client.ws, {
          type: 'usage',
          success: true,
          payload: {
            sessions: sessionUsages,
            totalInputTokens,
            totalOutputTokens,
            totalCacheCreationTokens,
            totalCacheReadTokens,
            periodStart: Date.now() - DEFAULT_DIGEST_PERIOD_MS,
            periodEnd: Date.now(),
          },
          requestId,
        });
      } catch (err) {
        console.error('Failed to get usage:', err);
        ctx.send(client.ws, {
          type: 'usage',
          success: false,
          error: 'Failed to get usage statistics',
          requestId,
        });
      }
    },

    async get_api_usage(client, payload, requestId) {
      const apiPayload = payload as {
        period?: 'today' | 'month' | 'custom';
        startDate?: string;
        endDate?: string;
      } | undefined;

      const adminApiKey = ctx.config.anthropicAdminApiKey;

      if (!adminApiKey) {
        ctx.send(client.ws, {
          type: 'api_usage',
          success: false,
          error:
            'No Anthropic Admin API key configured. Add "anthropicAdminApiKey" to your config.json (key starts with sk-ant-admin-...)',
          requestId,
        });
        return;
      }

      try {
        const period = apiPayload?.period || 'today';
        let stats;

        if (period === 'today') {
          stats = await fetchTodayUsage(adminApiKey);
        } else if (period === 'month') {
          stats = await fetchMonthUsage(adminApiKey);
        } else if (period === 'custom' && apiPayload?.startDate && apiPayload?.endDate) {
          stats = await fetchAnthropicUsage(
            adminApiKey,
            new Date(apiPayload.startDate),
            new Date(apiPayload.endDate)
          );
        } else {
          stats = await fetchTodayUsage(adminApiKey);
        }

        ctx.send(client.ws, {
          type: 'api_usage',
          success: true,
          payload: stats,
          requestId,
        });
      } catch (err) {
        console.error('Failed to get API usage:', err);
        ctx.send(client.ws, {
          type: 'api_usage',
          success: false,
          error: `Failed to fetch API usage: ${err instanceof Error ? err.message : 'Unknown error'}`,
          requestId,
        });
      }
    },

    async get_cost_dashboard(client, payload, requestId) {
      const dashPayload = payload as { period?: '7d' | '30d' } | undefined;
      try {
        const period = dashPayload?.period || '7d';
        const data = await ctx.usageTracker.getCostDashboard(period);
        ctx.send(client.ws, {
          type: 'cost_dashboard',
          success: true,
          payload: data,
          requestId,
        });
      } catch (err) {
        console.error('Failed to get cost dashboard:', err);
        ctx.send(client.ws, {
          type: 'cost_dashboard',
          success: false,
          error: `Failed to fetch cost dashboard: ${err instanceof Error ? err.message : 'Unknown error'}`,
          requestId,
        });
      }
    },

    async get_oauth_usage(client, _payload, requestId) {
      try {
        const data = await ctx.oauthUsageFetcher.getUsage();
        ctx.send(client.ws, {
          type: 'oauth_usage',
          success: true,
          payload: data,
          requestId,
        });
      } catch (err) {
        console.error('Failed to get OAuth usage:', err);
        ctx.send(client.ws, {
          type: 'oauth_usage',
          success: false,
          error: `Failed to fetch OAuth usage: ${err instanceof Error ? err.message : 'Unknown error'}`,
          requestId,
        });
      }
    },
  };
}
