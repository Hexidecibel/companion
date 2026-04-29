import { useCostDashboard } from '../hooks/useCostDashboard';
import { DailyUsageChart } from './DailyUsageChart';

interface CostDashboardProps {
  serverId: string | null;
  onBack: () => void;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function CostDashboard({ serverId, onBack }: CostDashboardProps) {
  const { data, loading, error, period, setPeriod, refresh } = useCostDashboard(serverId);

  return (
    <div style={{ padding: '1rem', maxWidth: '640px', margin: '0 auto', width: '100%' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
        <button onClick={onBack} className="usage-dash-back-btn">
          &#8592;
        </button>
        <h2 style={{ color: 'var(--text-primary)', fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>
          Cost Dashboard
        </h2>
        <div style={{ flex: 1 }} />
        <button
          onClick={refresh}
          disabled={loading}
          className="usage-dash-refresh-btn"
        >
          {loading ? '...' : 'Refresh'}
        </button>
      </div>

      {/* Period selector */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem' }}>
        {(['7d', '30d'] as const).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`usage-dash-period-btn ${period === p ? 'active' : 'inactive'}`}
            style={{ padding: '0.375rem 0.75rem', fontSize: '0.8rem', fontWeight: 500 }}
          >
            {p === '7d' ? 'Last 7 days' : 'Last 30 days'}
          </button>
        ))}
      </div>

      {/* Error state */}
      {error && (
        <div className="usage-dash-error">
          {error}
        </div>
      )}

      {/* Loading state */}
      {loading && !data && (
        <div className="usage-dash-loading">
          Loading usage data...
        </div>
      )}

      {/* No admin key */}
      {data && !data.hasAdminKey && (
        <div className="usage-no-creds-card">
          <div style={{ fontSize: '1.5rem', marginBottom: '0.75rem' }}>$</div>
          <div className="usage-no-creds-title">
            Admin API Key Required
          </div>
          Add <code className="usage-code-highlight">anthropic_admin_api_key</code> to your daemon
          config to see cost data.
          <br />
          Key starts with <code className="usage-code-highlight">sk-ant-admin-...</code>
        </div>
      )}

      {/* Dashboard data */}
      {data && data.hasAdminKey && (
        <>
          {/* Summary cards */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: '0.75rem',
              marginBottom: '1.25rem',
            }}
          >
            <SummaryCard
              label="Total Cost"
              value={`$${data.totalCostUsd.toFixed(2)}`}
              accentColor="var(--accent-green)"
            />
            <SummaryCard
              label="Output Tokens"
              value={formatTokens(data.totalOutputTokens)}
              accentColor="var(--accent-blue)"
            />
            <SummaryCard
              label="Input Tokens"
              value={formatTokens(data.totalInputTokens)}
              accentColor="var(--accent-amber)"
            />
            <SummaryCard
              label="Cache Reads"
              value={formatTokens(data.totalCacheReadTokens)}
              accentColor="var(--accent-purple)"
            />
          </div>

          {/* Chart */}
          <div className="usage-dash-card" style={{ padding: '1rem', marginBottom: '1.25rem' }}>
            <h3 className="usage-chart-title" style={{ fontSize: '0.85rem', marginBottom: '0.75rem' }}>
              Daily Cost
            </h3>
            <DailyUsageChart daily={data.daily} />
          </div>

          {/* Tokenizer note */}
          <TokenizerNote />

          {/* Model breakdown */}
          {data.daily.length > 0 && <ModelBreakdown daily={data.daily} />}
        </>
      )}
    </div>
  );
}

function TokenizerNote() {
  return (
    <div
      style={{
        display: 'flex',
        gap: '0.5rem',
        alignItems: 'flex-start',
        background: '#1f2937',
        border: '1px solid #374151',
        borderLeft: '3px solid #f59e0b',
        borderRadius: '6px',
        padding: '0.625rem 0.75rem',
        marginBottom: '1rem',
        fontSize: '0.75rem',
        lineHeight: 1.4,
        color: '#9ca3af',
      }}
    >
      <span aria-hidden="true" style={{ color: '#f59e0b', fontWeight: 700, flexShrink: 0 }}>
        !
      </span>
      <span>
        Opus 4.7 uses a new tokenizer that may produce up to 35% more tokens than 4.6/4.5 for the
        same text &mdash; actual cost per request is higher than the per-token rate alone suggests.
      </span>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  accentColor,
}: {
  label: string;
  value: string;
  accentColor: string;
}) {
  return (
    <div
      className="usage-dash-card"
      style={{ borderLeft: `3px solid ${accentColor}` }}
    >
      <div className="usage-mini-card-label" style={{ marginBottom: '0.25rem' }}>{label}</div>
      <div className="usage-mini-card-value" style={{ fontSize: '1.25rem' }}>{value}</div>
    </div>
  );
}

function ModelBreakdown({ daily }: { daily: { byModel: Record<string, { costUsd: number; inputTokens: number; outputTokens: number }> }[] }) {
  // Aggregate by model across all days
  const modelTotals = new Map<string, { costUsd: number; inputTokens: number; outputTokens: number }>();
  for (const day of daily) {
    for (const [model, data] of Object.entries(day.byModel)) {
      const existing = modelTotals.get(model) || { costUsd: 0, inputTokens: 0, outputTokens: 0 };
      existing.costUsd += data.costUsd;
      existing.inputTokens += data.inputTokens;
      existing.outputTokens += data.outputTokens;
      modelTotals.set(model, existing);
    }
  }

  const sorted = Array.from(modelTotals.entries()).sort((a, b) => b[1].costUsd - a[1].costUsd);
  if (sorted.length === 0) return null;

  return (
    <div className="usage-dash-card" style={{ padding: '1rem' }}>
      <h3 className="usage-chart-title" style={{ fontSize: '0.85rem', marginBottom: '0.75rem' }}>
        By Model
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {sorted.map(([model, data]) => (
          <div key={model} className="usage-model-row" style={{ padding: '0.5rem 0' }}>
            <div>
              <div className="usage-bar-text-light" style={{ fontSize: '0.8rem' }}>
                {model.replace(/-\d{8}$/, '')}
              </div>
              <div className="usage-bar-text-secondary" style={{ fontSize: '0.7rem' }}>
                {formatTokens(data.inputTokens)} in / {formatTokens(data.outputTokens)} out
              </div>
            </div>
            <div className="usage-model-cost" style={{ fontSize: '0.9rem' }}>
              ${data.costUsd.toFixed(2)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
