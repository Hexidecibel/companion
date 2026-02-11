import { CostDashboardData, DailyUsageBucket } from './types';
import { fetchDailyUsageBuckets } from './anthropic-usage';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

type Period = '7d' | '30d';

interface CacheEntry {
  data: CostDashboardData;
  fetchedAt: number;
}

export class UsageTracker {
  private adminApiKey?: string;
  private cache = new Map<string, CacheEntry>();

  constructor(adminApiKey?: string) {
    this.adminApiKey = adminApiKey;
  }

  async getCostDashboard(period: Period = '7d'): Promise<CostDashboardData> {
    if (!this.adminApiKey) {
      return {
        daily: [],
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
        periodStart: new Date().toISOString(),
        periodEnd: new Date().toISOString(),
        hasAdminKey: false,
      };
    }

    const cached = this.cache.get(period);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.data;
    }

    const now = new Date();
    const days = period === '30d' ? 30 : 7;
    const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const daily = await fetchDailyUsageBuckets(this.adminApiKey, startDate, now);
    const data = this.buildDashboardData(daily, startDate, now);

    this.cache.set(period, { data, fetchedAt: Date.now() });
    return data;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private buildDashboardData(
    daily: DailyUsageBucket[],
    startDate: Date,
    endDate: Date
  ): CostDashboardData {
    let totalCostUsd = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheCreationTokens = 0;
    let totalCacheReadTokens = 0;

    for (const day of daily) {
      totalCostUsd += day.estimatedCostUsd;
      totalInputTokens += day.inputTokens;
      totalOutputTokens += day.outputTokens;
      totalCacheCreationTokens += day.cacheCreationTokens;
      totalCacheReadTokens += day.cacheReadTokens;
    }

    return {
      daily,
      totalCostUsd: Math.round(totalCostUsd * 100) / 100,
      totalInputTokens,
      totalOutputTokens,
      totalCacheCreationTokens,
      totalCacheReadTokens,
      periodStart: startDate.toISOString(),
      periodEnd: endDate.toISOString(),
      hasAdminKey: true,
    };
  }
}
