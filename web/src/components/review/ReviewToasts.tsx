import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useReviewContext, type ReviewToast } from './ReviewContext';

export function ReviewToasts() {
  const ctx = useReviewContext();
  if (!ctx || ctx.toasts.length === 0) return null;
  return createPortal(
    <div className="rv-toasts" role="status" aria-live="polite">
      {ctx.toasts.map((t) => <Toast key={t.id} toast={t} onDone={ctx.dismissToast} />)}
    </div>,
    document.body,
  );
}

function Toast({ toast, onDone }: { toast: ReviewToast; onDone: (id: number) => void }) {
  useEffect(() => {
    const t = setTimeout(() => onDone(toast.id), toast.ttl);
    return () => clearTimeout(t);
  }, [toast.id, toast.ttl, onDone]);
  return (
    <div className={`rv-toast rv-toast--${toast.tone ?? 'info'}`}>
      <span className="rv-toast__text">{toast.text}</span>
      {toast.action && (
        <button
          type="button"
          className="rv-toast__action"
          onClick={() => { toast.action!.run(); onDone(toast.id); }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}
