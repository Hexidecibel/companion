import { effectiveUnreviewed, useReviewContext } from './ReviewContext';

/** Header "Review (N)": N = unreviewed files; badge coloured by the worst risk. */
export function ReviewHeaderButton() {
  const ctx = useReviewContext();
  const s = ctx?.summary;
  if (!ctx || ctx.supported === false || !s || s.totalFiles === 0) return null;
  const unreviewed = effectiveUnreviewed(s, ctx.pendingMark);
  return (
    <button
      className={`session-header-btn${ctx.drawer.open ? ' terminal-active' : ''}`}
      onClick={() => (ctx.drawer.open ? ctx.closeDrawer() : ctx.openDrawer())}
      title={unreviewed ? `Review ${s.unreviewedFiles} unreviewed file(s)` : 'Review changes'}
    >
      Review
      {unreviewed && s.unreviewedFiles > 0 && (
        <span className={`rv-header-badge${s.riskLevel === 'high' ? ' rv-header-badge--high' : s.riskLevel === 'medium' ? ' rv-header-badge--medium' : ''}`}>
          {s.unreviewedFiles}
        </span>
      )}
    </button>
  );
}
