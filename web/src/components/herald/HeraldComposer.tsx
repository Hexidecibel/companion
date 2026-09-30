import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconSend } from './heraldIcons';

const DRAFT_KEY = 'herald_draft';
const MAX_HEIGHT = 200;

function loadDraft(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveDraft(text: string): void {
  try {
    if (text) localStorage.setItem(DRAFT_KEY, text);
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    // ignore
  }
}

interface HeraldComposerProps {
  displayName: string;
  /** Returns true if the server accepted the line. */
  onSend: (text: string) => Promise<boolean>;
  /** Hub unreachable / Herald disabled: no typing at all. */
  disabled: boolean;
  /** A turn is in flight: typing (and dictation) allowed, sending is not. */
  busy: boolean;
  focusNonce: number;
  /** Escape with an empty draft (e.g. cancel the newest echo countdown). */
  onEscape?: () => void;
  autoFocus?: boolean;
}

/**
 * Dictation-friendly composer. Tools like Wispr Flow insert text
 * programmatically, so everything keys off `input` events and the textarea's
 * live value (read at send time), never keydown bookkeeping.
 */
export function HeraldComposer({ displayName, onSend, disabled, busy, focusNonce, onEscape, autoFocus }: HeraldComposerProps) {
  const [draft, setDraft] = useState(loadDraft);
  const ref = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const h = Math.min(el.scrollHeight, MAX_HEIGHT);
    el.style.height = `${h}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
  }, []);

  useLayoutEffect(resize, [draft, resize]);

  // Belt and braces for injected text: a native listener catches input events
  // dispatched outside React's synthetic system and resyncs state.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => {
      setDraft((prev) => (prev === el.value ? prev : el.value));
    };
    el.addEventListener('input', sync);
    el.addEventListener('change', sync);
    return () => {
      el.removeEventListener('input', sync);
      el.removeEventListener('change', sync);
    };
  }, []);

  useEffect(() => { saveDraft(draft); }, [draft]);

  useEffect(() => {
    if (focusNonce > 0 || autoFocus) {
      // Defer so a sliding-in panel is visible before focusing.
      const t = setTimeout(() => ref.current?.focus({ preventScroll: true }), 60);
      return () => clearTimeout(t);
    }
  }, [focusNonce, autoFocus]);

  const canSend = !disabled && !busy;

  const submit = useCallback(async () => {
    const el = ref.current;
    const text = (el?.value ?? draft).trim();
    if (!text || !canSend) return;
    setDraft('');
    if (el) el.value = '';
    const ok = await onSend(text);
    if (!ok) {
      // Never lose what the user said: put it back unless they've started a new line.
      setDraft((cur) => (cur.trim() ? cur : text));
    }
  }, [draft, canSend, onSend]);

  const hasText = draft.trim().length > 0;

  return (
    <form
      className={`herald-composer${busy ? ' herald-composer--busy' : ''}${disabled ? ' herald-composer--disabled' : ''}`}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
    >
      <textarea
        ref={ref}
        className="herald-composer__input"
        value={draft}
        rows={1}
        disabled={disabled}
        placeholder={disabled ? `${displayName} is offline` : `Ask ${displayName} anything`}
        aria-label={`Message ${displayName}`}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          } else if (e.key === 'Escape' && !(ref.current?.value ?? '') && onEscape) {
            e.preventDefault();
            onEscape();
          }
        }}
        enterKeyHint="send"
        autoComplete="off"
        spellCheck
      />
      <button
        type="submit"
        className="herald-composer__send"
        disabled={!canSend || !hasText}
        aria-label={busy ? `${displayName} is thinking` : 'Send'}
        title={busy ? 'Thinking' : 'Send (Enter)'}
      >
        {busy ? <span className="herald-composer__spinner" aria-hidden="true" /> : <IconSend size={18} />}
      </button>
    </form>
  );
}
