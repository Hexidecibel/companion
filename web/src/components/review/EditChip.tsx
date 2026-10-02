/**
 * Inline chip under an Edit / Write / MultiEdit tool card:
 * `echoGuard.ts +12 −3` with an unreviewed dot and a risk dot. Tapping it
 * expands the real hunks in place (with Ask why / Revert when available).
 * The edit is fetched lazily (when the chip scrolls into view) through the
 * session's batching ReviewEditCache.
 */
import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useReviewContext } from './ReviewContext';
import { FileDiff } from './FileDiff';
import { RiskDot } from './RiskBadge';
import { baseName } from '../../utils/diff/patchText';
import { formatStat, maxLevel } from './format';
import { IconChevronDown, IconChevronRight } from './reviewIcons';

export const EDIT_CHIP_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export const EditChip = memo(function EditChip({ toolId }: { toolId: string }) {
  const ctx = useReviewContext();
  const cache = ctx?.editCache ?? null;
  const subscribe = useCallback((cb: () => void) => (cache ? cache.subscribe(cb) : () => {}), [cache]);
  const getTick = useCallback(() => (cache ? cache.getTick() : 0), [cache]);
  useSyncExternalStore(subscribe, getTick, getTick);
  const edit = cache?.peek(toolId);
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  // Lazy: ask for the edit once the chip is near the viewport.
  useEffect(() => {
    if (!cache || !toolId || edit !== undefined || ctx?.supported === false) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      cache.want(toolId);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        cache.want(toolId);
        io.disconnect();
      }
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [cache, toolId, edit, ctx?.supported]);

  if (!ctx || ctx.supported === false) return null;
  if (edit === undefined) return <div ref={ref} className="rv-chip-slot" aria-hidden="true" />;
  if (edit === null || edit.failed) return null;

  const stat = formatStat(edit.additions, edit.deletions);
  const reviewedThrough = ctx.pendingMark ?? ctx.summary?.reviewedThrough ?? 0;
  const unreviewed = !edit.pending && edit.at > Math.max(reviewedThrough, ctx.summary?.reviewedThrough ?? 0);
  const level = maxLevel(edit.risks);

  return (
    <div className="rv-editchip-wrap" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`rv-editchip${open ? ' rv-editchip--open' : ''}${level === 'high' ? ' rv-editchip--high' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`${edit.path}: ${edit.additions} added, ${edit.deletions} removed${unreviewed ? ' (not reviewed)' : ''}`}
      >
        {open ? <IconChevronDown width={12} height={12} /> : <IconChevronRight width={12} height={12} />}
        <span className="rv-editchip__name">{baseName(edit.path)}</span>
        <span className="rv-num"><span className="rv-add">{stat.add}</span> <span className="rv-del">{stat.del}</span></span>
        {edit.pending && <span className="rv-tag rv-tag--live">writing</span>}
        {unreviewed && <span className="rv-dot rv-dot--unreviewed" aria-label="Not reviewed" role="img" />}
        <RiskDot level={level} />
      </button>
      {open && (
        <div className="rv-editchip__body">
          <FileDiff
            fileKey={`chip:${edit.id}`}
            path={edit.path}
            absPath={edit.absPath}
            status={edit.kind}
            additions={edit.additions}
            deletions={edit.deletions}
            risks={edit.risks}
            hunks={edit.patchUnavailable ? null : edit.hunks}
            hunksOmitted={edit.patchUnavailable ? 'unavailable' : undefined}
            editId={edit.id}
            pending={edit.pending}
            expanded
            onToggle={() => setOpen(false)}
            onAsk={ctx.actions?.ask}
            onRevertHunk={edit.pending ? undefined : ctx.actions?.revertHunk}
            headerExtra={ctx.actions?.fileExtra?.(edit.absPath)}
          />
        </div>
      )}
    </div>
  );
});
