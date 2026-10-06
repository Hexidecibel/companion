import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useBabysit } from '../../hooks/useBabysit';
import { babysitStore, draftFor, draftToRequest, validateDraft, type BabysitDraft } from '../../services/babysit';
import { HERALD_BABYSIT_LIMITS as L } from '../../types/herald';

interface Props {
  serverId: string;
  sessionId: string;
  sessionName?: string | null;
  onClose: () => void;
}

/**
 * The standing brief for one session: goal, which way to lean, what Herald
 * must never decide, time limit and answer limit. Starts a brief, or edits the
 * active one in place (its time limit restarts).
 */
export function BabysitBriefDialog({ serverId, sessionId, sessionName, onClose }: Props) {
  const { available, babysit, active, connected } = useBabysit(serverId, sessionId);
  // Seeded once per open: a brief that changes underneath must not wipe typing.
  const [draft, setDraft] = useState<BabysitDraft>(() => draftFor(babysit));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const goalRef = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => { goalRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const set = <K extends keyof BabysitDraft>(key: K, value: BabysitDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const problem = validateDraft(draft);
    if (problem) { setError(problem); return; }
    setSaving(true);
    const err = await babysitStore.set(draftToRequest(sessionId, draft));
    if (!mounted.current) return;
    setSaving(false);
    if (err) setError(err);
    else onClose();
  };

  const name = sessionName || babysit?.sessionName || 'this session';
  const title = active ? `Babysitting ${name}` : `Babysit ${name}`;

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content babysit-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">{'✕'}</button>
        </div>
        <form className="babysit-dialog__body" onSubmit={submit}>
          <p className="babysit-dialog__intro">
            Herald answers this session's simple questions for you ("continue?", and anything your brief
            clearly covers). Everything else comes to you with a suggested answer. It never answers
            permission prompts.
          </p>

          <label className="babysit-field">
            <span className="babysit-field__label">Goal</span>
            <textarea
              ref={goalRef}
              className="babysit-field__input"
              rows={2}
              maxLength={L.maxGoalChars}
              value={draft.goal}
              onChange={(e) => set('goal', e.target.value)}
              placeholder="Get this production ready"
            />
          </label>

          <label className="babysit-field">
            <span className="babysit-field__label">Which way to lean <em>optional</em></span>
            <textarea
              className="babysit-field__input"
              rows={2}
              maxLength={L.maxDirectionChars}
              value={draft.direction}
              onChange={(e) => set('direction', e.target.value)}
              placeholder="Prefer the simplest fix. Keep the existing tests."
            />
          </label>

          <label className="babysit-field">
            <span className="babysit-field__label">Never decide <em>optional</em></span>
            <textarea
              className="babysit-field__input"
              rows={2}
              maxLength={L.maxNeverChars}
              value={draft.never}
              onChange={(e) => set('never', e.target.value)}
              placeholder="Anything about the database schema or deploys"
            />
            <span className="babysit-field__hint">These always come to you.</span>
          </label>

          <div className="babysit-dialog__row">
            <label className="babysit-field babysit-field--num">
              <span className="babysit-field__label">Time limit (minutes)</span>
              <input
                className="babysit-field__input"
                type="number"
                inputMode="numeric"
                min={L.minMinutes}
                max={L.maxMinutes}
                step={5}
                value={Number.isFinite(draft.minutes) ? draft.minutes : ''}
                onChange={(e) => set('minutes', e.target.value === '' ? NaN : Number(e.target.value))}
              />
            </label>
            <label className="babysit-field babysit-field--num">
              <span className="babysit-field__label">Answer limit</span>
              <input
                className="babysit-field__input"
                type="number"
                inputMode="numeric"
                min={1}
                max={L.maxMaxAnswers}
                step={1}
                value={Number.isFinite(draft.maxAnswers) ? draft.maxAnswers : ''}
                onChange={(e) => set('maxAnswers', e.target.value === '' ? NaN : Number(e.target.value))}
              />
            </label>
          </div>
          {active && <p className="babysit-field__hint">Saving restarts the time limit. Answers so far and the log are kept.</p>}

          {error && <div className="babysit-dialog__error" role="alert">{error}</div>}
          {!available && !error && (
            <div className="babysit-dialog__error" role="alert">Babysitting is not available for this session right now.</div>
          )}

          <div className="babysit-dialog__buttons">
            <button type="button" className="babysit-btn" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="babysit-btn babysit-btn--primary" disabled={saving || !available || !connected}>
              {saving ? 'Saving…' : active ? 'Save' : 'Start babysitting'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
