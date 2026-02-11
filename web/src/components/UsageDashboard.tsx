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
  if (pct >= 75) return '#ef4444';
  if (pct >= 50) return '#f59e0b';
  return '#10b981';
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
    <div style={{ padding: '1rem', maxWidth: '640px', margin: '0 auto', width: '100%' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          marginBottom: '1.25rem',
          padding: '0.75rem 1rem',
          borderRadius: '10px',
          background: 'linear-gradient(135deg, rgba(59,130,246,0.12) 0%, rgba(16,185,129,0.08) 100%)',
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: 'none',
            border: 'none',
            color: '#9ca3af',
            cursor: 'pointer',
            fontSize: '1.25rem',
            padding: '0.25rem',
          }}
        >
          &#8592;
        </button>
        <h2 style={{ color: '#f3f4f6', fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>
          Usage
        </h2>
        <div style={{ flex: 1 }} />
        <button
          onClick={refreshAll}
          disabled={loading}
          style={{
            background: 'none',
            border: '1px solid #374151',
            borderRadius: '6px',
            color: '#9ca3af',
            cursor: 'pointer',
            padding: '0.25rem 0.5rem',
            fontSize: '0.75rem',
          }}
        >
          {loading ? '...' : 'Refresh'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div
          style={{
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: '8px',
            padding: '0.75rem 1rem',
            color: '#ef4444',
            fontSize: '0.85rem',
            marginBottom: '1rem',
          }}
        >
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && !data && (
        <div style={{ color: '#9ca3af', textAlign: 'center', padding: '3rem 0' }}>
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
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.75rem 1rem',
              backgroundColor: '#1f2937',
              borderRadius: '8px',
              border: '1px solid #374151',
              color: '#f3f4f6',
              cursor: 'pointer',
              fontSize: '0.85rem',
              fontWeight: 500,
            }}
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
              <span style={{ color: '#10b981', fontWeight: 600 }}>
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
      <div style={{ color: '#9ca3af', fontSize: '0.7rem' }}>
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
    <div
      style={{
        backgroundColor: '#1f2937',
        borderRadius: '8px',
        padding: '0.625rem 1rem',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '0.375rem',
        }}
      >
        <span style={{ color: '#d1d5db', fontSize: '0.75rem' }}>{label}</span>
        <span style={{ color, fontSize: '0.75rem', fontWeight: 600 }}>{pct}%</span>
      </div>
      <div
        style={{
          width: '100%',
          height: '6px',
          backgroundColor: '#374151',
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
      <div style={{ color: '#6b7280', fontSize: '0.65rem', marginTop: '0.25rem' }}>
        Resets {formatCountdown(window.resets_at)}
      </div>
    </div>
  );
}

function ExtraUsageCard({ extra }: { extra: OAuthExtraUsage }) {
  return (
    <div
      style={{
        backgroundColor: '#1f2937',
        borderRadius: '8px',
        padding: '0.75rem 1rem',
        marginTop: '1rem',
        borderLeft: '3px solid #8b5cf6',
      }}
    >
      <div style={{ color: '#d1d5db', fontSize: '0.75rem', marginBottom: '0.25rem' }}>
        Extra Usage
      </div>
      <div style={{ color: '#f3f4f6', fontSize: '0.9rem', fontWeight: 500 }}>
        {extra.used_credits != null && extra.monthly_limit != null
          ? `$${extra.used_credits.toFixed(2)} / $${extra.monthly_limit.toFixed(2)}`
          : 'Enabled'}
      </div>
      {extra.utilization != null && (
        <div style={{ color: '#9ca3af', fontSize: '0.7rem', marginTop: '0.25rem' }}>
          {Math.round(extra.utilization)}% of monthly limit
        </div>
      )}
    </div>
  );
}

function NoCredentialsCard() {
  return (
    <div
      style={{
        backgroundColor: '#1f2937',
        borderRadius: '8px',
        padding: '1.5rem',
        textAlign: 'center',
        color: '#9ca3af',
        fontSize: '0.85rem',
        lineHeight: 1.6,
      }}
    >
      <div style={{ fontSize: '1.5rem', marginBottom: '0.75rem', opacity: 0.5 }}>&#9679;</div>
      <div style={{ color: '#f3f4f6', fontWeight: 500, marginBottom: '0.5rem' }}>
        No OAuth Credentials
      </div>
      Claude Code stores credentials at <code style={{ color: '#f59e0b' }}>~/.claude/.credentials.json</code>.
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
            style={{
              padding: '0.25rem 0.5rem',
              borderRadius: '6px',
              border: period === p ? '1px solid #3b82f6' : '1px solid #374151',
              backgroundColor: period === p ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
              color: period === p ? '#3b82f6' : '#9ca3af',
              cursor: 'pointer',
              fontSize: '0.75rem',
            }}
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
        <MiniCard label="Total Cost" value={`$${data.totalCostUsd.toFixed(2)}`} color="#10b981" />
        <MiniCard label="Output" value={formatTokens(data.totalOutputTokens)} color="#3b82f6" />
        <MiniCard label="Input" value={formatTokens(data.totalInputTokens)} color="#f59e0b" />
        <MiniCard label="Cache Reads" value={formatTokens(data.totalCacheReadTokens)} color="#8b5cf6" />
      </div>

      {/* Chart */}
      <div
        style={{
          backgroundColor: '#1f2937',
          borderRadius: '8px',
          padding: '0.75rem',
          marginBottom: '0.75rem',
        }}
      >
        <div style={{ color: '#f3f4f6', fontSize: '0.8rem', fontWeight: 500, marginBottom: '0.5rem' }}>
          Daily Cost
        </div>
        <DailyUsageChart daily={data.daily} />
      </div>

      {/* Model breakdown */}
      {data.daily.length > 0 && <CostModelBreakdown daily={data.daily} />}
    </div>
  );
}

function MiniCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div
      style={{
        backgroundColor: '#1f2937',
        borderRadius: '6px',
        padding: '0.5rem 0.75rem',
        borderLeft: `3px solid ${color}`,
      }}
    >
      <div style={{ color: '#9ca3af', fontSize: '0.65rem', marginBottom: '0.125rem' }}>{label}</div>
      <div style={{ color: '#f3f4f6', fontSize: '1rem', fontWeight: 600 }}>{value}</div>
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
    <div style={{ backgroundColor: '#1f2937', borderRadius: '8px', padding: '0.75rem' }}>
      <div style={{ color: '#f3f4f6', fontSize: '0.8rem', fontWeight: 500, marginBottom: '0.5rem' }}>
        By Model
      </div>
      {sorted.map(([model, d]) => (
        <div
          key={model}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '0.375rem 0',
            borderBottom: '1px solid #374151',
          }}
        >
          <div>
            <div style={{ color: '#f3f4f6', fontSize: '0.75rem' }}>{model.replace(/-\d{8}$/, '')}</div>
            <div style={{ color: '#9ca3af', fontSize: '0.65rem' }}>
              {formatTokens(d.inputTokens)} in / {formatTokens(d.outputTokens)} out
            </div>
          </div>
          <div style={{ color: '#10b981', fontSize: '0.85rem', fontWeight: 500 }}>
            ${d.costUsd.toFixed(2)}
          </div>
        </div>
      ))}
    </div>
  );
}
