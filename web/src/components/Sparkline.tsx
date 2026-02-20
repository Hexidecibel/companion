interface SparklineProps {
  timestamps: number[];
  width?: number;
  height?: number;
  minutes?: number;
}

export function Sparkline({ timestamps, width = 60, height = 16, minutes = 30 }: SparklineProps) {
  if (timestamps.length === 0) return null;

  const now = Date.now();
  const windowMs = minutes * 60 * 1000;
  const cutoff = now - windowMs;

  // Filter to timestamps within our window
  const recent = timestamps.filter(t => t >= cutoff);
  if (recent.length === 0) return null;

  // Bin into per-minute buckets
  const bins = new Array(minutes).fill(0);
  for (const t of recent) {
    const minutesAgo = Math.floor((now - t) / 60000);
    const binIdx = minutes - 1 - minutesAgo;
    if (binIdx >= 0 && binIdx < minutes) {
      bins[binIdx]++;
    }
  }

  const maxCount = Math.max(...bins, 1);
  const barWidth = Math.max(1, (width - (minutes - 1)) / minutes);
  const gap = 1;

  return (
    <svg
      width={width}
      height={height}
      className="sparkline"
      style={{ display: 'inline-block', verticalAlign: 'middle' }}
    >
      {bins.map((count, i) => {
        const barHeight = count > 0 ? Math.max(2, (count / maxCount) * height) : 0;
        return (
          <rect
            key={i}
            x={i * (barWidth + gap)}
            y={height - barHeight}
            width={barWidth}
            height={barHeight}
            fill="#3b82f6"
            rx={0.5}
          />
        );
      })}
    </svg>
  );
}
