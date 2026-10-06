import { useEffect, useState } from 'react';
import type { HeraldBabysit, HeraldBabysitStopRequest } from '../../types/herald';
import { activeBabysits, answersText, babysitRemainingMs, formatTimeLeft } from '../../services/babysit';

interface Props {
  babysits: HeraldBabysit[] | undefined;
  skewMs: number | null;
  onOpenSession: (serverId: string, sessionId: string) => void;
  onStop: (req: HeraldBabysitStopRequest) => Promise<string | null>;
  onDone: () => void;
}

/** Herald menu: the sessions being babysat right now, each with Stop. Nothing when there are none. */
export function HeraldBabysitMenu({ babysits, skewMs, onOpenSession, onStop, onDone }: Props) {
  const active = activeBabysits(babysits);
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const any = active.length > 0;
  useEffect(() => {
    if (!any) return;
    const t = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(t);
  }, [any]);

  if (!any) return null;

  const stop = async (b: HeraldBabysit) => {
    setStopping(b.id);
    setNote(null);
    const err = await onStop({ babysitId: b.id });
    setStopping(null);
    if (err) setNote(err);
  };

  return (
    <div className="herald-babysits" role="group" aria-label="Babysitting">
      <div className="herald-menu__label">Babysitting</div>
      {active.map((b) => (
        <div key={b.id} className="herald-babysits__item">
          <button
            type="button"
            className="herald-babysits__open"
            onClick={() => { onOpenSession(b.serverId, b.sessionId); onDone(); }}
            title={`Open ${b.sessionName}: ${b.goal}`}
          >
            <span className="herald-babysits__name">{b.sessionName}</span>
            <span className="herald-babysits__status">
              {answersText(b.answersUsed)}, {formatTimeLeft(babysitRemainingMs(b, now, skewMs))}
              {b.autoSend === false ? ', suggesting only' : ''}
            </span>
          </button>
          <button
            type="button"
            className="herald-btn herald-btn--ghost herald-btn--xs"
            onClick={() => void stop(b)}
            disabled={stopping !== null}
            aria-label={`Stop babysitting ${b.sessionName}`}
          >
            {stopping === b.id ? 'Stopping' : 'Stop'}
          </button>
        </div>
      ))}
      {note && <div className="herald-babysits__note" role="alert">{note}</div>}
    </div>
  );
}
