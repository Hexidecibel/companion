import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { lastRateLimits, readCodexRateLimits, windowLabel } from '../codex/usage';
import { UsageMonitor } from '../../oauth-usage';

const tc = (ts: string, primary: number, secondary: number, resets = 1793242480) =>
  JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: null,
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: primary, window_minutes: 300, resets_at: resets },
        secondary: { used_percent: secondary, window_minutes: 10080, resets_at: 1793829280 },
      },
    },
  });

function home(lines: string[], now: Date): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-'));
  const pad = (n: number) => String(n).padStart(2, '0');
  const dir = path.join(
    h,
    'sessions',
    String(now.getFullYear()),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'rollout-2026-10-28T20-02-40-01a1859c-1206-7690-b142-5335c20e0f1d.jsonl'),
    lines.join('\n') + '\n'
  );
  return h;
}

describe('Codex usage from rollouts', () => {
  it('reads the newest token_count rate limits', async () => {
    expect(
      lastRateLimits(
        ['x', tc('2026-10-28T20:00:00Z', 10, 1), tc('2026-10-28T20:01:00Z', 55, 3)].join('\n')
      )
    ).toMatchObject({
      primary: { usedPercent: 55, windowMinutes: 300 },
      secondary: { usedPercent: 3 },
    });
    const now = new Date();
    const h = home(['{"type":"session_meta","payload":{}}', tc(now.toISOString(), 80, 20)], now);
    expect((await readCodexRateLimits(h, now.getTime()))?.primary?.usedPercent).toBe(80);
    expect(windowLabel(300)).toBe('5-hour');
    expect(windowLabel(10080)).toBe('7-day');
  });

  it('alerts once per threshold per window; resets_at jitter is the same window', async () => {
    const now = new Date();
    const h = home([tc(now.toISOString(), 76, 20)], now);
    const events: string[] = [];
    const store = {
      getEscalation: () => ({ events: { usage_warning: true }, usageThresholds: [50, 75, 90] }),
    };
    const m = new UsageMonitor(
      { getUsage: async () => ({ available: false }) } as never,
      store as never,
      (e) => events.push(e.content),
      () => [{ id: 'codex', label: 'Codex', home: h, isDefault: true }]
    );
    await m.checkCodex(now.getTime());
    expect(events).toEqual([
      'Codex 5-hour utilization reached 76% (threshold: 50%)',
      'Codex 5-hour utilization reached 76% (threshold: 75%)',
    ]);
    // Same window, resets_at a few seconds off, a newer record.
    const f = fs.readdirSync(path.join(h, 'sessions'), { recursive: true }) as string[];
    const file = path.join(h, 'sessions', f.find((x) => x.endsWith('.jsonl'))!);
    fs.appendFileSync(
      file,
      tc(new Date(now.getTime() + 1000).toISOString(), 77, 20, 1793242483) + '\n'
    );
    const later = new Date(now.getTime() + 5000);
    fs.utimesSync(file, later, later);
    await m.checkCodex(now.getTime());
    expect(events).toHaveLength(2);
  });
});
