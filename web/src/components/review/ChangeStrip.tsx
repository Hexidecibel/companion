/**
 * The 28 px change strip under the session header: what changed since you
 * last looked, the worst risk, a live dot while the session edits, and the
 * two actions (open the drawer, mark reviewed). Collapses to a 4 px rail when
 * nothing is unreviewed.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReviewGetResponse, ReviewSummary } from '../../types/review';
import { effectiveUnreviewed, useReviewContext } from './ReviewContext';
import { RiskBadges } from './RiskBadge';
import { IconCheck, IconChevronRight } from './reviewIcons';
import { formatStat, plural } from './format';
import { prefersReducedMotion } from '../../hooks/useReducedMotion';

export const PULSE_MS = 600;
export const TURN_DONE_MS = 30_000;

interface TurnDone {
  index: number;
  turnId: string;
  files: number;
}

export function ChangeStrip() {
  const ctx = useReviewContext();
  const summary = ctx?.summary ?? null;
  const pulse = usePulse(summary?.version ?? null);
  const turnDone = useTurnDone(summary);

  if (!ctx || ctx.supported === false || !summary || summary.totalFiles + summary.totalTurns === 0) return null;
  const unreviewed = effectiveUnreviewed(summary, ctx.pendingMark);
  if (!unreviewed && !summary.live && !turnDone) return <StripRail summary={summary} />;

  const level = unreviewed ? summary.riskLevel : null;
  const stat = formatStat(summary.unreviewedAdditions, summary.unreviewedDeletions);
  const since = summary.reviewedThrough > 0 ? 'since you looked' : 'changed';
  const open = (turnId?: string) => ctx.openDrawer({ scope: 'since_checkpoint', view: 'turns', ...(turnId ? { focusTurnId: turnId } : {}) });

  return (
    <div
      className={`rv-strip rv-strip--${level ?? 'none'}${pulse ? ' rv-strip--pulse' : ''}`}
      role="region"
      aria-label="Code changes"
      data-testid="rv-strip"
    >
      <button type="button" className="rv-strip__main" onClick={() => open(turnDone?.turnId)} title="Open review (changes since you last looked)">
        {summary.live && <span className="rv-live-dot" aria-label="Editing now" role="img" />}
        {turnDone ? (
          <span className="rv-strip__text">
            <strong>Turn {turnDone.index} finished</strong>
            <span className="rv-strip__sep">·</span>
            {plural(turnDone.files, 'file')}
          </span>
        ) : unreviewed ? (
          <span className="rv-strip__text">
            <span className="rv-strip__delta" aria-hidden="true">{'Δ'}</span>
            {plural(summary.unreviewedFiles, 'file')} {since}
            <span className="rv-strip__sep">·</span>
            <span className="rv-num rv-add">{stat.add}</span>{' '}
            <span className="rv-num rv-del">{stat.del}</span>
          </span>
        ) : (
          <span className="rv-strip__text rv-strip__text--muted">Editing…</span>
        )}
        {unreviewed && summary.topRisks.length > 0 && (
          <RiskBadges risks={summary.topRisks.map((r) => ({ kind: r.kind, level: r.level, reason: r.reason }))} max={2} compact />
        )}
      </button>
      <div className="rv-strip__actions">
        <button type="button" className="rv-strip__review" onClick={() => open(turnDone?.turnId)}>
          Review <IconChevronRight width={13} height={13} />
        </button>
        {unreviewed && (
          <button
            type="button"
            className="rv-strip__mark"
            onClick={() => summary.lastChangeAt && ctx.markReviewed(summary.lastChangeAt)}
            title="Mark reviewed"
            aria-label="Mark reviewed"
          >
            <IconCheck width={15} height={15} />
          </button>
        )}
      </div>
    </div>
  );
}

function StripRail({ summary }: { summary: ReviewSummary }) {
  return (
    <div
      className={`rv-strip-rail${summary.live ? ' rv-strip-rail--live' : ''}`}
      data-testid="rv-strip-rail"
      aria-hidden="true"
      title="All changes reviewed"
    />
  );
}

/** True for PULSE_MS after the summary version moves (never on first sight, never under reduced motion). */
export function usePulse(version: number | null): boolean {
  const [on, setOn] = useState(false);
  const last = useRef<number | null>(version);
  useEffect(() => {
    const prev = last.current;
    last.current = version;
    if (prev == null || version == null || version <= prev) return;
    if (prefersReducedMotion()) return;
    setOn(true);
    const t = setTimeout(() => setOn(false), PULSE_MS);
    return () => clearTimeout(t);
  }, [version]);
  return on;
}

/**
 * When the session stops editing (live true -> false), show "Turn N finished"
 * for a while. One review_get (turns, since checkpoint) gives the turn number
 * and its file count, and pre-warms the drawer's edit cache.
 */
function useTurnDone(summary: ReviewSummary | null): TurnDone | null {
  const ctx = useReviewContext();
  const [done, setDone] = useState<TurnDone | null>(null);
  const wasLive = useRef(summary?.live ?? false);
  const live = summary?.live ?? false;
  const request = ctx?.request;
  const sessionId = ctx?.sessionId;
  const editCache = ctx?.editCache;

  useEffect(() => {
    const prev = wasLive.current;
    wasLive.current = live;
    if (live) {
      setDone(null);
      return;
    }
    if (!prev || !request || !sessionId) return;
    let cancelled = false;
    request<ReviewGetResponse>('review_get', { sessionId, scope: 'since_checkpoint', view: 'turns' })
      .then((res) => {
        if (cancelled) return;
        const last = res.turns[res.turns.length - 1];
        editCache?.seed(res.edits);
        if (last && last.fileCount > 0 && last.unreviewed) setDone({ index: last.index, turnId: last.id, files: last.fileCount });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [live, request, sessionId, editCache]);

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(null), TURN_DONE_MS);
    return () => clearTimeout(t);
  }, [done]);

  // Opening the drawer consumes it.
  const drawerOpen = ctx?.drawer.open ?? false;
  useEffect(() => {
    if (drawerOpen) setDone(null);
  }, [drawerOpen]);

  return done;
}
