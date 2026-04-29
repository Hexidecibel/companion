import { AnthropicUsageResponse, ApiUsageStats, DailyUsageBucket } from './types';

// Approximate pricing per million tokens (USD) - update as needed.
// 5-minute cache write rates. Source: docs.anthropic.com/en/docs/about-claude/pricing
const PRICING: Record<
  string,
  { input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
  // Current generation (base names returned by Admin API)
  'claude-opus-4-7': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  // Dated variants (kept for historical buckets)
  'claude-opus-4-6-20260210': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-5-20251101': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-sonnet-4-5-20250929': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-4-5-20251101': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-sonnet-4-20250514': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-3-5-sonnet-20241022': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-3-5-haiku-20241022': { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  'claude-3-opus-20240229': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-3-sonnet-20240229': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25, cacheWrite: 0.3, cacheRead: 0.03 },
};

// Strip a trailing -YYYYMMDD date suffix from a model id so we can compare family-version segments.
function stripDateSuffix(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

// Track which unknown models we've already warned about so logs aren't spammed.
const warnedUnknownModels = new Set<string>();

function getModelPricing(model: string): {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
} {
  // 1. Exact match
  if (PRICING[model]) return PRICING[model];

  // 2. Bidirectional family-version match.
  // Compare segments after stripping any trailing -YYYYMMDD suffix on either side.
  // e.g. "claude-opus-4-7-20260301" -> ["claude","opus","4","7"] matches
  //      "claude-opus-4-7"          -> ["claude","opus","4","7"]
  const modelSegs = stripDateSuffix(model).split('-');
  for (const [key, value] of Object.entries(PRICING)) {
    const keySegs = stripDateSuffix(key).split('-');
    if (modelSegs.length !== keySegs.length) continue;
    let matches = true;
    for (let i = 0; i < keySegs.length; i++) {
      if (modelSegs[i] !== keySegs[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return value;
  }

  // 3. No match — log once and return zero rates so unknown models surface as
  // visibly $0 in the dashboard rather than silently undercharging at Sonnet rates.
  if (!warnedUnknownModels.has(model)) {
    warnedUnknownModels.add(model);
    console.warn(
      `[anthropic-usage] No pricing entry for model "${model}" — cost will report as $0. ` +
        `Add it to PRICING in daemon/src/anthropic-usage.ts.`
    );
  }
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
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
        'User-Agent': 'Companion/1.0.0',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as AnthropicUsageResponse;

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

export async function fetchDailyUsageBuckets(
  adminApiKey: string,
  startDate: Date,
  endDate: Date
): Promise<DailyUsageBucket[]> {
  const bucketsByDate = new Map<string, DailyUsageBucket>();

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
        'User-Agent': 'Companion/1.0.0',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as AnthropicUsageResponse;

    for (const bucket of data.data) {
      const date = bucket.started_at.split('T')[0]; // YYYY-MM-DD
      const model = bucket.model || 'unknown';
      const uncachedInput = bucket.uncached_input_tokens || 0;
      const cacheCreation = bucket.cache_creation_input_tokens || 0;
      const cacheRead = bucket.cache_read_input_tokens || 0;
      const output = bucket.output_tokens || 0;
      const totalInput = uncachedInput + cacheCreation;

      const pricing = getModelPricing(model);
      const bucketCost =
        (uncachedInput / 1_000_000) * pricing.input +
        (cacheCreation / 1_000_000) * pricing.cacheWrite +
        (cacheRead / 1_000_000) * pricing.cacheRead +
        (output / 1_000_000) * pricing.output;

      let dayBucket = bucketsByDate.get(date);
      if (!dayBucket) {
        dayBucket = {
          date,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          estimatedCostUsd: 0,
          byModel: {},
        };
        bucketsByDate.set(date, dayBucket);
      }

      dayBucket.inputTokens += totalInput;
      dayBucket.outputTokens += output;
      dayBucket.cacheCreationTokens += cacheCreation;
      dayBucket.cacheReadTokens += cacheRead;
      dayBucket.estimatedCostUsd += bucketCost;

      if (!dayBucket.byModel[model]) {
        dayBucket.byModel[model] = {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          costUsd: 0,
        };
      }
      dayBucket.byModel[model].inputTokens += totalInput;
      dayBucket.byModel[model].outputTokens += output;
      dayBucket.byModel[model].cacheCreationTokens += cacheCreation;
      dayBucket.byModel[model].cacheReadTokens += cacheRead;
      dayBucket.byModel[model].costUsd += bucketCost;
    }

    hasMore = data.has_more;
    page = data.next_page;
  }

  // Round costs and sort by date
  const result = Array.from(bucketsByDate.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((bucket) => ({
      ...bucket,
      estimatedCostUsd: Math.round(bucket.estimatedCostUsd * 100) / 100,
      byModel: Object.fromEntries(
        Object.entries(bucket.byModel).map(([model, data]) => [
          model,
          { ...data, costUsd: Math.round(data.costUsd * 100) / 100 },
        ])
      ),
    }));

  return result;
}
