import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

export type ContextMenuEntry = ContextMenuItem | null; // null = divider

interface ContextMenuProps {
  items: ContextMenuEntry[];
  position: { x: number; y: number };
  onClose: () => void;
}

export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Adjust position if menu overflows viewport
    const el = menuRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      el.style.left = `${window.innerWidth - rect.width - 8}px`;
    }
    if (rect.bottom > window.innerHeight) {
      el.style.top = `${window.innerHeight - rect.height - 8}px`;
    }
  }, [position]);

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // The user scrolling away closes the menu. Not the `scroll` event: it also
    // fires when a live conversation auto-scrolls, which closed the menu under
    // the pointer before the click landed.
    const handleUserScroll = (e: Event) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('wheel', handleUserScroll, { passive: true });
    document.addEventListener('touchmove', handleUserScroll, { passive: true });

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('wheel', handleUserScroll);
      document.removeEventListener('touchmove', handleUserScroll);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: position.x, top: position.y }}
    >
      {items.map((item, i) => {
        if (item === null) {
          return <div key={`d-${i}`} className="context-menu-divider" />;
        }
        return (
          <button
            key={item.label}
            className={`context-menu-item ${item.danger ? 'danger' : ''} ${item.disabled ? 'disabled' : ''}`}
            onClick={() => {
              if (!item.disabled) {
                item.onClick();
                onClose();
              }
            }}
            disabled={item.disabled}
          >
            {item.label}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
