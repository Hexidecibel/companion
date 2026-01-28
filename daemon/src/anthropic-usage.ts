import { AnthropicUsageResponse, ApiUsageStats } from './types';

// Approximate pricing per million tokens (USD) - update as needed
const PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-opus-4-5-20251101': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-sonnet-4-5-20251101': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-4-20250514': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-3-5-sonnet-20241022': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-3-5-haiku-20241022': { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  'claude-3-opus-20240229': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-3-sonnet-20240229': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25, cacheWrite: 0.3, cacheRead: 0.03 },
};

function getModelPricing(model: string): { input: number; output: number; cacheWrite: number; cacheRead: number } {
  // Try exact match first
  if (PRICING[model]) return PRICING[model];

  // Try partial match (model names often have date suffixes)
  for (const [key, value] of Object.entries(PRICING)) {
    if (model.includes(key.split('-').slice(0, -1).join('-'))) {
      return value;
    }
  }

  // Default to Sonnet pricing as fallback
  return { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };
}

export async function fetchAnthropicUsage(
  adminApiKey: string,
  startDate: Date,
  endDate: Date
): Promise<ApiUsageStats> {
  const stats: ApiUsageStats = {
    periodStart: startDate.toISOString(),
    periodEnd: endDate.toISOString(),
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    byModel: {},
    estimatedCostUsd: 0,
  };

  let hasMore = true;
  let page: string | undefined;

  while (hasMore) {
    const url = new URL('https://api.anthropic.com/v1/organizations/usage_report/messages');
    url.searchParams.set('starting_at', startDate.toISOString());
    url.searchParams.set('ending_at', endDate.toISOString());
    url.searchParams.set('bucket_width', '1d');
    url.searchParams.set('group_by[]', 'model');
    if (page) {
      url.searchParams.set('page', page);
    }

    const response = await fetch(url.toString(), {
      headers: {
        'anthropic-version': '2023-06-01',
        'x-api-key': adminApiKey,
        'User-Agent': 'ClaudeCompanion/1.0.0',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as AnthropicUsageResponse;

    for (const bucket of data.data) {
      const model = bucket.model || 'unknown';
      const uncachedInput = bucket.uncached_input_tokens || 0;
      const cacheCreation = bucket.cache_creation_input_tokens || 0;
      const cacheRead = bucket.cache_read_input_tokens || 0;
      const output = bucket.output_tokens || 0;

      // Total input = uncached + cache creation (cache reads are "free" comparatively)
      const totalInput = uncachedInput + cacheCreation;

      stats.totalInputTokens += totalInput;
      stats.totalOutputTokens += output;
      stats.totalCacheCreationTokens += cacheCreation;
      stats.totalCacheReadTokens += cacheRead;

      if (!stats.byModel[model]) {
        stats.byModel[model] = {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        };
      }
      stats.byModel[model].inputTokens += totalInput;
      stats.byModel[model].outputTokens += output;
      stats.byModel[model].cacheCreationTokens += cacheCreation;
      stats.byModel[model].cacheReadTokens += cacheRead;

      // Calculate cost
      const pricing = getModelPricing(model);
      stats.estimatedCostUsd += (uncachedInput / 1_000_000) * pricing.input;
      stats.estimatedCostUsd += (cacheCreation / 1_000_000) * pricing.cacheWrite;
      stats.estimatedCostUsd += (cacheRead / 1_000_000) * pricing.cacheRead;
      stats.estimatedCostUsd += (output / 1_000_000) * pricing.output;
    }

    hasMore = data.has_more;
    page = data.next_page;
  }

  // Round cost to 2 decimal places
  stats.estimatedCostUsd = Math.round(stats.estimatedCostUsd * 100) / 100;

  return stats;
}

export async function fetchTodayUsage(adminApiKey: string): Promise<ApiUsageStats> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return fetchAnthropicUsage(adminApiKey, startOfDay, now);
}

export async function fetchMonthUsage(adminApiKey: string): Promise<ApiUsageStats> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  return fetchAnthropicUsage(adminApiKey, startOfMonth, now);
}
