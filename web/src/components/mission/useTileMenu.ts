import { useCallback, useRef, useState } from 'react';

const LONG_PRESS_MS = 500;

/**
 * Tap opens, long-press (or right-click) opens the tile menu (Move up / down,
 * Mark done / Unmark). Shared by full tiles and compact Quiet rows.
 * `hasMenu` false: long-press does nothing.
 */
export function useTileMenu(open: () => void, hasMenu: boolean) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    didLongPress.current = false;
    if (!hasMenu) return;
    const t = e.touches[0];
    const pos = { x: t.clientX, y: t.clientY };
    pressTimer.current = setTimeout(() => {
      didLongPress.current = true;
      setMenu(pos);
      if (navigator.vibrate) navigator.vibrate(40);
    }, LONG_PRESS_MS);
  }, [hasMenu]);

  const cancelPress = useCallback(() => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }, []);

  const onClick = useCallback(() => {
    if (didLongPress.current) {
      didLongPress.current = false;
      return;
    }
    if (menu) return;
    open();
  }, [menu, open]);

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    if (!hasMenu) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  }, [hasMenu]);

  return {
    menu,
    closeMenu: useCallback(() => setMenu(null), []),
    handlers: { onClick, onTouchStart, onTouchEnd: cancelPress, onTouchMove: cancelPress, onContextMenu },
  };
}
