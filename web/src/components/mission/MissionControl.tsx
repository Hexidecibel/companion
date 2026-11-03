import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ServerSummary } from '../../types';
import { useMissionOrder } from '../../hooks/useMissionOrder';
import { waitingSessions } from '../../services/nextWaiting';
import { isUnseen, onLastViewedChange } from '../../services/lastViewed';
import { SessionTile } from './SessionTile';

interface MissionControlProps {
  summaries: Map<string, ServerSummary>;
  /** serverId -> display name (labels show only with 2+ servers). */
  serverNames: Map<string, string>;
  onOpenSession: (serverId: string, sessionId: string, pending: boolean) => void;
}

/** Relative times ("waiting 3m") refresh on this clock. */
const CLOCK_MS = 30_000;
const HIGHLIGHT_MS = 1600;

let lastViewedVersion = 0;
const bumpLastViewed = (cb: () => void) => onLastViewedChange(() => { lastViewedVersion++; cb(); });
const getLastViewedVersion = () => lastViewedVersion;

/**
 * Phone overview: one tile per session on every server, in a fixed per-device
 * order. Sessions that need the user glow amber and, when the daemon reads the
 * prompt, answer from the tile. The "Needs you" strip steps through them
 * (scrolls to each tile) without reordering anything.
 */
export function MissionControl({ summaries, serverNames, onOpenSession }: MissionControlProps) {
  const { entries, move } = useMissionOrder(summaries);
  useSyncExternalStore(bumpLastViewed, getLastViewedVersion, getLastViewedVersion);
  const [now, setNow] = useState(() => Date.now());
  const [highlight, setHighlight] = useState<string | null>(null);
  const stepRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(t);
  }, []);
  // A fresh summary is a good moment to refresh the clock too.
  useEffect(() => { setNow(Date.now()); }, [summaries]);

  useEffect(() => {
    if (!highlight) return;
    const t = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [highlight]);

  const waiting = useMemo(() => waitingSessions(summaries), [summaries]);
  const multiServer = summaries.size > 1;

  const stepToWaiting = useCallback(() => {
    if (waiting.length === 0) return;
    const w = waiting[stepRef.current % waiting.length];
    stepRef.current = (stepRef.current + 1) % waiting.length;
    const key = `${w.serverId}:${w.sessionId}`;
    setHighlight(key);
    const el = listRef.current?.querySelector(`[data-session-key="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(key) : key}"]`);
    el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [waiting]);

  if (entries.length === 0) {
    return (
      <div className="mission-control">
        <div className="mission-empty">No sessions yet. Switch to List to start one.</div>
      </div>
    );
  }

  return (
    <div className="mission-control">
      {waiting.length > 0 && (
        <button
          type="button"
          className="mission-needs-you"
          onClick={stepToWaiting}
          aria-label={`${waiting.length} need you: show the next one`}
        >
          <span className="mission-needs-you__count">{waiting.length}</span>
          <span className="mission-needs-you__label">need{waiting.length === 1 ? 's' : ''} you</span>
          <span className="mission-needs-you__names">{waiting.map((w) => w.name).join(', ')}</span>
        </button>
      )}
      <div className="mission-tiles" ref={listRef}>
        {entries.map((e, i) => (
          <SessionTile
            key={e.key}
            serverId={e.serverId}
            session={e.session}
            serverLabel={multiServer ? serverNames.get(e.serverId) : undefined}
            unseen={isUnseen(e.serverId, e.session.id, e.session.lastActivity, now)}
            now={now}
            highlighted={highlight === `${e.serverId}:${e.session.id}`}
            onOpen={onOpenSession}
            onMoveUp={i > 0 ? () => move(e.key, -1) : undefined}
            onMoveDown={i < entries.length - 1 ? () => move(e.key, 1) : undefined}
          />
        ))}
      </div>
    </div>
  );
}
