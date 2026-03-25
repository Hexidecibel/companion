import { useState, useCallback, useRef } from 'react';

interface UseDraggableOptions {
  direction: 'horizontal' | 'vertical';
  initialValue: number;
  min?: number;
  max?: number;
  /** Custom transform from mouse event to value. Receives the raw MouseEvent and
   *  the mousedown event for reference. When omitted, uses clientX (horizontal)
   *  or clientY (vertical). */
  transform?: (moveEvent: MouseEvent, startEvent: React.MouseEvent) => number;
  /** Called on every move with the clamped value. */
  onResize?: (value: number) => void;
  /** Called once on mouseup with the final clamped value. Use for snap logic etc. */
  onResizeEnd?: (value: number) => number | void;
  storageKey?: string;
}

interface UseDraggableReturn {
  value: number;
  onMouseDown: (e: React.MouseEvent) => void;
  isDragging: boolean;
}

export function useDraggable(options: UseDraggableOptions): UseDraggableReturn {
  const {
    direction,
    initialValue,
    min,
    max,
    transform,
    onResize,
    onResizeEnd,
    storageKey,
  } = options;

  const [value, setValue] = useState(() => {
    if (storageKey) {
      const stored = localStorage.getItem(storageKey);
      if (stored) return parseFloat(stored);
    }
    return initialValue;
  });

  const draggingRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);

  const clamp = useCallback(
    (v: number) => {
      let clamped = v;
      if (min != null) clamped = Math.max(clamped, min);
      if (max != null) clamped = Math.min(clamped, max);
      return clamped;
    },
    [min, max],
  );

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      setIsDragging(true);
      const cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
      document.body.style.cursor = cursor;
      document.body.style.userSelect = 'none';

      const startEvent = e;

      const toValue = (ev: MouseEvent) => {
        if (transform) return transform(ev, startEvent);
        return direction === 'horizontal' ? ev.clientX : ev.clientY;
      };

      const onMouseMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const clamped = clamp(toValue(ev));
        setValue(clamped);
        onResize?.(clamped);
      };

      const onMouseUp = (ev: MouseEvent) => {
        draggingRef.current = false;
        setIsDragging(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        let final = clamp(toValue(ev));
        const snapped = onResizeEnd?.(final);
        if (snapped != null) final = snapped;
        setValue(final);
        if (storageKey) {
          localStorage.setItem(storageKey, String(final));
        }
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [direction, clamp, transform, onResize, onResizeEnd, storageKey],
  );

  return { value, onMouseDown, isDragging };
}
