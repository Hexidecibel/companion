import { memo } from 'react';
import type { HeraldPresence } from '../../services/heraldReducer';

/** Presence plus the transient voice state (only the orb cares about it). */
export type HeraldOrbState = HeraldPresence | 'speaking';

interface HeraldOrbProps {
  presence: HeraldOrbState;
  size?: number;
  /** Mini variant drops the finest detail layers (used in launch buttons). */
  mini?: boolean;
  className?: string;
}

const LABELS: Record<HeraldOrbState, string> = {
  speaking: 'Speaking',
  idle: 'Standing by',
  busy: 'Thinking',
  attention: 'Something needs you',
  disabled: 'Offline',
};

/**
 * Presence orb. Pure SVG + CSS; every animation is transform/opacity only so it
 * stays on the compositor. State is expressed through the `herald-orb--*`
 * modifier, which swaps color tokens and animation speeds in herald.css.
 */
export const HeraldOrb = memo(function HeraldOrb({ presence, size = 44, mini = false, className }: HeraldOrbProps) {
  return (
    <div
      className={`herald-orb herald-orb--${presence}${mini ? ' herald-orb--mini' : ''}${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={LABELS[presence]}
    >
      <span className="herald-orb__halo" />
      <svg className="herald-orb__ring herald-orb__ring--outer" viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="46" pathLength="360" strokeDasharray="70 14 34 14 110 14 22 14 50 18" />
      </svg>
      {!mini && (
        <svg className="herald-orb__ring herald-orb__ring--ticks" viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r="39" pathLength="360" strokeDasharray="1.2 4.8" />
        </svg>
      )}
      <svg className="herald-orb__ring herald-orb__ring--arc" viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="33" pathLength="360" strokeDasharray="84 276" />
      </svg>
      {presence === 'speaking' && (
        <span className="herald-orb__voice" aria-hidden="true">
          <span /><span /><span />
        </span>
      )}
      <span className="herald-orb__core" />
      <span className="herald-orb__glint" />
    </div>
  );
});
