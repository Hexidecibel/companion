/**
 * Revert confirmation. Asks the daemon for a preview first: the reasons, the
 * exact patch that will hit the disk, and the tier. "echo" is one tap;
 * "hard_confirm" (deletes, whole files, high risk, big, or the session is
 * working) needs a press-and-hold. Blocked previews only explain why.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  ReviewRevertPreviewRequest, ReviewRevertPreviewResponse, ReviewRevertRequest, ReviewRevertResponse, ReviewRevertTarget,
} from '../../types/review';
import { HoldToConfirm } from '../common/HoldToConfirm';
import { reviewErrorMessage, type ReviewRequestFn } from '../../services/reviewApi';
import { lineKind } from '../../utils/diff/patchText';
import { IconAlert, IconClose, IconRevert } from './reviewIcons';
import { baseName } from '../../utils/diff/patchText';

export interface RevertDialogProps {
  sessionId: string;
  target: ReviewRevertTarget;
  /** Display path. */
  path: string;
  request: ReviewRequestFn;
  device: string;
  onClose: () => void;
  onDone: (res: ReviewRevertResponse) => void;
}

const EFFECT_COPY = { patch: 'Undo this change', restore: 'Restore the file', delete: 'Delete the file' } as const;

export function RevertDialog({ sessionId, target, path, request, device, onClose, onDone }: RevertDialogProps) {
  const [preview, setPreview] = useState<ReviewRevertPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tell, setTell] = useState(true);
  const [expired, setExpired] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    setPreview(null);
    setError(null);
    setExpired(false);
    try {
      const req: ReviewRevertPreviewRequest = { sessionId, target };
      const res = await request<ReviewRevertPreviewResponse>('review_revert_preview', req);
      if (alive.current) setPreview(res);
    } catch (err) {
      if (alive.current) setError(reviewErrorMessage(err));
    }
  }, [sessionId, target, request]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!preview?.token) return;
    const ms = preview.expiresAt - Date.now();
    if (ms <= 0) { setExpired(true); return; }
    const t = setTimeout(() => setExpired(true), ms);
    return () => clearTimeout(t);
  }, [preview]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onClose]);

  const confirm = useCallback(async (how: 'tap' | 'hold') => {
    if (!preview?.token || busy) return;
    setBusy(true);
    setError(null);
    try {
      const req: ReviewRevertRequest = { token: preview.token, confirm: how, notifySession: tell, device };
      const res = await request<ReviewRevertResponse>('review_revert', req);
      onDone(res);
    } catch (err) {
      if (alive.current) setError(reviewErrorMessage(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [preview, busy, tell, device, request, onDone]);

  const hard = preview?.tier === 'hard_confirm';
  const title = target.kind === 'hunk' ? 'Revert this hunk?' : target.to === 'head' ? 'Revert file to the last commit?' : 'Revert file to when you last looked?';

  return createPortal(
    <div className="rv-dialog-scrim" onClick={() => !busy && onClose()}>
      <div
        className={`rv-dialog${hard ? ' rv-dialog--hard' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        data-testid="rv-revert-dialog"
      >
        <header className="rv-dialog__head">
          <span className={`rv-dialog__icon${hard ? ' rv-dialog__icon--hard' : ''}`}><IconRevert width={16} height={16} /></span>
          <div className="rv-dialog__titles">
            <div className="rv-dialog__title">{title}</div>
            <div className="rv-dialog__sub" title={path}>{baseName(path)}{preview ? ` · ${EFFECT_COPY[preview.effect]}` : ''}</div>
          </div>
          <button type="button" className="rv-icon-btn" onClick={onClose} aria-label="Close" disabled={busy}><IconClose /></button>
        </header>

        {!preview && !error && <div className="rv-dialog__loading rv-shimmer">Checking what this would change…</div>}

        {preview?.blocked && (
          <div className="rv-dialog__blocked" role="alert">
            <IconAlert width={16} height={16} />
            <div>
              <strong>Can't revert this right now.</strong>
              <p>{preview.blocked.message}</p>
            </div>
          </div>
        )}

        {preview && !preview.blocked && (
          <>
            {preview.reasons.length > 0 && (
              <ul className="rv-dialog__reasons">
                {preview.reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            )}
            <div className="rv-dialog__patchhead rv-num">
              What changes on disk
              <span><span className="rv-add">+{preview.additions}</span> <span className="rv-del">{'−'}{preview.deletions}</span></span>
            </div>
            <pre className="rv-dialog__patch" aria-label="Patch">
              {preview.patch.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === '')).map((l, i) => {
                const meta = l.startsWith('@@') || l.startsWith('---') || l.startsWith('+++');
                const k = meta ? 'meta' : lineKind(l);
                return <div key={i} className={`rv-pl rv-pl--${meta ? 'hunk' : k}`}>{l || ' '}</div>;
              })}
            </pre>
            <label className="rv-check">
              <input type="checkbox" checked={tell} onChange={(e) => setTell(e.target.checked)} />
              <span>Tell Claude <span className="rv-check__hint">so it re-reads the file before editing it again</span></span>
            </label>
          </>
        )}

        {error && <div className="rv-dialog__error" role="alert">{error}</div>}

        <footer className="rv-dialog__foot">
          <button type="button" className="rv-btn rv-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
          {preview && !preview.blocked && (expired ? (
            <button type="button" className="rv-btn" onClick={() => void load()}>Preview expired, check again</button>
          ) : hard ? (
            <HoldToConfirm onConfirm={() => void confirm('hold')} busy={busy} label="Hold to revert" busyLabel="Reverting" ariaLabel="Press and hold to revert. Hold Space or Enter for about one second." />
          ) : (
            <button type="button" className="rv-btn rv-btn--danger" onClick={() => void confirm('tap')} disabled={busy} autoFocus>
              <IconRevert width={14} height={14} /> {busy ? 'Reverting…' : 'Revert'}
            </button>
          ))}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
