/**
 * "Ask why" on a hunk: sends the hunk (with its turn and location) to the
 * session asking Claude to explain it. With Herald on, the answer comes back
 * as an inbox item; otherwise it goes straight into the session.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { REVIEW_LIMITS, type ReviewAskRequest, type ReviewAskResponse, type ReviewHunk, type ReviewTurn } from '../../types/review';
import { reviewErrorMessage, type ReviewRequestFn } from '../../services/reviewApi';
import { hunkLocation, hunkStats } from '../../utils/diff/patchText';
import { IconAsk, IconClose } from './reviewIcons';

export interface AskWhyProps {
  sessionId: string;
  hunk: ReviewHunk;
  absPath: string;
  path: string;
  editId?: string;
  turn?: ReviewTurn;
  request: ReviewRequestFn;
  onClose: () => void;
  onSent: (res: ReviewAskResponse) => void;
}

export function AskWhyPopover({ sessionId, hunk, absPath, path, editId, turn, request, onClose, onSent }: AskWhyProps) {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onClose]);

  const send = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const req: ReviewAskRequest = { sessionId, absPath, hunkId: hunk.id, ...(editId ? { editId } : {}), ...(question.trim() ? { question: question.trim() } : {}) };
      const res = await request<ReviewAskResponse>('review_ask', req);
      onSent(res);
    } catch (err) {
      setError(reviewErrorMessage(err));
      setBusy(false);
    }
  };

  const st = hunkStats(hunk);
  return createPortal(
    <div className="rv-dialog-scrim" onClick={() => !busy && onClose()}>
      <div className="rv-dialog rv-dialog--ask" role="dialog" aria-modal="true" aria-label="Ask why" onClick={(e) => e.stopPropagation()} data-testid="rv-ask">
        <header className="rv-dialog__head">
          <span className="rv-dialog__icon rv-dialog__icon--ask"><IconAsk width={16} height={16} /></span>
          <div className="rv-dialog__titles">
            <div className="rv-dialog__title">Ask Claude why</div>
            <div className="rv-dialog__sub rv-num">
              {hunkLocation(path, hunk)} · <span className="rv-add">+{st.additions}</span> <span className="rv-del">{'−'}{st.deletions}</span>
              {turn ? ` · T${turn.index}` : ''}
            </div>
          </div>
          <button type="button" className="rv-icon-btn" onClick={onClose} aria-label="Close" disabled={busy}><IconClose /></button>
        </header>
        <form onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <textarea
            ref={ref}
            className="rv-ask__input"
            value={question}
            maxLength={REVIEW_LIMITS.maxQuestionChars}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
            placeholder="Anything specific? (optional)"
            rows={3}
            aria-label="Question"
          />
          <div className="rv-ask__hint">Claude gets the hunk, where it is and which turn made it. {question.length > 0 && <span className="rv-num">{question.length}/{REVIEW_LIMITS.maxQuestionChars}</span>}</div>
          {error && <div className="rv-dialog__error" role="alert">{error}</div>}
          <footer className="rv-dialog__foot">
            <button type="button" className="rv-btn rv-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="rv-btn rv-btn--primary" disabled={busy}>{busy ? 'Sending…' : 'Ask why'}</button>
          </footer>
        </form>
      </div>
    </div>,
    document.body,
  );
}
