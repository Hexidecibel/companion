import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface OverflowMenuItem {
  /** Stable key + visible label */
  label: string;
  onClick: () => void;
  /** Optional trailing annotation, e.g. a count like "(3)" */
  badge?: string | number;
  /** Highlight as active (e.g. an open/toggled view) */
  active?: boolean;
  disabled?: boolean;
}

interface HeaderOverflowMenuProps {
  items: OverflowMenuItem[];
  /**
   * Optional visible label for the trigger. When provided, the trigger renders
   * as a labeled button ("<label> ▾") instead of the bare "⋮" kebab — used for
   * the mobile "Tools" dropdown.
   */
  label?: string;
}

/**
 * Compact dropdown menu for the session header on mobile.
 *
 * Renders a trigger button (either a labeled "<label> ▾" control or the bare
 * "⋮" kebab) that opens a dropdown anchored to the trigger. Reuses the app's
 * existing `.context-menu` popup styling so it matches the message context
 * menu / other dropdowns. Closes on selection, outside tap, scroll, and
 * Escape. Each item invokes the same handler the original header button used —
 * no behavior change.
 */
export function HeaderOverflowMenu({ items, label }: HeaderOverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Anchor the menu to the trigger: top-right aligned under the button.
  useEffect(() => {
    if (!open) return;
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      top: rect.bottom + 4,
      right: Math.max(window.innerWidth - rect.right, 8),
    });
  }, [open]);

  // Outside tap / scroll / Escape close handling (matches ContextMenu).
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const handleScroll = () => setOpen(false);

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [open]);

  if (items.length === 0) return null;

  return (
    <>
      <button
        ref={triggerRef}
        className={label ? 'session-header-btn session-header-tools-btn' : 'session-header-overflow-btn'}
        onClick={() => setOpen((v) => !v)}
        title={label ?? 'More actions'}
        aria-label={label ?? 'More actions'}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {label ? (
          <>
            <span>{label}</span>
            {/* Down chevron */}
            <span className="session-header-tools-chevron">{'▾'}</span>
          </>
        ) : (
          /* Vertical ellipsis (kebab) */
          '⋮'
        )}
      </button>
      {open && pos &&
        createPortal(
          <div
            ref={menuRef}
            className="context-menu"
            role="menu"
            style={{ top: pos.top, right: pos.right }}
          >
            {items.map((item) => (
              <button
                key={item.label}
                role="menuitem"
                className={`context-menu-item header-overflow-item ${item.active ? 'active' : ''} ${item.disabled ? 'disabled' : ''}`}
                disabled={item.disabled}
                onClick={() => {
                  if (item.disabled) return;
                  item.onClick();
                  setOpen(false);
                }}
              >
                <span className="header-overflow-label">{item.label}</span>
                {item.badge != null && item.badge !== '' && (
                  <span className="header-overflow-badge">{item.badge}</span>
                )}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
