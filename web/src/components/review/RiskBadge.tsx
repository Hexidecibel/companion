import { memo } from 'react';
import type { ReviewRiskFlag, ReviewRiskLevel } from '../../types/review';
import { sortRisks } from './format';

const LEVEL_LABEL: Record<ReviewRiskLevel, string> = { high: 'High risk', medium: 'Worth a look', low: 'Low risk' };

/** One risk chip: coloured by level, text is the deterministic reason. */
export const RiskBadge = memo(function RiskBadge({ risk, title, compact }: { risk: ReviewRiskFlag; title?: string; compact?: boolean }) {
  return (
    <span
      className={`rv-risk rv-risk--${risk.level}${compact ? ' rv-risk--compact' : ''}`}
      title={title ?? `${LEVEL_LABEL[risk.level]}: ${risk.reason}`}
    >
      <span className="rv-risk__dot" aria-hidden="true" />
      {risk.reason}
    </span>
  );
});

/** Up to `max` chips, highest first, plus a "+N" overflow. Low risks only when nothing else. */
export function RiskBadges({ risks, max = 2, compact }: { risks: ReviewRiskFlag[]; max?: number; compact?: boolean }) {
  if (!risks.length) return null;
  const sorted = sortRisks(risks);
  const notable = sorted.filter((r) => r.level !== 'low');
  const list = notable.length ? notable : sorted;
  const shown = list.slice(0, max);
  const rest = list.length - shown.length;
  return (
    <span className="rv-risks">
      {shown.map((r) => <RiskBadge key={`${r.kind}:${r.reason}`} risk={r} compact={compact} />)}
      {rest > 0 && <span className="rv-risk rv-risk--more" title={list.slice(max).map((r) => r.reason).join(', ')}>+{rest}</span>}
    </span>
  );
}

/** A coloured dot only (inline chips). */
export function RiskDot({ level }: { level: ReviewRiskLevel | null }) {
  if (!level || level === 'low') return null;
  return <span className={`rv-risk-dot rv-risk-dot--${level}`} aria-label={LEVEL_LABEL[level]} role="img" />;
}
