/**
 * One turn in the drawer's "By turn" view: a card with the turn's gist and
 * stats, an Approve check, and the turn's edits as FileDiffs. Approved turns
 * fade and fold. On touch, swiping the header right approves.
 */
import { memo, useRef, useState, type ReactNode } from 'react';
import type { ReviewEdit, ReviewTurn } from '../../types/review';
import { IconCheck, IconChevronDown, IconChevronRight } from './reviewIcons';
import { formatAgo, formatStat, plural } from './format';
import { RiskDot } from './RiskBadge';

export const SWIPE_APPROVE_PX = 84;

interface TurnGroupProps {
  turn: ReviewTurn;
  edits: ReviewEdit[];
  approved: boolean;
  folded: boolean;
  focused: boolean;
  onToggleFold: (turnId: string) => void;
  onApprove: (turnId: string, approved: boolean) => void;
  swipeEnabled: boolean;
  now: number;
  children: ReactNode;
}

export const TurnGroup = memo(function TurnGroup({ turn, edits, approved, folded, focused, onToggleFold, onApprove, swipeEnabled, now, children }: TurnGroupProps) {
  const stat = formatStat(turn.additions, turn.deletions);
  const live = turn.endedAt === null;
  const swipe = useSwipe(swipeEnabled && !approved, () => onApprove(turn.id, true));
  const pendingCount = edits.filter((e) => e.pending).length;
  const gist = turn.gist || turn.prompt || `Turn ${turn.index}`;

  return (
    <section
      className={`rv-turn${approved ? ' rv-turn--approved' : ''}${focused ? ' rv-turn--focus' : ''}${live ? ' rv-turn--live' : ''}`}
      data-turn-id={turn.id}
      aria-label={`Turn ${turn.index}: ${gist}`}
    >
      <div className="rv-turn__swipe-bg" aria-hidden="true" style={{ opacity: swipe.progress }}>
        <IconCheck width={18} height={18} /> Approve
      </div>
      <header
        className="rv-turn__head"
        style={swipe.offset ? { transform: `translateX(${swipe.offset}px)` } : undefined}
        {...swipe.handlers}
      >
        <button type="button" className="rv-turn__fold" onClick={() => onToggleFold(turn.id)} aria-expanded={!folded} aria-label={folded ? 'Expand turn' : 'Collapse turn'}>
          {folded ? <IconChevronRight width={13} height={13} /> : <IconChevronDown width={13} height={13} />}
        </button>
        <span className="rv-turn__pill">T{turn.index}</span>
        <div className="rv-turn__titles" onClick={() => onToggleFold(turn.id)}>
          <div className="rv-turn__gist">
            {gist}
            <RiskDot level={turn.riskLevel} />
            {live && <span className="rv-live-dot rv-live-dot--inline" aria-label="In progress" role="img" />}
          </div>
          <div className="rv-turn__meta rv-num">
            {plural(turn.fileCount, 'file')}
            <span className="rv-sep">·</span>
            <span className="rv-add">{stat.add}</span> <span className="rv-del">{stat.del}</span>
            <span className="rv-sep">·</span>
            {live ? (pendingCount ? 'writing…' : 'in progress') : formatAgo(turn.endedAt ?? turn.startedAt, now)}
          </div>
          {turn.prompt && turn.prompt !== gist && <div className="rv-turn__prompt" title={turn.prompt}>{turn.prompt}</div>}
        </div>
        <button
          type="button"
          className={`rv-approve${approved ? ' rv-approve--on' : ''}`}
          onClick={() => onApprove(turn.id, !approved)}
          aria-pressed={approved}
          title={approved ? 'Approved. Click to unapprove.' : 'Approve turn (a)'}
        >
          <IconCheck width={15} height={15} />
          <span className="rv-approve__label">{approved ? 'Approved' : 'Approve'}</span>
        </button>
      </header>
      {!folded && <div className="rv-turn__body">{children}</div>}
    </section>
  );
});

/** Horizontal swipe on touch: returns live offset and fires onCommit past the threshold. */
function useSwipe(enabled: boolean, onCommit: () => void) {
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const locked = useRef<'h' | 'v' | null>(null);
  const [offset, setOffset] = useState(0);
  const reset = () => { start.current = null; locked.current = null; setOffset(0); };
  if (!enabled) return { offset: 0, progress: 0, handlers: {} };
  return {
    offset,
    progress: Math.min(1, offset / SWIPE_APPROVE_PX),
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        if (e.pointerType === 'mouse') return;
        start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
        locked.current = null;
      },
      onPointerMove: (e: React.PointerEvent) => {
        const s = start.current;
        if (!s || s.id !== e.pointerId) return;
        const dx = e.clientX - s.x;
        const dy = e.clientY - s.y;
        if (!locked.current) {
          if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
          locked.current = Math.abs(dx) > Math.abs(dy) * 1.3 ? 'h' : 'v';
        }
        if (locked.current === 'h') setOffset(Math.max(0, Math.min(140, dx)));
      },
      onPointerUp: () => {
        const commit = locked.current === 'h' && offset >= SWIPE_APPROVE_PX;
        reset();
        if (commit) onCommit();
      },
      onPointerCancel: reset,
    },
  };
}
