import { UsageTracker } from '../src/usage-tracker';
import { fetchDailyUsageBuckets } from '../src/anthropic-usage';
import { DailyUsageBucket } from '../src/types';

jest.mock('../src/anthropic-usage');

const mockFetchDailyBuckets = fetchDailyUsageBuckets as jest.MockedFunction<
  typeof fetchDailyUsageBuckets
>;

function makeDailyBuckets(): DailyUsageBucket[] {
  return [
    {
      date: '2026-02-08',
      inputTokens: 50000,
      outputTokens: 25000,
      cacheCreationTokens: 10000,
      cacheReadTokens: 5000,
      estimatedCostUsd: 0.63,
      byModel: {
        'claude-sonnet-4-5-20251101': {
          inputTokens: 50000,
          outputTokens: 25000,
          cacheCreationTokens: 10000,
          cacheReadTokens: 5000,
          costUsd: 0.63,
        },
      },
    },
    {
      date: '2026-02-09',
      inputTokens: 50000,
      outputTokens: 25000,
      cacheCreationTokens: 10000,
      cacheReadTokens: 5000,
      estimatedCostUsd: 0.62,
      byModel: {
        'claude-sonnet-4-5-20251101': {
          inputTokens: 50000,
          outputTokens: 25000,
          cacheCreationTokens: 10000,
          cacheReadTokens: 5000,
          costUsd: 0.62,
        },
      },
    },
  ];
}

describe('UsageTracker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-02-10T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('constructor', () => {
    it('should create without admin key', () => {
      const tracker = new UsageTracker();
      expect(tracker).toBeDefined();
    });

    it('should create with admin key', () => {
      const tracker = new UsageTracker('sk-ant-admin-test');
      expect(tracker).toBeDefined();
    });
  });

  describe('getCostDashboard', () => {
    it('should return data indicating no admin key when none configured', async () => {
      const tracker = new UsageTracker();
      const result = await tracker.getCostDashboard();

      expect(result.hasAdminKey).toBe(false);
      expect(result.daily).toEqual([]);
      expect(result.totalCostUsd).toBe(0);
    });

    it('should fetch and return daily usage data with admin key', async () => {
      mockFetchDailyBuckets.mockResolvedValue(makeDailyBuckets());

      const tracker = new UsageTracker('sk-ant-admin-test');
      const result = await tracker.getCostDashboard();

      expect(result.hasAdminKey).toBe(true);
      expect(result.totalCostUsd).toBe(1.25);
      expect(result.totalInputTokens).toBe(100000);
      expect(result.totalOutputTokens).toBe(50000);
      expect(result.daily).toHaveLength(2);
      expect(result.daily[0].date).toBe('2026-02-08');
      expect(result.daily[1].date).toBe('2026-02-09');
      expect(mockFetchDailyBuckets).toHaveBeenCalledWith(
        'sk-ant-admin-test',
        expect.any(Date),
        expect.any(Date)
      );
    });

    it('should support 30d period', async () => {
      mockFetchDailyBuckets.mockResolvedValue(makeDailyBuckets());

      const tracker = new UsageTracker('sk-ant-admin-test');
      await tracker.getCostDashboard('30d');

      const call = mockFetchDailyBuckets.mock.calls[0];
      const startDate = call[1] as Date;
      // 30 days back from 2026-02-10
      expect(startDate.getDate()).toBe(11); // Jan 11
      expect(startDate.getMonth()).toBe(0); // January
    });

    it('should default to 7d period', async () => {
      mockFetchDailyBuckets.mockResolvedValue(makeDailyBuckets());

      const tracker = new UsageTracker('sk-ant-admin-test');
      await tracker.getCostDashboard();

      const call = mockFetchDailyBuckets.mock.calls[0];
      const startDate = call[1] as Date;
      // 7 days back from 2026-02-10
      expect(startDate.getDate()).toBe(3); // Feb 3
      expect(startDate.getMonth()).toBe(1); // February
    });

    it('should cache results for subsequent calls with same period', async () => {
      mockFetchDailyBuckets.mockResolvedValue(makeDailyBuckets());

      const tracker = new UsageTracker('sk-ant-admin-test');
      await tracker.getCostDashboard();
      await tracker.getCostDashboard();

      expect(mockFetchDailyBuckets).toHaveBeenCalledTimes(1);
    });

    it('should not cache across different periods', async () => {
      mockFetchDailyBuckets.mockResolvedValue(makeDailyBuckets());

      const tracker = new UsageTracker('sk-ant-admin-test');
      await tracker.getCostDashboard('7d');
      await tracker.getCostDashboard('30d');

      expect(mockFetchDailyBuckets).toHaveBeenCalledTimes(2);
    });

    it('should re-fetch after cache expires', async () => {
      mockFetchDailyBuckets.mockResolvedValue(makeDailyBuckets());

      const tracker = new UsageTracker('sk-ant-admin-test');
      await tracker.getCostDashboard();

      // Advance time past cache TTL (5 minutes)
      jest.advanceTimersByTime(6 * 60 * 1000);

      await tracker.getCostDashboard();
      expect(mockFetchDailyBuckets).toHaveBeenCalledTimes(2);
    });

    it('should handle API errors gracefully', async () => {
      mockFetchDailyBuckets.mockRejectedValue(new Error('API rate limited'));

      const tracker = new UsageTracker('sk-ant-admin-test');
      await expect(tracker.getCostDashboard()).rejects.toThrow('API rate limited');
    });
  });

  describe('clearCache', () => {
    it('should force re-fetch after clearing cache', async () => {
      mockFetchDailyBuckets.mockResolvedValue(makeDailyBuckets());

      const tracker = new UsageTracker('sk-ant-admin-test');
      await tracker.getCostDashboard();
      tracker.clearCache();
      await tracker.getCostDashboard();

      expect(mockFetchDailyBuckets).toHaveBeenCalledTimes(2);
    });
  });
});
