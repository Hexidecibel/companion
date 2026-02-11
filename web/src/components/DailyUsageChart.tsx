import { DailyUsageBucket } from '../types';

interface DailyUsageChartProps {
  daily: DailyUsageBucket[];
}

export function DailyUsageChart({ daily }: DailyUsageChartProps) {
  if (daily.length === 0) {
    return <div style={{ color: '#9ca3af', textAlign: 'center', padding: '2rem 0' }}>No usage data for this period</div>;
  }

  const maxCost = Math.max(...daily.map((d) => d.estimatedCostUsd), 0.01);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: '2px',
          height: '160px',
          padding: '0 0 1.5rem 0',
          position: 'relative',
        }}
      >
        {daily.map((day) => {
          const heightPct = Math.max((day.estimatedCostUsd / maxCost) * 100, 2);
          const label = day.date.slice(5); // MM-DD
          return (
            <div
              key={day.date}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'flex-end',
                height: '100%',
                position: 'relative',
              }}
              title={`${day.date}: $${day.estimatedCostUsd.toFixed(2)}`}
            >
              <div
                style={{
                  width: '100%',
                  maxWidth: '32px',
                  height: `${heightPct}%`,
                  backgroundColor: '#3b82f6',
                  borderRadius: '3px 3px 0 0',
                  minHeight: '2px',
                  transition: 'height 0.3s ease',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  bottom: '-1.25rem',
                  fontSize: '0.65rem',
                  color: '#9ca3af',
                  whiteSpace: 'nowrap',
                }}
              >
                {label}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
