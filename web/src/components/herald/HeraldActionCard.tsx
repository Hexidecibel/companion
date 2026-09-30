import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { HeraldAction } from '../../types/herald';
import { echoCountdown } from '../../services/heraldReducer';
import { IconAlert, IconCheck, IconClock, IconX } from './heraldIcons';

type Decide = (actionId: string, decision: 'confirm' | 'cancel') => Promise<unknown>;

interface CardProps {
  action: HeraldAction;
  skewMs: number | null;
  onDecide: Decide;
  onOpenSession: (serverId: string, sessionId: string) => void;
  disabled?: boolean;
}

/** Re-render on an interval while `active`; returns the current local time. */
function useNow(active: boolean, intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs]);
  return now;
}

function useDecision(action: HeraldAction, onDecide: Decide) {
  const [inflight, setInflight] = useState<'confirm' | 'cancel' | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const decide = useCallback(async (d: 'confirm' | 'cancel') => {
    if (inflight) return;
    setInflight(d);
    try {
      await onDecide(action.id, d);
    } finally {
      if (mounted.current) setInflight(null);
    }
  }, [action.id, onDecide, inflight]);
  return { inflight, decide };
}

function SessionChip({ action, onOpenSession }: { action: HeraldAction; onOpenSession: CardProps['onOpenSession'] }) {
  // A cush-tools command targets this machine, not a session: nothing to open.
  if (action.kind === 'cush_command') {
    return (
      <span className="herald-ref" title="cush-tools command">
        <span className="herald-ref__dot" />
        {action.sessionName}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="herald-ref"
      onClick={() => onOpenSession(action.serverId, action.sessionId)}
      title={`Open ${action.sessionName}`}
    >
      <span className="herald-ref__dot" />
      {action.sessionName}
    </button>
  );
}

/** The exact command a cush-tools action runs, under its readback. */
function CommandLine({ action }: { action: HeraldAction }) {
  if (action.kind !== 'cush_command') return null;
  return (
    <code
      className="herald-action__command"
      style={{ display: 'block', marginTop: 6, fontFamily: 'var(--h-mono)', fontSize: 12, color: 'var(--h-text-2)', overflowWrap: 'anywhere' }}
    >
      {action.payload}
    </code>
  );
}

const RING_R = 17;
const RING_C = 2 * Math.PI * RING_R;

function CountdownRing({ fraction, seconds }: { fraction: number; seconds: number }) {
  return (
    <div className={`herald-countdown${seconds <= 3 ? ' herald-countdown--soon' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 40 40">
        <circle className="herald-countdown__track" cx="20" cy="20" r={RING_R} />
        <circle
          className="herald-countdown__fill"
          cx="20"
          cy="20"
          r={RING_R}
          strokeDasharray={RING_C}
          strokeDashoffset={RING_C * (1 - fraction)}
        />
      </svg>
      <span className="herald-countdown__num">{seconds}</span>
    </div>
  );
}

function EchoCard({ action, skewMs, onDecide, onOpenSession, disabled }: CardProps) {
  const now = useNow(true, 100);
  const cd = echoCountdown(action, now, skewMs);
  const { inflight, decide } = useDecision(action, onDecide);
  const due = !!cd && cd.remainingMs <= 0;
  const seconds = cd ? Math.ceil(cd.remainingMs / 1000) : 0;
  const label = !cd ? 'Ready to send' : due ? 'Sending' : `Sending in ${seconds}s`;

  return (
    <div className="herald-action herald-action--echo" role="group" aria-label={`Pending: ${action.readback}`}>
      <div className="herald-action__body">
        {cd && <CountdownRing fraction={cd.fraction} seconds={seconds} />}
        <div className="herald-action__text">
          <div className="herald-action__eyebrow">
            <span aria-live="off">{label}</span>
            <SessionChip action={action} onOpenSession={onOpenSession} />
          </div>
          <div className="herald-action__readback">{action.readback}</div>
          <CommandLine action={action} />
        </div>
      </div>
      <div className="herald-action__buttons">
        <button
          type="button"
          className="herald-btn herald-btn--primary"
          onClick={() => decide('cancel')}
          // Cancel stays available until the SERVER reports the action resolved:
          // the local countdown is only an estimate (clock skew, a slow send).
          disabled={disabled || !!inflight}
        >
          {inflight === 'cancel' ? 'Cancelling' : 'Cancel'}
        </button>
        <button
          type="button"
          className="herald-btn herald-btn--ghost"
          onClick={() => decide('confirm')}
          disabled={disabled || !!inflight || due}
        >
          {inflight === 'confirm' ? 'Sending' : 'Send now'}
        </button>
      </div>
    </div>
  );
}

const HOLD_MS = 1200;

/**
 * Press-and-hold confirm. Pointer or keyboard (hold Space / Enter). The fill is
 * a CSS transform transition, so the animation itself never touches React.
 */
function HoldToConfirm({ onConfirm, disabled, busy }: { onConfirm: () => void; disabled?: boolean; busy?: boolean }) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  }, []);

  const start = useCallback(() => {
    if (disabled || busy || timer.current) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      onConfirm();
    }, HOLD_MS);
  }, [disabled, busy, onConfirm]);

  useEffect(() => stop, [stop]);
  // Losing the ability to confirm mid-hold (disconnect, cancel in flight) aborts the hold.
  useEffect(() => {
    if (disabled || busy) stop();
  }, [disabled, busy, stop]);

  return (
    <button
      type="button"
      className={`herald-hold${holding ? ' herald-hold--holding' : ''}`}
      disabled={disabled || busy}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        start();
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
          e.preventDefault();
          start();
        } else if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          stop();
        }
      }}
      onBlur={stop}
      aria-label="Press and hold to confirm. Hold Space or Enter for about one second."
    >
      <span className="herald-hold__fill" style={{ transitionDuration: holding ? `${HOLD_MS}ms` : undefined }} />
      <span className="herald-hold__label">{busy ? 'Confirming' : holding ? 'Keep holding' : 'Hold to confirm'}</span>
    </button>
  );
}

function HardConfirmCard({ action, onDecide, onOpenSession, disabled }: CardProps) {
  const { inflight, decide } = useDecision(action, onDecide);
  return (
    <div className="herald-action herald-action--hard" role="group" aria-label={`Needs confirmation: ${action.readback}`}>
      <div className="herald-action__eyebrow herald-action__eyebrow--hard">
        <IconAlert />
        <span>Needs your confirmation</span>
        <SessionChip action={action} onOpenSession={onOpenSession} />
      </div>
      <div className="herald-action__readback">{action.readback}</div>
      <CommandLine action={action} />
      {action.reasons.length > 0 && (
        <ul className="herald-action__reasons">
          {action.reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}
      <div className="herald-action__buttons">
        <HoldToConfirm
          onConfirm={() => decide('confirm')}
          disabled={disabled || inflight === 'cancel'}
          busy={inflight === 'confirm'}
        />
        <button
          type="button"
          className="herald-btn herald-btn--ghost"
          onClick={() => decide('cancel')}
          disabled={disabled || !!inflight}
        >
          {inflight === 'cancel' ? 'Cancelling' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}

const RESOLVED_COPY: Record<Exclude<HeraldAction['status'], 'pending'>, string> = {
  sent: 'Sent',
  cancelled: 'Cancelled',
  failed: 'Failed',
  expired: 'Expired',
};

export const HeraldResolvedLine = memo(function HeraldResolvedLine({ action, onOpenSession }: { action: HeraldAction; onOpenSession: CardProps['onOpenSession'] }) {
  if (action.status === 'pending') return null;
  const Icon = action.status === 'sent' ? IconCheck : action.status === 'failed' ? IconAlert : action.status === 'expired' ? IconClock : IconX;
  return (
    <div className={`herald-resolved herald-resolved--${action.status}`}>
      <Icon />
      <span className="herald-resolved__status">{RESOLVED_COPY[action.status]}</span>
      {action.kind === 'cush_command' ? (
        <span className="herald-resolved__session">{action.sessionName}</span>
      ) : (
        <button type="button" className="herald-resolved__session" onClick={() => onOpenSession(action.serverId, action.sessionId)}>
          {action.sessionName}
        </button>
      )}
      <span className="herald-resolved__text" title={action.readback}>
        {action.status === 'failed' && action.error ? action.error : action.readback}
      </span>
    </div>
  );
});

/** Slim in-stream marker for an action whose live card is pinned above the composer. */
export function HeraldPendingMarker({ action }: { action: HeraldAction }) {
  return (
    <div className={`herald-pending-marker herald-pending-marker--${action.tier}`}>
      <span className="herald-pending-marker__pulse" />
      {action.tier === 'hard_confirm' ? 'Waiting for your confirmation' : 'About to send'}
      <span className="herald-pending-marker__name">{action.sessionName}</span>
    </div>
  );
}

export function HeraldActionCard(props: CardProps) {
  if (props.action.status !== 'pending') {
    return <HeraldResolvedLine action={props.action} onOpenSession={props.onOpenSession} />;
  }
  return props.action.tier === 'hard_confirm' ? <HardConfirmCard {...props} /> : <EchoCard {...props} />;
}
