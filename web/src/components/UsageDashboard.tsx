import { useState, useEffect, useCallback } from 'react';
import { useUsage } from '../hooks/useUsage';
import { useCostDashboard } from '../hooks/useCostDashboard';
import { OAuthUsageWindow, OAuthExtraUsage, UsageDashboardData, DailyUsageBucket } from '../types';
import { DailyUsageChart } from './DailyUsageChart';

interface UsageDashboardProps {
  serverId: string | null;
  onBack: () => void;
}

// Color thresholds for utilization
function utilizationColor(pct: number): string {
  if (pct >= 75) return 'var(--accent-red)';
  if (pct >= 50) return 'var(--accent-amber)';
  return 'var(--accent-green)';
}

function formatCountdown(resetsAt: string): string {
  const diff = new Date(resetsAt).getTime() - Date.now();
  if (diff <= 0) return 'Resetting...';
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
  }
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function UsageDashboard({ serverId, onBack }: UsageDashboardProps) {
  const { data, loading, error, refresh } = useUsage(serverId);
  const costDash = useCostDashboard(serverId);
  const [costOpen, setCostOpen] = useState(false);
  const [, setTick] = useState(0);

  // Update countdowns every 60s
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(timer);
  }, []);

  const refreshAll = useCallback(() => {
    refresh();
    costDash.refresh();
  }, [refresh, costDash.refresh]);

  return (
    <div className="usage-dash-page">
      {/* Header */}
      <div className="usage-dash-header">
        <button onClick={onBack} className="usage-dash-back-btn">
          &#8592;
        </button>
        <h2 style={{ color: 'var(--text-primary)', fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>
          Usage
        </h2>
        <div style={{ flex: 1 }} />
        <button
          onClick={refreshAll}
          disabled={loading}
          className="usage-dash-refresh-btn"
        >
          {loading ? '...' : 'Refresh'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="usage-dash-error">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && !data && (
        <div className="usage-dash-loading">
          Loading usage data...
        </div>
      )}

      {/* No credentials */}
      {data && !data.available && (
        <NoCredentialsCard />
      )}

      {/* Usage data */}
      {data && data.available && (
        <>
          {/* Subscription badge */}
          {data.subscriptionType && (
            <div style={{ textAlign: 'center', marginBottom: '1.25rem' }}>
              <SubscriptionBadge type={data.subscriptionType} tier={data.rateLimitTier} />
            </div>
          )}

          {/* Gauge rings */}
          <div className="usage-gauges-row">
            {data.fiveHour && (
              <GaugeRing
                label="5-Hour"
                utilization={data.fiveHour.utilization}
                resetsAt={data.fiveHour.resets_at}
              />
            )}
            {data.sevenDay && (
              <GaugeRing
                label="7-Day"
                utilization={data.sevenDay.utilization}
                resetsAt={data.sevenDay.resets_at}
              />
            )}
          </div>

          {/* Model-specific utilization bars */}
          <ModelBars data={data} />

          {/* Extra usage */}
          {data.extraUsage?.is_enabled && (
            <ExtraUsageCard extra={data.extraUsage} />
          )}
        </>
      )}

      {/* Collapsible cost section */}
      {costDash.data?.hasAdminKey && (
        <div style={{ marginTop: '1rem' }}>
          <button
            onClick={() => setCostOpen(!costOpen)}
            className="usage-dash-cost-toggle"
          >
            <span style={{
              transform: costOpen ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s',
              display: 'inline-block',
            }}>
              &#9656;
            </span>
            Cost Breakdown ({costDash.period === '7d' ? '7 days' : '30 days'})
            <div style={{ flex: 1 }} />
            {costDash.data && (
              <span className="usage-dash-cost-value">
                ${costDash.data.totalCostUsd.toFixed(2)}
              </span>
            )}
          </button>

          {costOpen && costDash.data && (
            <CostSection
              data={costDash.data}
              period={costDash.period}
              setPeriod={costDash.setPeriod}
            />
          )}
        </div>
      )}
    </div>
  );
}

// --- Sub-components ---

function GaugeRing({
  label,
  utilization,
  resetsAt,
}: {
  label: string;
  utilization: number;
  resetsAt: string;
}) {
  const pct = Math.min(Math.round(utilization), 100);
  const color = utilizationColor(pct);
  const progress = pct / 100;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
      <div
        className="gauge-ring"
        style={{
          '--progress': progress,
          '--color': color,
        } as React.CSSProperties}
      >
        <div className="gauge-ring-inner">
          <span className="gauge-ring-value">{pct}%</span>
          <span className="gauge-ring-label">{label}</span>
        </div>
      </div>
      <div className="usage-gauge-reset">
        Resets {formatCountdown(resetsAt)}
      </div>
    </div>
  );
}

function SubscriptionBadge({ type, tier }: { type: string; tier?: string }) {
  const label = tier || type;
  return (
    <span className="usage-sub-badge">
      {label.toUpperCase()}
    </span>
  );
}

function ModelBars({ data }: { data: UsageDashboardData }) {
  const bars: { label: string; window: OAuthUsageWindow }[] = [];
  if (data.sevenDayOpus) bars.push({ label: 'Opus (7d)', window: data.sevenDayOpus });
  if (data.sevenDaySonnet) bars.push({ label: 'Sonnet (7d)', window: data.sevenDaySonnet });
  if (data.sevenDayCowork) bars.push({ label: 'Cowork (7d)', window: data.sevenDayCowork });

  if (bars.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '1rem' }}>
      {bars.map(({ label, window }) => (
        <UtilizationBar key={label} label={label} window={window} />
      ))}
    </div>
  );
}

