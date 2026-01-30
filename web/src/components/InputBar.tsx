import { useState, useRef, useCallback, type KeyboardEvent } from 'react';

interface InputBarProps {
  onSend: (text: string) => Promise<boolean>;
  disabled?: boolean;
}

export function InputBar({ onSend, disabled }: InputBarProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || disabled) return;

    const saved = text;
    setText('');
    setSending(true);

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    const success = await onSend(trimmed);
    if (!success) {
      // Restore text on failure
      setText(saved);
    }
    setSending(false);

    // Re-focus textarea
    textareaRef.current?.focus();
  }, [text, sending, disabled, onSend]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  };

  return (
    <div className="input-bar">
      <textarea
        ref={textareaRef}
        className="input-bar-textarea"
        value={text}
        onChange={(e) => { setText(e.target.value); handleInput(); }}
        onKeyDown={handleKeyDown}
        placeholder="Send a message..."
        disabled={disabled || sending}
        rows={1}
      />
      <button
        className="input-bar-send"
        onClick={handleSend}
        disabled={!text.trim() || sending || disabled}
        title="Send (Enter)"
      >
        {sending ? (
          <div className="spinner small" />
        ) : (
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M3 10L17 3L10 17L9 11L3 10Z" fill="currentColor" />
          </svg>
        )}
      </button>
    </div>
  );
}
