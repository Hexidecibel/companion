import * as fs from 'fs';
import * as path from 'path';
import { UsageDashboardData, OAuthUsageWindow, OAuthExtraUsage } from './types';
import { NotificationStore } from './notification-store';
import { EscalationEvent } from './escalation';

interface OAuthCredentials {
  accessToken: string;
  subscriptionType?: string;
  rateLimitTier?: string;
}

interface ApiUsageResponse {
  five_hour: { utilization: number; resets_at: string } | null;
  seven_day: { utilization: number; resets_at: string } | null;
  seven_day_opus: { utilization: number; resets_at: string } | null;
  seven_day_sonnet: { utilization: number; resets_at: string } | null;
  seven_day_cowork: { utilization: number; resets_at: string } | null;
  extra_usage: {
    is_enabled: boolean;
    monthly_limit: number | null;
    used_credits: number | null;
    utilization: number | null;
  } | null;
}

const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

export class OAuthUsageFetcher {
  private codeHome: string;
  private cachedData: UsageDashboardData | null = null;
  private cacheTime = 0;

  constructor(codeHome: string) {
    this.codeHome = codeHome;
  }

  readCredentials(): OAuthCredentials | null {
    try {
      const credPath = path.join(this.codeHome, '.credentials.json');
      if (!fs.existsSync(credPath)) return null;
      const raw = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
      const oauth = raw?.claudeAiOauth;
      if (!oauth?.accessToken) return null;
      return {
        accessToken: oauth.accessToken,
        subscriptionType: oauth.subscriptionType,
        rateLimitTier: oauth.rateLimitTier,
      };
    } catch (err) {
      console.error('OAuthUsage: Failed to read credentials:', err);
      return null;
    }
  }

  async fetchUsage(): Promise<UsageDashboardData> {
    const creds = this.readCredentials();
    if (!creds) {
      return { available: false };
    }

    try {
      const resp = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          'Authorization': `Bearer ${creds.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
        },
      });

      if (!resp.ok) {
        console.error(`OAuthUsage: API returned ${resp.status}`);
        return { available: false };
      }

      const data = (await resp.json()) as ApiUsageResponse;
      return {
        available: true,
        subscriptionType: creds.subscriptionType,
        rateLimitTier: creds.rateLimitTier,
        fiveHour: data.five_hour as OAuthUsageWindow | null,
        sevenDay: data.seven_day as OAuthUsageWindow | null,
        sevenDayOpus: data.seven_day_opus as OAuthUsageWindow | null,
        sevenDaySonnet: data.seven_day_sonnet as OAuthUsageWindow | null,
        sevenDayCowork: data.seven_day_cowork as OAuthUsageWindow | null,
        extraUsage: data.extra_usage as OAuthExtraUsage | null,
      };
    } catch (err) {
      console.error('OAuthUsage: Fetch failed:', err);
      return { available: false };
    }
  }

  async getUsage(): Promise<UsageDashboardData> {
    const now = Date.now();
    if (this.cachedData && now - this.cacheTime < CACHE_TTL_MS) {
      return this.cachedData;
    }

    const data = await this.fetchUsage();
    // Only cache successful results; return stale data on error if available
    if (data.available) {
      this.cachedData = data;
      this.cacheTime = now;
    } else if (this.cachedData) {
      return this.cachedData;
    }
    return data;
  }
}

export class UsageMonitor {
  private fetcher: OAuthUsageFetcher;
  private store: NotificationStore;
  private onThresholdCrossed: (event: EscalationEvent) => void;
  private interval: NodeJS.Timeout | null = null;
  // Track which thresholds we've already notified for, per window
  // Key: "fiveHour:75", value: resets_at string (reset tracking when window rolls over)
  private notified: Map<string, string> = new Map();

  constructor(
    fetcher: OAuthUsageFetcher,
    store: NotificationStore,
    onThresholdCrossed: (event: EscalationEvent) => void
  ) {
    this.fetcher = fetcher;
    this.store = store;
    this.onThresholdCrossed = onThresholdCrossed;
  }

  start(): void {
    if (this.interval) return;
    // Check immediately, then every 3 minutes
    this.check();
    this.interval = setInterval(() => this.check(), CACHE_TTL_MS);
    console.log('UsageMonitor: Started polling every 3 minutes');
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async check(): Promise<void> {
    const data = await this.fetcher.getUsage();
    if (!data.available) return;

    const config = this.store.getEscalation();
    if (!config.events.usage_warning) return;

    const thresholds = config.usageThresholds || [50, 75, 90];

    this.checkWindow('fiveHour', '5-hour', data.fiveHour, thresholds);
    this.checkWindow('sevenDay', '7-day', data.sevenDay, thresholds);
    if (data.sevenDayOpus) this.checkWindow('sevenDayOpus', '7-day Opus', data.sevenDayOpus, thresholds);
    if (data.sevenDaySonnet) this.checkWindow('sevenDaySonnet', '7-day Sonnet', data.sevenDaySonnet, thresholds);
    if (data.sevenDayCowork) this.checkWindow('sevenDayCowork', '7-day Cowork', data.sevenDayCowork, thresholds);
  }

  private checkWindow(
    key: string,
    label: string,
    window: OAuthUsageWindow | null | undefined,
    thresholds: number[]
  ): void {
    if (!window) return;

    for (const threshold of thresholds) {
      const notifKey = `${key}:${threshold}`;
      const existingResetAt = this.notified.get(notifKey);

      // If the reset time changed, the window rolled over — clear tracking
      if (existingResetAt && existingResetAt !== window.resets_at) {
        this.notified.delete(notifKey);
      }

      // Check if utilization crosses this threshold and we haven't notified yet
      if (window.utilization >= threshold && !this.notified.has(notifKey)) {
        this.notified.set(notifKey, window.resets_at);
        this.onThresholdCrossed({
          eventType: 'usage_warning',
          sessionId: 'usage',
          sessionName: 'Usage',
          content: `${label} utilization reached ${Math.round(window.utilization)}% (threshold: ${threshold}%)`,
        });
      }
    }
  }
}
