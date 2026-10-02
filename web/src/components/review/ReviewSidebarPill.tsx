import { memo } from 'react';
import { useReviewSummary } from '../../hooks/useReviewSummary';

/** Sidebar: unreviewed file count for a session, tinted by its worst risk. */
export const ReviewSidebarPill = memo(function ReviewSidebarPill({ serverId, sessionId }: { serverId: string; sessionId: string }) {
  const s = useReviewSummary(serverId, sessionId);
  if (!s || s.unreviewedFiles === 0) return null;
  const tone = s.riskLevel === 'high' ? ' rv-sidebar-pill--high' : s.riskLevel === 'medium' ? ' rv-sidebar-pill--medium' : '';
  return (
    <span className={`rv-sidebar-pill${tone}`} title={`${s.unreviewedFiles} unreviewed file(s), +${s.unreviewedAdditions} -${s.unreviewedDeletions}`}>
      {'Δ'}{s.unreviewedFiles}
    </span>
  );
});
