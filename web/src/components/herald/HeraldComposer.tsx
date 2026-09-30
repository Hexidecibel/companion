import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { InjectedTranscript } from '../../hooks/useHeraldVoiceInput';
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
  /** Returns true if the server accepted the line. `mode` 'voice': an auto-sent transcript. */
  onSend: (text: string, mode?: 'voice' | 'text') => Promise<boolean>;
  /** Hub unreachable / Herald disabled: no typing at all. */
  disabled: boolean;
  /** A turn is in flight: typing (and dictation) allowed, sending is not. */
  busy: boolean;
  focusNonce: number;
  /** Escape with an empty draft (e.g. cancel the newest echo countdown). */
  onEscape?: () => void;
  autoFocus?: boolean;
  /** The user typed (or dictated) into the draft: barge-in hook. */
  onTyping?: () => void;
  /** Push-to-talk key hooks; return true when the key was consumed. */
  onVoiceKeyDown?: (e: KeyboardEvent, value: string) => boolean;
  onVoiceKeyUp?: (e: KeyboardEvent) => boolean;
  /** A voice transcript to place in the draft (and send, if autoSend). */
  inject?: InjectedTranscript | null;
  onInjected?: (id: number) => void;
  /** Extra control rendered before the send button (the mic). */
  voiceSlot?: ReactNode;
  /** Replaces the placeholder (e.g. "Listening…"). */
  placeholderOverride?: string;
}

/**
 * Dictation-friendly composer. Tools like Wispr Flow insert text
 * programmatically, so everything keys off `input` events and the textarea's
 * live value (read at send time), never keydown bookkeeping.
 */
export function HeraldComposer({
  displayName, onSend, disabled, busy, focusNonce, onEscape, autoFocus, onTyping,
  onVoiceKeyDown, onVoiceKeyUp, inject, onInjected, voiceSlot, placeholderOverride,
}: HeraldComposerProps) {
  const [draft, setDraft] = useState(loadDraft);
  const ref = useRef<HTMLTextAreaElement>(null);
  const onTypingRef = useRef(onTyping);
  onTypingRef.current = onTyping;

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
      if (el.value) onTypingRef.current?.();
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

  const sendText = useCallback(async (text: string, mode: 'voice' | 'text' = 'text') => {
    const el = ref.current;
    setDraft('');
    if (el) el.value = '';
    const ok = await onSend(text, mode);
    if (!ok) {
      // Never lose what the user said: put it back unless they've started a new line.
      setDraft((cur) => (cur.trim() ? cur : text));
    }
  }, [onSend]);

  const submit = useCallback(async () => {
    const text = (ref.current?.value ?? draft).trim();
    if (!text || !canSend) return;
    await sendText(text);
  }, [draft, canSend, sendText]);

  // Voice transcript: send it straight away when the box was empty and a turn
  // can start; otherwise append it to the draft for review.
  const lastInjected = useRef(0);
  useEffect(() => {
    if (!inject || inject.id === lastInjected.current) return;
    lastInjected.current = inject.id;
    onInjected?.(inject.id);
    const current = ref.current?.value ?? '';
    if (inject.autoSend && canSend && !current.trim()) {
      void sendText(inject.text, inject.mode);
      return;
    }
    const merged = current.trim() ? `${current.replace(/\s+$/, '')} ${inject.text}` : inject.text;
    setDraft(merged);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [inject, onInjected, canSend, sendText]);

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
        placeholder={placeholderOverride ?? (disabled ? `${displayName} is offline` : `Ask ${displayName} anything`)}
        aria-label={`Message ${displayName}`}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (onVoiceKeyDown?.(e.nativeEvent, ref.current?.value ?? '')) return;
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          } else if (e.key === 'Escape' && !(ref.current?.value ?? '') && onEscape) {
            e.preventDefault();
            onEscape();
          }
        }}
        onKeyUp={(e) => { onVoiceKeyUp?.(e.nativeEvent); }}
        enterKeyHint="send"
        autoComplete="off"
        spellCheck
      />
      {voiceSlot}
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
