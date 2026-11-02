import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface PromptDialogProps {
  title: string;
  label: string;
  initialValue?: string;
  submitLabel: string;
  busyLabel?: string;
  /** A rejection keeps the dialog open and shows its message. */
  onSubmit: (value: string) => void | Promise<void>;
  /** Cancelled, or submitted successfully. */
  onClose: () => void;
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/**
 * In-app replacement for window.prompt, same conventions as ConfirmDialog.
 * WKWebView does nothing for a prompt unless the host implements the text-input
 * panel, and wry does not (macOS, iOS).
 */
export function PromptDialog({ title, label, initialValue = '', submitLabel, busyLabel, onSubmit, onClose }: PromptDialogProps) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const latest = useRef({ busy, onClose });
  latest.current = { busy, onClose };

  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    const input = inputRef.current;
    input?.focus();
    input?.select();
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
      const items = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)') ?? [],
      );
      if (items.length === 0) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at + 1) % items.length;
      e.preventDefault();
      items[next].focus();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value);
      if (mounted.current) onClose();
    } catch (err) {
      if (!mounted.current) return;
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
      inputRef.current?.focus();
    }
  };

  // React events bubble through portals: without the stops, a click or key in
  // here would also reach the session row the dialog was opened from.
  return createPortal(
    <div
      className="modal-overlay confirm-dialog-overlay"
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      onContextMenu={stop}
      onKeyDown={stop}
      onTouchStart={stop}
      onTouchMove={stop}
      onTouchEnd={stop}
    >
      <form
        ref={dialogRef}
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-dialog-title"
        onSubmit={(e) => void submit(e)}
      >
        <h3 id="prompt-dialog-title" className="confirm-dialog-title">{title}</h3>
        <label className="confirm-dialog-label" htmlFor="prompt-dialog-input">{label}</label>
        <input
          ref={inputRef}
          id="prompt-dialog-input"
          className="confirm-dialog-input"
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
        />
        {error && <div className="confirm-dialog-error" role="alert">{error}</div>}
        <div className="confirm-dialog-actions">
          <button type="button" className="confirm-dialog-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="confirm-dialog-btn confirm-dialog-btn-primary" disabled={busy}>
            {busy ? busyLabel ?? submitLabel : submitLabel}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
