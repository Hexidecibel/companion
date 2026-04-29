import { useEffect, useRef } from 'react';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  // Notify (per-session mute)
  notifyEnabled: boolean;
  onToggleNotify: () => void;
  // Bypass permissions
  bypassEnabled: boolean;
  bypassLoading: boolean;
  onToggleBypass: () => void;
  // Hide tools (inverted: showTools = !hideTools)
  hideTools: boolean;
  onToggleHideTools: () => void;
}

/**
 * Session-level settings modal. Houses toggles previously rendered as a
 * row of pill-buttons on the SessionView. Pure presentation: state lives
 * in SessionView and is passed down via props so the hooks remain owned
 * by the parent.
 */
export function SettingsModal({
  open,
  onClose,
  notifyEnabled,
  onToggleNotify,
  bypassEnabled,
  bypassLoading,
  onToggleBypass,
  hideTools,
  onToggleHideTools,
}: SettingsModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // ESC closes; basic focus management on open/close
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      // Minimal focus trap: cycle Tab within modal
      if (e.key === 'Tab' && cardRef.current) {
        const focusable = cardRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey);

    // Move focus into the modal (close button is a safe default)
    requestAnimationFrame(() => {
      const closeBtn = cardRef.current?.querySelector<HTMLElement>('.modal-close');
      closeBtn?.focus();
    });

    return () => {
      document.removeEventListener('keydown', handleKey);
      // Restore focus to where it was before
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={cardRef}
        className="modal-content settings-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
      >
        <div className="modal-header">
          <h3 id="settings-modal-title">Session Settings</h3>
          <button
            className="modal-close"
            onClick={onClose}
            aria-label="Close settings"
          >
            &times;
          </button>
        </div>

        <div className="settings-modal-body">
          <ToggleRow
            title="Notifications"
            detail="Browser & push notifications for this session"
            checked={notifyEnabled}
            onChange={onToggleNotify}
          />
          <ToggleRow
            title="Bypass permissions"
            detail="Tools run without permission prompts"
            checked={bypassEnabled}
            disabled={bypassLoading}
            onChange={onToggleBypass}
          />
          <ToggleRow
            title="Show tool cards"
            detail="Display tool invocations & results inline in the conversation"
            checked={!hideTools}
            onChange={onToggleHideTools}
          />
        </div>
      </div>
    </div>
  );
}

interface ToggleRowProps {
  title: string;
  detail?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}

function ToggleRow({ title, detail, checked, disabled, onChange }: ToggleRowProps) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-row-title">{title}</div>
        {detail && <div className="settings-row-detail">{detail}</div>}
      </div>
      <label className="notif-toggle">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={onChange}
        />
        <span className="notif-toggle-slider" />
      </label>
    </div>
  );
}
