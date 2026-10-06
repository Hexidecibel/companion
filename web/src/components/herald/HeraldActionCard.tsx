import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { HeraldAction } from '../../types/herald';
import { echoCountdown } from '../../services/heraldReducer';
import { IconAlert, IconCheck, IconClock, IconX } from './heraldIcons';
import { HoldToConfirm } from '../common/HoldToConfirm';

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

/**
 * An echo-tier suggested answer (the babysitter's): it waits for the user and
 * never counts down. A risky suggestion is hard_confirm and uses that card.
 */
export function isSuggestion(action: HeraldAction): boolean {
  return action.tier === 'echo' && !!action.suggested;
}

/** Actions with no existing session to open: a cush-tools command, a session not started yet. */
function hasNoSession(action: HeraldAction): boolean {
  return action.kind === 'cush_command' || action.kind === 'spawn_session';
}

function SessionChip({ action, onOpenSession }: { action: HeraldAction; onOpenSession: CardProps['onOpenSession'] }) {
  // A cush-tools command targets this machine; a new session does not exist yet.
  if (hasNoSession(action)) {
    return (
      <span className="herald-ref" title={action.kind === 'spawn_session' ? 'New session' : 'cush-tools command'}>
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

const PHRASE_STYLE = { marginTop: 10, fontSize: 13, lineHeight: 1.45, color: 'var(--h-text-2)' } as const;
const PHRASE_WORDS_STYLE = { color: 'var(--h-text)', fontWeight: 600, quotes: '"\\201C" "\\201D"' } as const;

/**
 * The spoken alternative to holding: "Or say “confirm deploy”". Hands busy
 * (mid-game) is exactly when this matters. After the voice tries are used up
 * the card says so: only the hold confirms it then.
 */
function VoicePhrase({ action }: { action: HeraldAction }) {
  if (!action.confirmPhrase) return null;
  const left = action.voiceAttemptsLeft ?? 1;
  if (left <= 0) {
    return (
      <div className="herald-action__phrase herald-action__phrase--off" style={PHRASE_STYLE}>
        Voice tries used up: hold to confirm.
      </div>
    );
  }
  return (
    <div className="herald-action__phrase" style={PHRASE_STYLE} aria-label={`Or say: ${action.confirmPhrase}`}>
      Or say <q style={PHRASE_WORDS_STYLE}>{action.confirmPhrase}</q>
      {left < 3 && <span> ({left} {left === 1 ? 'try' : 'tries'} left)</span>}
    </div>
  );
}

/** Why the babysitter brought this to the user instead of answering it. */
function SuggestedWhy({ action }: { action: HeraldAction }) {
  if (!action.suggested || !action.suggestedWhy) return null;
  return <div className="herald-action__why">{action.suggestedWhy}</div>;
}

/**
 * The babysitter's suggested answer: Send / Cancel and NO countdown. It never
 * sends by itself; the hub expires it when the question goes away.
 */
function SuggestedCard({ action, onDecide, onOpenSession, disabled }: CardProps) {
  const { inflight, decide } = useDecision(action, onDecide);
  return (
    <div className="herald-action herald-action--echo herald-action--suggested" role="group" aria-label={`Suggested answer: ${action.readback}`}>
      <div className="herald-action__body">
        <div className="herald-action__text">
          <div className="herald-action__eyebrow">
            <span>Suggested answer</span>
            <SessionChip action={action} onOpenSession={onOpenSession} />
          </div>
          <div className="herald-action__readback">{action.readback}</div>
          <SuggestedWhy action={action} />
        </div>
      </div>
      <div className="herald-action__buttons">
        <button
          type="button"
          className="herald-btn herald-btn--primary"
          onClick={() => decide('confirm')}
          disabled={disabled || !!inflight}
        >
          {inflight === 'confirm' ? 'Sending' : 'Send'}
        </button>
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

function hardEyebrow(action: HeraldAction): string {
  if (action.kind === 'babysit_start') return 'Start babysitting?';
  if (action.suggested) return 'Suggested answer, needs your confirmation';
  return 'Needs your confirmation';
}

function HardConfirmCard({ action, onDecide, onOpenSession, disabled }: CardProps) {
  const { inflight, decide } = useDecision(action, onDecide);
  return (
    <div className="herald-action herald-action--hard" role="group" aria-label={`${action.kind === 'babysit_start' ? 'Start babysitting' : 'Needs confirmation'}: ${action.readback}`}>
      <div className="herald-action__eyebrow herald-action__eyebrow--hard">
        <IconAlert />
        <span>{hardEyebrow(action)}</span>
        <SessionChip action={action} onOpenSession={onOpenSession} />
      </div>
      <div className="herald-action__readback">{action.readback}</div>
      <CommandLine action={action} />
      <SuggestedWhy action={action} />
      {action.kind === 'babysit_start' && (
        <div className="herald-action__why">
          Herald will answer this session's simple questions and bring the rest to you. It never answers permission prompts.
        </div>
      )}
      {action.reasons.length > 0 && (
        <ul className="herald-action__reasons">
          {action.reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}
      <VoicePhrase action={action} />
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

/** A started brief reads "Started", not "Sent"; a suggestion nobody sent was only a suggestion. */
function resolvedCopy(action: HeraldAction): string {
  if (action.status === 'pending') return '';
  if (action.kind === 'babysit_start') {
    if (action.status === 'sent') return 'Started';
    if (action.status === 'cancelled') return 'Not started';
  }
  if (action.suggested && action.status === 'expired') return 'Suggestion expired';
  if (action.suggested && action.status === 'cancelled') return 'Suggestion dismissed';
  return RESOLVED_COPY[action.status];
}

export const HeraldResolvedLine = memo(function HeraldResolvedLine({ action, onOpenSession }: { action: HeraldAction; onOpenSession: CardProps['onOpenSession'] }) {
  if (action.status === 'pending') return null;
  const Icon = action.status === 'sent' ? IconCheck : action.status === 'failed' ? IconAlert : action.status === 'expired' ? IconClock : IconX;
  return (
    <div className={`herald-resolved herald-resolved--${action.status}`}>
      <Icon />
      <span className="herald-resolved__status">{resolvedCopy(action)}</span>
      {hasNoSession(action) ? (
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
  const suggestedOnly = isSuggestion(action);
  return (
    <div className={`herald-pending-marker herald-pending-marker--${action.tier}${suggestedOnly ? ' herald-pending-marker--suggested' : ''}`}>
      <span className="herald-pending-marker__pulse" />
      {action.tier === 'hard_confirm' ? 'Waiting for your confirmation' : suggestedOnly ? 'Suggested answer, waiting for you' : 'About to send'}
      <span className="herald-pending-marker__name">{action.sessionName}</span>
    </div>
  );
}

export function HeraldActionCard(props: CardProps) {
  if (props.action.status !== 'pending') {
    return <HeraldResolvedLine action={props.action} onOpenSession={props.onOpenSession} />;
  }
  if (props.action.tier === 'hard_confirm') return <HardConfirmCard {...props} />;
  return isSuggestion(props.action) ? <SuggestedCard {...props} /> : <EchoCard {...props} />;
}
