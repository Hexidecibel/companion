import { useCallback, useEffect, useRef, useState } from 'react';

export const HOLD_MS = 1200;

/**
 * Press-and-hold confirm. Pointer or keyboard (hold Space / Enter). The fill is
 * a CSS transform transition, so the animation itself never touches React.
 */
export function HoldToConfirm({
  onConfirm,
  disabled,
  busy,
  label = 'Hold to confirm',
  busyLabel = 'Confirming',
  ariaLabel = 'Press and hold to confirm. Hold Space or Enter for about one second.',
}: {
  onConfirm: () => void;
  disabled?: boolean;
  busy?: boolean;
  label?: string;
  busyLabel?: string;
  ariaLabel?: string;
}) {
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
      aria-label={ariaLabel}
    >
      <span className="herald-hold__fill" style={{ transitionDuration: holding ? `${HOLD_MS}ms` : undefined }} />
      <span className="herald-hold__label">{busy ? busyLabel : holding ? 'Keep holding' : label}</span>
    </button>
  );
}
