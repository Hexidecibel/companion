import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ServerSummary } from '../../types';
import { useMissionOrder } from '../../hooks/useMissionOrder';
import { waitingSessions } from '../../services/nextWaiting';
import { isUnseen, onLastViewedChange } from '../../services/lastViewed';
import { missionSection, missionState, type MissionState } from '../../services/missionState';
import type { MissionEntry } from '../../hooks/useMissionOrder';
import { SessionTile } from './SessionTile';
import { QuietRow } from './QuietRow';

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

interface Placed {
  entry: MissionEntry;
  state: MissionState;
  unseen: boolean;
}

/**
 * Phone overview: every session on every server, in a fixed per-device order,
 * split in two sections. Top: full tiles for sessions that need the user
 * (amber; answer from the tile when the daemon reads the prompt), are working
 * (blue), or finished and reported back since last viewed (green). Below:
 * "Quiet", one compact row per idle / already-seen session. A session only
 * changes section when its state changes; inside a section the saved order
 * holds. The "Needs you" strip steps through the ones that need the user
 * (scrolls to each tile) without reordering anything.
 */
export function MissionControl({ summaries, serverNames, onOpenSession }: MissionControlProps) {
  const { entries, move } = useMissionOrder(summaries);
  const viewedVersion = useSyncExternalStore(bumpLastViewed, getLastViewedVersion, getLastViewedVersion);
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

  const { active, quiet, activeKeys, quietKeys } = useMemo(() => {
    const active: Placed[] = [];
    const quiet: Placed[] = [];
    for (const entry of entries) {
      const unseen = isUnseen(entry.serverId, entry.session.id, entry.session.lastActivity, now);
      const state = missionState(entry.session, unseen);
      (missionSection(state) === 'active' ? active : quiet).push({ entry, state, unseen });
    }
    return {
      active, quiet,
      activeKeys: new Set(active.map((p) => p.entry.key)),
      quietKeys: new Set(quiet.map((p) => p.entry.key)),
    };
    // viewedVersion: re-split when a session is marked viewed (isUnseen reads the store).
  }, [entries, now, viewedVersion]);

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
        {active.map(({ entry: e, state, unseen }, i) => (
          <SessionTile
            key={e.key}
            serverId={e.serverId}
            session={e.session}
            serverLabel={multiServer ? serverNames.get(e.serverId) : undefined}
            unseen={unseen}
            state={state}
            now={now}
            highlighted={highlight === `${e.serverId}:${e.session.id}`}
            onOpen={onOpenSession}
            onMoveUp={i > 0 ? () => move(e.key, -1, activeKeys) : undefined}
            onMoveDown={i < active.length - 1 ? () => move(e.key, 1, activeKeys) : undefined}
          />
        ))}
        {quiet.length > 0 && (
          <section className="mission-quiet-section" aria-label="Quiet sessions">
            <div className="mission-quiet-section__title">Quiet</div>
            {quiet.map(({ entry: e, unseen }, i) => (
              <QuietRow
                key={e.key}
                serverId={e.serverId}
                session={e.session}
                serverLabel={multiServer ? serverNames.get(e.serverId) : undefined}
                unseen={unseen}
                now={now}
                onOpen={onOpenSession}
                onMoveUp={i > 0 ? () => move(e.key, -1, quietKeys) : undefined}
                onMoveDown={i < quiet.length - 1 ? () => move(e.key, 1, quietKeys) : undefined}
              />
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
