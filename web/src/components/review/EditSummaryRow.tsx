/**
 * Slim "3 files changed · +12 −3" row under an assistant message whose
 * Edit / Write / MultiEdit / NotebookEdit tool cards are hidden (tools off).
 * Tapping it expands the per-edit chips (each expands to its hunks).
 * Lazy: the edits are asked for once the row nears the viewport, through the
 * session's batching ReviewEditCache (one review_get_edits per window,
 * at most REVIEW_LIMITS.maxGetEdits ids each).
 */
import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useReviewContext } from './ReviewContext';
import { EditChip } from './EditChip';
import { RiskDot } from './RiskBadge';
import { formatStat, maxLevel, plural } from './format';
import { IconChevronDown, IconChevronRight } from './reviewIcons';
import type { ReviewEdit } from '../../types/review';

export interface EditSummary {
  files: number;
  additions: number;
  deletions: number;
  unreviewed: boolean;
  pending: boolean;
  level: ReturnType<typeof maxLevel>;
  ids: string[];
}

/** Aggregate the known, reviewable edits (null = nothing to show yet). */
export function summarizeEdits(edits: ReadonlyArray<ReviewEdit>, reviewedThrough: number): EditSummary | null {
  const usable = edits.filter((e) => !e.failed);
  if (!usable.length) return null;
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;
  let unreviewed = false;
  let pending = false;
  for (const e of usable) {
    files.add(e.absPath);
    additions += e.additions;
    deletions += e.deletions;
    if (e.pending) pending = true;
    else if (e.at > reviewedThrough) unreviewed = true;
  }
  return {
    files: files.size,
    additions,
    deletions,
    unreviewed,
    pending,
    level: maxLevel(usable.flatMap((e) => e.risks)),
    ids: usable.map((e) => e.id),
  };
}

export const EditSummaryRow = memo(function EditSummaryRow({ toolIds }: { toolIds: string[] }) {
  const ctx = useReviewContext();
  const cache = ctx?.editCache ?? null;
  const subscribe = useCallback((cb: () => void) => (cache ? cache.subscribe(cb) : () => {}), [cache]);
  const getTick = useCallback(() => (cache ? cache.getTick() : 0), [cache]);
  useSyncExternalStore(subscribe, getTick, getTick);
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const idsKey = toolIds.join('\0');
  const unknown = cache ? toolIds.some((id) => cache.peek(id) === undefined) : false;

  useEffect(() => {
    if (!cache || !unknown || ctx?.supported === false) return;
    const ask = () => { for (const id of idsKey.split('\0')) if (id) cache.want(id); };
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      ask();
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        ask();
        io.disconnect();
      }
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [cache, idsKey, unknown, ctx?.supported]);

  if (!ctx || ctx.supported === false || !cache) return null;
  const known: ReviewEdit[] = [];
  for (const id of toolIds) {
    const e = cache.peek(id);
    if (e) known.push(e);
  }
  const reviewedThrough = Math.max(ctx.pendingMark ?? 0, ctx.summary?.reviewedThrough ?? 0);
  const sum = summarizeEdits(known, reviewedThrough);
  if (!sum) return unknown ? <div ref={ref} className="rv-chip-slot" aria-hidden="true" /> : null;
  const stat = formatStat(sum.additions, sum.deletions);

  return (
    <div ref={ref} className="rv-editchip-wrap rv-editsum" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`rv-editchip rv-editsum__btn${open ? ' rv-editchip--open' : ''}${sum.level === 'high' ? ' rv-editchip--high' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`${plural(sum.files, 'file')} changed: ${sum.additions} added, ${sum.deletions} removed${sum.unreviewed ? ' (not reviewed)' : ''}`}
      >
        {open ? <IconChevronDown width={12} height={12} /> : <IconChevronRight width={12} height={12} />}
        <span className="rv-editchip__name">{plural(sum.files, 'file')} changed</span>
        <span className="rv-editsum__sep" aria-hidden="true">·</span>
        <span className="rv-num"><span className="rv-add">{stat.add}</span> <span className="rv-del">{stat.del}</span></span>
        {sum.pending && <span className="rv-tag rv-tag--live">writing</span>}
        {sum.unreviewed && <span className="rv-dot rv-dot--unreviewed" aria-label="Not reviewed" role="img" />}
        <RiskDot level={sum.level} />
      </button>
      {open && (
        <div className="rv-editsum__list">
          {sum.ids.map((id) => <EditChip key={id} toolId={id} />)}
        </div>
      )}
    </div>
  );
});