function UtilizationBar({ label, window }: { label: string; window: OAuthUsageWindow }) {
  const pct = Math.min(Math.round(window.utilization), 100);
  const color = utilizationColor(pct);

  return (
    <div className="usage-dash-card" style={{ padding: '0.625rem 1rem' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '0.375rem',
        }}
      >
        <span className="usage-bar-text-secondary" style={{ fontSize: '0.75rem' }}>{label}</span>
        <span style={{ color, fontSize: '0.75rem', fontWeight: 600 }}>{pct}%</span>
      </div>
      <div
        className="usage-bar-bg"
        style={{
          width: '100%',
          height: '6px',
          borderRadius: '3px',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            backgroundColor: color,
            borderRadius: '3px',
            transition: 'width 0.6s ease',
          }}
        />
      </div>
      <div className="usage-bar-text-muted" style={{ marginTop: '0.25rem' }}>
        Resets {formatCountdown(window.resets_at)}
      </div>
    </div>
  );
}

function ExtraUsageCard({ extra }: { extra: OAuthExtraUsage }) {
  return (
    <div className="usage-dash-card usage-dash-card-accent" style={{ marginTop: '1rem' }}>
      <div className="usage-bar-text-secondary" style={{ fontSize: '0.75rem', marginBottom: '0.25rem' }}>
        Extra Usage
      </div>
      <div className="usage-bar-text-light" style={{ fontSize: '0.9rem', fontWeight: 500 }}>
        {extra.used_credits != null && extra.monthly_limit != null
          ? `$${extra.used_credits.toFixed(2)} / $${extra.monthly_limit.toFixed(2)}`
          : 'Enabled'}
      </div>
      {extra.utilization != null && (
        <div className="usage-gauge-reset" style={{ marginTop: '0.25rem' }}>
          {Math.round(extra.utilization)}% of monthly limit
        </div>
      )}
    </div>
  );
}

function NoCredentialsCard() {
  return (
    <div className="usage-no-creds-card">
      <div style={{ fontSize: '1.5rem', marginBottom: '0.75rem', opacity: 0.5 }}>&#9679;</div>
      <div className="usage-no-creds-title">
        No OAuth Credentials
      </div>
      Claude Code stores credentials at <code className="usage-code-highlight">~/.claude/.credentials.json</code>.
      <br />
      Log in to Claude Code to enable usage tracking.
    </div>
  );
}

function CostSection({
  data,
  period,
  setPeriod,
}: {
  data: { daily: DailyUsageBucket[]; totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number; totalCacheReadTokens: number };
  period: '7d' | '30d';
  setPeriod: (p: '7d' | '30d') => void;
}) {
  return (
    <div style={{ marginTop: '0.5rem' }}>
      {/* Period selector */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
        {(['7d', '30d'] as const).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`usage-dash-period-btn ${period === p ? 'active' : 'inactive'}`}
          >
            {p === '7d' ? '7 days' : '30 days'}
          </button>
        ))}
      </div>

      {/* Summary cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: '0.5rem',
          marginBottom: '0.75rem',
        }}
      >
        <MiniCard label="Total Cost" value={`$${data.totalCostUsd.toFixed(2)}`} accentColor="var(--accent-green)" />
        <MiniCard label="Output" value={formatTokens(data.totalOutputTokens)} accentColor="var(--accent-blue)" />
        <MiniCard label="Input" value={formatTokens(data.totalInputTokens)} accentColor="var(--accent-amber)" />
        <MiniCard label="Cache Reads" value={formatTokens(data.totalCacheReadTokens)} accentColor="var(--accent-purple)" />
      </div>

      {/* Chart */}
      <div className="usage-dash-card" style={{ padding: '0.75rem', marginBottom: '0.75rem' }}>
        <div className="usage-chart-title">
          Daily Cost
        </div>
        <DailyUsageChart daily={data.daily} />
      </div>

      {/* Model breakdown */}
      {data.daily.length > 0 && <CostModelBreakdown daily={data.daily} />}
    </div>
  );
}

function MiniCard({ label, value, accentColor }: { label: string; value: string; accentColor: string }) {
  return (
    <div
      className="usage-mini-card"
      style={{ borderLeft: `3px solid ${accentColor}` }}
    >
      <div className="usage-mini-card-label">{label}</div>
      <div className="usage-mini-card-value">{value}</div>
    </div>
  );
}

function CostModelBreakdown({ daily }: { daily: DailyUsageBucket[] }) {
  const modelTotals = new Map<string, { costUsd: number; inputTokens: number; outputTokens: number }>();
  for (const day of daily) {
    for (const [model, d] of Object.entries(day.byModel)) {
      const existing = modelTotals.get(model) || { costUsd: 0, inputTokens: 0, outputTokens: 0 };
      existing.costUsd += d.costUsd;
      existing.inputTokens += d.inputTokens;
      existing.outputTokens += d.outputTokens;
      modelTotals.set(model, existing);
    }
  }
  const sorted = Array.from(modelTotals.entries()).sort((a, b) => b[1].costUsd - a[1].costUsd);
  if (sorted.length === 0) return null;

  return (
    <div className="usage-dash-card" style={{ padding: '0.75rem' }}>
      <div className="usage-chart-title">
        By Model
      </div>
      {sorted.map(([model, d]) => (
        <div key={model} className="usage-model-row">
          <div>
            <div className="usage-bar-text-light" style={{ fontSize: '0.75rem' }}>{model.replace(/-\d{8}$/, '')}</div>
            <div className="usage-bar-text-secondary" style={{ fontSize: '0.65rem' }}>
              {formatTokens(d.inputTokens)} in / {formatTokens(d.outputTokens)} out
            </div>
          </div>
          <div className="usage-model-cost" style={{ fontSize: '0.85rem' }}>
            ${d.costUsd.toFixed(2)}
          </div>
        </div>
      ))}
    </div>
  );
}
