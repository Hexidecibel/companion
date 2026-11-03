import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useBabysit, useBabysitClock } from '../../hooks/useBabysit';
import { babysitStatusLine, babysitStore, logKindLabel } from '../../services/babysit';
import type { HeraldBabysitSuggestion } from '../../types/herald';
import { HoldToConfirm } from '../common/HoldToConfirm';

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * The question Herald brought to the user, with the answer it would send:
 * Send / Cancel act on the same herald action card (herald_confirm), so a
 * hard_confirm suggestion needs the same press-and-hold as the card.
 */
function SuggestionBlock({ s, connected }: { s: HeraldBabysitSuggestion; connected: boolean }) {
  const [inflight, setInflight] = useState<'confirm' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  // A new suggestion starts clean.
  useEffect(() => {
    setInflight(null);
    setError(null);
  }, [s.actionId]);

  const decide = useCallback(async (d: 'confirm' | 'cancel') => {
    if (inflight) return;
    setInflight(d);
    setError(null);
    const res = await babysitStore.confirm(s.actionId, d);
    if (!mounted.current) return;
    setInflight(null);
    if (!res) setError(d === 'confirm' ? 'Could not send the answer.' : 'Could not cancel the suggestion.');
  }, [inflight, s.actionId]);

  const risky = s.tier === 'hard_confirm';
  const disabled = !connected;
  return (
    <div
      className={`babysit-suggest${risky ? ' babysit-suggest--risky' : ''}`}
      role="group"
      aria-label="Herald's suggested answer"
    >
      <div className="babysit-suggest__label">{risky ? 'Needs your say-so' : 'Your call'}</div>
      <div className="babysit-suggest__q">{s.question}</div>
      <div className="babysit-suggest__a">
        <span className="babysit-suggest__a-label">Suggested answer</span>
        <span className="babysit-suggest__a-text">{s.answer}</span>
      </div>
      {s.reason && <div className="babysit-suggest__why">{s.reason}</div>}
      {risky && s.reasons && s.reasons.length > 0 && (
        <ul className="babysit-suggest__reasons">
          {s.reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}
      <div className="babysit-suggest__buttons">
        {risky ? (
          <HoldToConfirm
            onConfirm={() => void decide('confirm')}
            disabled={disabled || inflight === 'cancel'}
            busy={inflight === 'confirm'}
            label="Hold to send"
            busyLabel="Sending"
            ariaLabel="Press and hold to send the suggested answer. Hold Space or Enter for about one second."
          />
        ) : (
          <button
            type="button"
            className="babysit-btn babysit-btn--primary"
            onClick={() => void decide('confirm')}
            disabled={disabled || !!inflight}
          >
            {inflight === 'confirm' ? 'Sending…' : 'Send'}
          </button>
        )}
        <button
          type="button"
          className="babysit-btn"
          onClick={() => void decide('cancel')}
          disabled={disabled || !!inflight}
        >
          {inflight === 'cancel' ? 'Cancelling…' : 'Cancel'}
        </button>
      </div>
      {error && <div className="babysit-suggest__error" role="alert">{error}</div>}
    </div>
  );
}

/**
 * "Babysitting: 4 answers, 26 min left": a quiet blue bar above the
 * conversation while Herald answers this session's simple questions, with the
 * log of what it sent (expandable), the question it brought to the user (with
 * its suggested answer, Send / Cancel), Edit and Stop. After the brief ends it
 * stays (about an hour, or until closed) to say why.
 */
export const BabysitBar = memo(function BabysitBar({ serverId, sessionId, onEdit }: { serverId: string; sessionId: string; onEdit: () => void }) {
  const { babysit, active, connected, skewMs } = useBabysit(serverId, sessionId);
  const now = useBabysitClock(active);
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [closed, setClosed] = useState<string | null>(null);

  // The view is reused across sessions: nothing local may carry over.
  useEffect(() => {
    setOpen(false);
    setStopping(false);
    setNote(null);
    setClosed(null);
  }, [serverId, sessionId]);

  const id = babysit?.id;
  const stop = useCallback(async () => {
    if (!id) return;
    setStopping(true);
    setNote(null);
    const err = await babysitStore.stop({ babysitId: id });
    setStopping(false);
    if (err) setNote(err);
  }, [id]);

  if (!babysit) return null;
  if (!active && closed === babysit.id) return null;

  const logId = `babysit-log-${babysit.id.replace(/[^a-z0-9]/gi, '')}`;
  const log = babysit.log;
  const suggestOnly = babysit.autoSend === false;

  return (
    <section
      className={`babysit-bar${active ? '' : ' babysit-bar--ended'}`}
      role="status"
      aria-live="polite"
      aria-label={active ? `Herald is babysitting ${babysit.sessionName}` : `Babysitting ${babysit.sessionName} ended`}
    >
      <div className="babysit-bar__main">
        <span className="babysit-bar__dot" aria-hidden="true" />
        <div className="babysit-bar__text">
          <div className="babysit-bar__title">
            <span className="babysit-bar__label">{babysitStatusLine(babysit, now, skewMs)}</span>
            {active && (
              <span className="babysit-bar__meta">
                up to {babysit.maxAnswers}
                {babysit.escalations > 0 ? `, ${babysit.escalations} brought to you` : ''}
              </span>
            )}
          </div>
          <div className="babysit-bar__goal" title={babysit.goal}>{babysit.goal}</div>
          {active && suggestOnly && (
            <div className="babysit-bar__hint">Suggesting only: this server never sends an answer by itself.</div>
          )}
        </div>
        {!active && (
          <button type="button" className="babysit-bar__close" onClick={() => setClosed(babysit.id)} aria-label="Hide this notice" title="Hide">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        )}
      </div>

      {active && babysit.pendingSuggestion && (
        <SuggestionBlock s={babysit.pendingSuggestion} connected={connected} />
      )}

      {log.length > 0 && (
        <button type="button" className="babysit-bar__toggle" aria-expanded={open} aria-controls={logId} onClick={() => setOpen((v) => !v)}>
          <svg className="babysit-bar__chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {open ? 'Hide log' : `Log (${log.length})`}
        </button>
      )}
      {open && log.length > 0 && (
        <ol className="babysit-bar__log" id={logId}>
          {[...log].reverse().map((e, i) => (
            <li key={`${e.at}-${i}`} className={`babysit-log babysit-log--${e.kind}`}>
              <div className="babysit-log__head">
                <span className="babysit-log__kind">{logKindLabel(e)}</span>
                <time dateTime={new Date(e.at).toISOString()}>{clock(e.at + (skewMs ?? 0))}</time>
              </div>
              {e.question && <div className="babysit-log__q">{e.question}</div>}
              {e.answer && <div className="babysit-log__a">{e.answer}</div>}
              {e.reason && <div className="babysit-log__why">{e.reason}</div>}
            </li>
          ))}
        </ol>
      )}

      <div className="babysit-bar__actions">
        {active ? (
          <>
            <button type="button" className="babysit-btn" onClick={onEdit} disabled={stopping}>Edit</button>
            <button type="button" className="babysit-btn babysit-btn--stop" onClick={stop} disabled={stopping || !connected}>
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          </>
        ) : (
          <button type="button" className="babysit-btn" onClick={onEdit}>Babysit again</button>
        )}
      </div>
      {note && <div className="babysit-bar__note" role="alert">{note}</div>}
    </section>
  );
});
