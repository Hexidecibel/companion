import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ServerSummary } from '../../types';
import { waitingSessions, type SessionRef } from '../../services/nextWaiting';
import { getMarkedDoneVersion, markDone, onMarkedDoneChange } from '../../services/markedDone';
import { formatAgo } from './SessionTile';

interface NeedsYouChipProps {
  summaries: Map<string, ServerSummary>;
  /** The session on screen (left out of the count). */
  current: SessionRef | null;
  /** Open that session (the caller replaces the history entry). */
  onJump: (serverId: string, sessionId: string) => void;
  now?: number;
}

const LONG_PRESS_MS = 500;

/**
 * Session header chip: "2 need you". Tap = the session waiting longest;
 * long-press (or right-click) lists them all, each with "Mark done" for
 * when the automatic call was wrong.
 */
export function NeedsYouChip({ summaries, current, onJump, now = Date.now() }: NeedsYouChipProps) {
  const markedVersion = useSyncExternalStore(onMarkedDoneChange, getMarkedDoneVersion, getMarkedDoneVersion);
  // markedVersion: recount when a session is marked done (the store is read inside).
  const waiting = useMemo(() => waitingSessions(summaries, current), [summaries, current, markedVersion]);
  const [listOpen, setListOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!listOpen) return;
    const onDown = (e: Event) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setListOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setListOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [listOpen]);

  // Nothing left to list: close.
  useEffect(() => { if (waiting.length === 0) setListOpen(false); }, [waiting.length]);

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  if (waiting.length === 0) return null;
  const n = waiting.length;
  const label = `${n} need${n === 1 ? 's' : ''} you`;

  return (
    <div className="needs-you" ref={rootRef}>
      <button
        type="button"
        className="needs-you-chip"
        aria-label={`${label}: open the session waiting longest`}
        title={`${label}. Tap: next waiting session. Hold: list them.`}
        onTouchStart={() => {
          didLongPress.current = false;
          timer.current = setTimeout(() => {
            didLongPress.current = true;
            setListOpen(true);
            if (navigator.vibrate) navigator.vibrate(40);
          }, LONG_PRESS_MS);
        }}
        onTouchEnd={cancel}
        onTouchMove={cancel}
        onContextMenu={(e) => {
          e.preventDefault();
          setListOpen(true);
        }}
        onClick={() => {
          if (didLongPress.current) {
            didLongPress.current = false;
            return;
          }
          const next = waiting[0];
          onJump(next.serverId, next.sessionId);
        }}
      >
        <span className="needs-you-chip__count">{n}</span>
        <span className="needs-you-chip__label">need{n === 1 ? 's' : ''} you</span>
      </button>
      {listOpen && (
        <div className="needs-you-list" role="menu" aria-label="Sessions that need you">
          {waiting.map((w) => (
            <div key={`${w.serverId}:${w.sessionId}`} className="needs-you-list__row">
              <button
                type="button"
                role="menuitem"
                className="needs-you-list__item"
                onClick={() => {
                  setListOpen(false);
                  onJump(w.serverId, w.sessionId);
                }}
              >
                <span className="needs-you-list__name">{w.name}</span>
                <span className="needs-you-list__time">{formatAgo(Math.max(0, now - w.waitingSince))}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="needs-you-list__done"
                aria-label={`Mark ${w.name} done`}
                onClick={() => {
                  const s = summaries.get(w.serverId)?.sessions.find((x) => x.id === w.sessionId);
                  if (s) markDone(w.serverId, s);
                }}
              >
                Mark done
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
