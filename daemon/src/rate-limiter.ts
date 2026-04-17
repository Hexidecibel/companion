export type RateLimitAction = 'exec' | 'dispatch' | 'write';

interface RateLimitRule {
  limit: number;
  windowMs: number;
}

const RULES: Record<RateLimitAction, RateLimitRule> = {
  exec: { limit: 60, windowMs: 60_000 },
  dispatch: { limit: 10, windowMs: 60_000 },
  write: { limit: 30, windowMs: 60_000 },
};

export class RateLimiter {
  private buckets: Map<string, number[]> = new Map();

  check(clientId: string, action: RateLimitAction): number | null {
    const rule = RULES[action];
    if (!rule) return null;
    const now = Date.now();
    const key = `${clientId}:${action}`;
    const cutoff = now - rule.windowMs;
    let timestamps = this.buckets.get(key);
    if (!timestamps) {
      timestamps = [];
      this.buckets.set(key, timestamps);
    }
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }
    if (timestamps.length < rule.limit) {
      timestamps.push(now);
      return null;
    }
    const oldest = timestamps[0];
    const retryAfterMs = oldest + rule.windowMs - now;
    return retryAfterMs > 0 ? retryAfterMs : 1;
  }
}
