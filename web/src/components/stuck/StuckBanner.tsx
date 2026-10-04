import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useStuckFindings } from '../../hooks/useStuck';
import { stuckStore } from '../../services/stuckStore';
import type { StuckAskResponse, StuckFinding, StuckInterruptResponse, StuckKind } from '../../types/stuck';

const KIND_LABEL: Record<StuckKind, string> = {
  repeated_failure: 'Same failure, again and again',
  loop: 'Going in circles',
  oscillation: 'Undoing and redoing',
  no_progress: 'No progress',
  stalled_tool: 'A command is hanging',
};

function since(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

type Busy = null | 'ask' | 'interrupt' | 'snooze' | 'dismiss';

/**
 * "Out4 looks stuck": a quiet amber banner above the conversation with what
 * the detector saw, the evidence (expandable) and four actions. Local close
 * hides it for this finding on this device; "Not stuck" tells the daemon
 * (quiet for the rest of the turn).
 */
export const StuckBanner = memo(function StuckBanner({ serverId, sessionId }: { serverId: string; sessionId: string }) {
  const findings = useStuckFindings(serverId, sessionId);
  const [closed, setClosed] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pendingInterrupt, setPendingInterrupt] = useState<{ actionId: string; until: number | null } | null>(null);
  const [, force] = useState(0);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const top: StuckFinding | undefined = findings[0];

  // A different finding re-opens a banner the user closed.
  useEffect(() => {
    if (top && closed && closed !== top.id) setClosed(null);
  }, [top, closed]);

  // Countdown display for a pending interrupt.
  useEffect(() => {
    if (!pendingInterrupt?.until) return;
    const t = setInterval(() => {
      if (Date.now() > (pendingInterrupt.until ?? 0) + 1500) setPendingInterrupt(null);
      force((n) => n + 1);
    }, 500);
    return () => clearInterval(t);
  }, [pendingInterrupt]);

  useEffect(() => () => { if (noteTimer.current) clearTimeout(noteTimer.current); }, []);

  const flash = useCallback((text: string) => {
    setNote(text);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), 6000);
  }, []);

  const run = useCallback(async (what: Exclude<Busy, null>, fn: () => Promise<void>) => {
    setBusy(what);
    try {
      await fn();
    } catch (err) {
      flash(err instanceof Error ? err.message : 'That did not work');
    } finally {
      setBusy(null);
    }
  }, [flash]);

  if (!top || closed === top.id) return null;

  const ids = findings.map((f) => f.id);

  const ask = () => run('ask', async () => {
    const r = await stuckStore.request<StuckAskResponse>(serverId, 'stuck_ask', { findingId: top.id });
    flash(r.via === 'herald' ? `Asked ${top.sessionName}. Herald will tell you what it says.` : `Asked ${top.sessionName}.`);
  });

  const interrupt = () => run('interrupt', async () => {
    const r = await stuckStore.request<StuckInterruptResponse>(serverId, 'stuck_interrupt', { sessionId });
    setPendingInterrupt({ actionId: r.actionId, until: r.autoSendAt });
  });

  const cancelInterrupt = () => run('interrupt', async () => {
    if (!pendingInterrupt) return;
    await stuckStore.request(serverId, 'herald_confirm', { actionId: pendingInterrupt.actionId, decision: 'cancel' });
    setPendingInterrupt(null);
    flash('Interrupt cancelled.');
  });

  const snooze = () => run('snooze', async () => {
    stuckStore.hide(ids);
    try {
      await stuckStore.request(serverId, 'stuck_snooze', { sessionId, minutes: 30 });
    } catch (err) {
      stuckStore.unhide(ids);
      throw err;
    }
  });

  const notStuck = () => run('dismiss', async () => {
    stuckStore.hide([top.id]);
    try {
      await stuckStore.request(serverId, 'stuck_dismiss', { findingId: top.id });
    } catch (err) {
      stuckStore.unhide([top.id]);
      throw err;
    }
  });

  const secondsLeft = pendingInterrupt?.until ? Math.max(0, Math.ceil((pendingInterrupt.until - Date.now()) / 1000)) : null;
  const evidenceId = `stuck-evidence-${top.id.replace(/[^a-z0-9]/gi, '')}`;

  return (
    <section className={`stuck-banner stuck-banner--${top.severity}`} role="status" aria-live="polite" aria-label={`${top.sessionName} looks stuck`}>
      <div className="stuck-banner__main">
        <span className="stuck-banner__dot" aria-hidden="true" />
        <div className="stuck-banner__text">
          <div className="stuck-banner__title">
            <span className="stuck-banner__label">Looks stuck</span>
            <span className="stuck-banner__kind">{KIND_LABEL[top.kind]}</span>
            <span className="stuck-banner__since">for {since(Date.now() - top.firstSeen)}</span>
          </div>
          <div className="stuck-banner__summary">{top.summary}</div>
        </div>
        <button type="button" className="stuck-banner__close" onClick={() => setClosed(top.id)} aria-label="Hide this notice" title="Hide">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
      </div>

      {(top.evidence.length > 0 || findings.length > 1) && (
        <button type="button" className="stuck-banner__toggle" aria-expanded={open} aria-controls={evidenceId} onClick={() => setOpen((v) => !v)}>
          <svg className="stuck-banner__chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {open ? 'Hide evidence' : findings.length > 1 ? `Evidence and ${findings.length - 1} more` : 'Evidence'}
        </button>
      )}
      {open && (
        <div className="stuck-banner__evidence" id={evidenceId}>
          {top.evidence.map((e, i) => <code key={i}>{e}</code>)}
          {findings.slice(1).map((f) => (
            <div key={f.id} className="stuck-banner__more">{f.summary}</div>
          ))}
        </div>
      )}

      <div className="stuck-banner__actions">
        <button type="button" className="stuck-btn stuck-btn--primary" onClick={ask} disabled={busy !== null}>
          {busy === 'ask' ? 'Asking…' : "Ask what's wrong"}
        </button>
        {pendingInterrupt ? (
          <button type="button" className="stuck-btn stuck-btn--danger" onClick={cancelInterrupt} disabled={busy !== null}>
            {secondsLeft ? `Interrupting in ${secondsLeft}s · Cancel` : 'Interrupt sent'}
          </button>
        ) : (
          <button type="button" className="stuck-btn" onClick={interrupt} disabled={busy !== null}>
            {busy === 'interrupt' ? 'Interrupting…' : 'Interrupt'}
          </button>
        )}
        <button type="button" className="stuck-btn" onClick={snooze} disabled={busy !== null}>Snooze 30m</button>
        <button type="button" className="stuck-btn stuck-btn--quiet" onClick={notStuck} disabled={busy !== null}>Not stuck</button>
      </div>
      {note && <div className="stuck-banner__note">{note}</div>}
    </section>
  );
});
