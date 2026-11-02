import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface ConfirmDialogProps {
  title: string;
  message?: string;
  confirmLabel: string;
  busyLabel?: string;
  danger?: boolean;
  /** A rejection keeps the dialog open and shows its message. */
  onConfirm: () => void | Promise<void>;
  /** Cancelled, or confirmed successfully. */
  onClose: () => void;
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/**
 * In-app replacement for window.confirm. The webview's own dialog is not
 * dependable: WKWebView returns false without showing anything unless the host
 * implements the confirm panel, and wry does not (macOS, iOS).
 */
export function ConfirmDialog({ title, message, confirmLabel, busyLabel, danger, onConfirm, onClose }: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const latest = useRef({ busy, onClose });
  latest.current = { busy, onClose };

  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => {
      mounted.current = false;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Capture phase: Esc means "cancel this", not also "stop Herald speaking".
        e.stopPropagation();
        e.preventDefault();
        if (!latest.current.busy) latest.current.onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      if (buttons.length === 0) return;
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.shiftKey ? (at <= 0 ? buttons.length - 1 : at - 1) : (at + 1) % buttons.length;
      e.preventDefault();
      buttons[next].focus();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      if (mounted.current) onClose();
    } catch (err) {
      if (!mounted.current) return;
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // React events bubble through portals: without the stops, a click in here
  // would also select the session row the dialog was opened from.
  return createPortal(
    <div
      className="modal-overlay confirm-dialog-overlay"
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      onContextMenu={stop}
      onTouchStart={stop}
      onTouchMove={stop}
      onTouchEnd={stop}
    >
      <div
        ref={dialogRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby={message ? 'confirm-dialog-message' : undefined}
      >
        <h3 id="confirm-dialog-title" className="confirm-dialog-title">{title}</h3>
        {message && <p id="confirm-dialog-message" className="confirm-dialog-message">{message}</p>}
        {error && <div className="confirm-dialog-error" role="alert">{error}</div>}
        <div className="confirm-dialog-actions">
          <button ref={cancelRef} type="button" className="confirm-dialog-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`confirm-dialog-btn${danger ? ' confirm-dialog-btn-danger' : ' confirm-dialog-btn-primary'}`}
            onClick={() => void confirm()}
            disabled={busy}
          >
            {busy ? busyLabel ?? confirmLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
