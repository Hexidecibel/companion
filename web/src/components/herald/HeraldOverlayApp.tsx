import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { HeraldOrb, type HeraldOrbState } from './HeraldOrb';
import { IconStop } from './heraldIcons';
import type { OverlayOrb, OverlayView } from '../../services/heraldSetup/overlay';
import { listenOverlayView, overlayAction, overlayReady, setOverlayRegions, startOverlayDrag, type OverlayRect } from '../../services/overlayBridge';

const ORB_STATE: Record<OverlayOrb, HeraldOrbState> = {
  listening: 'listening',
  thinking: 'busy',
  speaking: 'speaking',
  tone: 'attention',
  followup: 'followup',
};

const ORB_LABEL: Record<OverlayOrb, string> = {
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  tone: 'News',
  followup: 'Follow-up?',
};

function rectOf(el: Element | null): OverlayRect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/**
 * The floating orb window (desktop app): a pill with the orb, a one-line
 * caption and a stop button. Everything but the orb (drag; double-click opens
 * Companion) and the stop button clicks through to whatever is underneath.
 */
export function HeraldOverlayApp({ initial = null }: { initial?: OverlayView | null }) {
  const [view, setView] = useState<OverlayView | null>(initial);
  const orbRef = useRef<HTMLDivElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    document.documentElement.classList.add('herald-overlay-root');
    let off: (() => void) | null = null;
    let cancelled = false;
    void listenOverlayView(setView).then((u) => {
      if (cancelled) u();
      else {
        off = u;
        void overlayReady();
      }
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const phase = view?.phase ?? 'hidden';
  const orb = view?.orb ?? 'thinking';
  const stoppable = orb === 'listening' || orb === 'speaking' || orb === 'thinking' || orb === 'followup';

  // Tell the native side where the clickable parts are (after every layout change).
  useLayoutEffect(() => {
    const regions = [rectOf(orbRef.current), stoppable ? rectOf(stopRef.current) : null].filter((r): r is OverlayRect => !!r);
    void setOverlayRegions(regions);
  }, [stoppable, view?.caption, phase]);

  const onOrbDown = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    if (e.detail >= 2) {
      void overlayAction('open');
      return;
    }
    void startOverlayDrag();
  }, []);

  return (
    <div className={`herald-overlay herald-overlay--${phase} herald-overlay--${orb}`} aria-live="polite">
      <div className="herald-overlay__pill">
        <div
          ref={orbRef}
          className="herald-overlay__orb"
          onPointerDown={onOrbDown}
          title="Drag to move. Double-click to open Companion."
        >
          <HeraldOrb presence={ORB_STATE[orb]} size={44} mini countdown={orb === 'followup' ? view?.countdown ?? null : null} />
        </div>
        <div className="herald-overlay__text">
          <span className="herald-overlay__state">{ORB_LABEL[orb]}</span>
          <span className="herald-overlay__caption">{view?.caption ?? ''}</span>
        </div>
        {stoppable && (
          <button
            ref={stopRef}
            type="button"
            className="herald-overlay__stop"
            onClick={() => void overlayAction('stop')}
            aria-label="Stop Herald"
            title="Stop"
          >
            <IconStop size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
