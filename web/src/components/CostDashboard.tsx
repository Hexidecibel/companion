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
          Cost Dashboard
        </h2>
        <div style={{ flex: 1 }} />
        <button
          onClick={refresh}
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

      {/* Period selector */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem' }}>
        {(['7d', '30d'] as const).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            style={{
              padding: '0.375rem 0.75rem',
              borderRadius: '6px',
              border: period === p ? '1px solid #3b82f6' : '1px solid #374151',
              backgroundColor: period === p ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
              color: period === p ? '#3b82f6' : '#9ca3af',
              cursor: 'pointer',
              fontSize: '0.8rem',
              fontWeight: 500,
            }}
          >
            {p === '7d' ? 'Last 7 days' : 'Last 30 days'}
          </button>
        ))}
      </div>

      {/* Error state */}
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

      {/* Loading state */}
      {loading && !data && (
        <div style={{ color: '#9ca3af', textAlign: 'center', padding: '3rem 0' }}>
          Loading usage data...
        </div>
      )}

      {/* No admin key */}
      {data && !data.hasAdminKey && (
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
          <div style={{ fontSize: '1.5rem', marginBottom: '0.75rem' }}>$</div>
          <div style={{ color: '#f3f4f6', fontWeight: 500, marginBottom: '0.5rem' }}>
            Admin API Key Required
          </div>
          Add <code style={{ color: '#f59e0b' }}>anthropic_admin_api_key</code> to your daemon
          config to see cost data.
          <br />
          Key starts with <code style={{ color: '#f59e0b' }}>sk-ant-admin-...</code>
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
              color="#10b981"
            />
            <SummaryCard
              label="Output Tokens"
              value={formatTokens(data.totalOutputTokens)}
              color="#3b82f6"
            />
            <SummaryCard
              label="Input Tokens"
              value={formatTokens(data.totalInputTokens)}
              color="#f59e0b"
            />
            <SummaryCard
              label="Cache Reads"
              value={formatTokens(data.totalCacheReadTokens)}
              color="#8b5cf6"
            />
          </div>

          {/* Chart */}
          <div
            style={{
              backgroundColor: '#1f2937',
              borderRadius: '8px',
              padding: '1rem',
              marginBottom: '1.25rem',
            }}
          >
            <h3
              style={{
                color: '#f3f4f6',
                fontSize: '0.85rem',
                fontWeight: 500,
                marginBottom: '0.75rem',
              }}
            >
              Daily Cost
            </h3>
            <DailyUsageChart daily={data.daily} />
          </div>

          {/* Model breakdown */}
          {data.daily.length > 0 && <ModelBreakdown daily={data.daily} />}
        </>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div
      style={{
        backgroundColor: '#1f2937',
        borderRadius: '8px',
        padding: '0.75rem 1rem',
        borderLeft: `3px solid ${color}`,
      }}
    >
      <div style={{ color: '#9ca3af', fontSize: '0.7rem', marginBottom: '0.25rem' }}>{label}</div>
      <div style={{ color: '#f3f4f6', fontSize: '1.25rem', fontWeight: 600 }}>{value}</div>
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
    <div style={{ backgroundColor: '#1f2937', borderRadius: '8px', padding: '1rem' }}>
      <h3
        style={{
          color: '#f3f4f6',
          fontSize: '0.85rem',
          fontWeight: 500,
          marginBottom: '0.75rem',
        }}
      >
        By Model
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {sorted.map(([model, data]) => (
          <div
            key={model}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '0.5rem 0',
              borderBottom: '1px solid #374151',
            }}
          >
            <div>
              <div style={{ color: '#f3f4f6', fontSize: '0.8rem' }}>
                {model.replace(/-\d{8}$/, '')}
              </div>
              <div style={{ color: '#9ca3af', fontSize: '0.7rem' }}>
                {formatTokens(data.inputTokens)} in / {formatTokens(data.outputTokens)} out
              </div>
            </div>
            <div style={{ color: '#10b981', fontSize: '0.9rem', fontWeight: 500 }}>
              ${data.costUsd.toFixed(2)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
