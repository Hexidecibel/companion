import React from 'react';
import '../styles/skeleton.css';

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
  style?: React.CSSProperties;
}

export function Skeleton({ width = '100%', height = 16, borderRadius = 4, style }: SkeletonProps) {
  return (
    <div
      className="skeleton-shimmer"
      style={{ width, height, borderRadius, ...style }}
    />
  );
}

interface SkeletonMessageBubbleProps {
  side: 'left' | 'right';
  lines?: number;
}

export function SkeletonMessageBubble({ side, lines = 3 }: SkeletonMessageBubbleProps) {
  // Generate varied line widths for realism
  const lineWidths = Array.from({ length: lines }, (_, i) => {
    if (i === lines - 1) return `${40 + Math.random() * 30}%`; // Last line shorter
    return `${70 + Math.random() * 30}%`;
  });

  return (
    <div className={`skeleton-bubble ${side}`}>
      {lineWidths.map((width, i) => (
        <Skeleton key={i} width={width} height={12} />
      ))}
    </div>
  );
}

export function SkeletonSessionCard() {
  return (
    <div className="skeleton-session-card">
      <Skeleton width={10} height={10} borderRadius="50%" />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Skeleton width="60%" height={14} />
        <Skeleton width="40%" height={10} />
      </div>
    </div>
  );
}
