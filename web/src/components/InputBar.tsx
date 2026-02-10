import { useState, useRef, useCallback, useMemo, forwardRef, useImperativeHandle, type KeyboardEvent, type ClipboardEvent, type DragEvent } from 'react';
import { PendingImage, Skill } from '../types';
import { useUndoHistory } from '../hooks/useUndoHistory';
import { SlashMenu, SlashMenuItem } from './SlashMenu';
import { isMobileViewport } from '../utils/platform';

interface InputBarProps {
  onSend: (text: string) => Promise<boolean>;
  onSendWithImages?: (text: string, images: PendingImage[]) => Promise<boolean>;
  disabled?: boolean;
  skills?: Skill[];
  terminalMode?: boolean;
  onTerminalSend?: (text: string) => Promise<boolean>;
  onTerminalKey?: (key: string) => void;
}

export interface InputBarHandle {
  prefill: (text: string) => void;
}

let imageIdCounter = 0;

function fileToPreview(file: File): PendingImage {
  return {
    id: `img-${++imageIdCounter}`,
    file,
    previewUrl: URL.createObjectURL(file),
  };
}

export const InputBar = forwardRef<InputBarHandle, InputBarProps>(function InputBar({ onSend, onSendWithImages, disabled, skills = [], terminalMode, onTerminalSend, onTerminalKey }, ref) {
  const { value: text, onChange: setText, undo, redo, reset: resetHistory } = useUndoHistory();
  const [sending, setSending] = useState(false);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [dragging, setDragging] = useState(false);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    prefill(newText: string) {
      setText(newText);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    },
  }), [setText]);

  const hasContent = text.trim().length > 0 || images.length > 0;

  // Detect slash command query
  const slashQuery = useMemo(() => {
    if (!showSlashMenu) return '';
    const match = text.match(/^\/(\S*)$/);
    return match ? match[1] : '';
  }, [text, showSlashMenu]);

  const addImages = useCallback((files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    setImages((prev) => [...prev, ...imageFiles.map(fileToPreview)]);
  }, []);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => {
      const img = prev.find((i) => i.id === id);
      if (img) URL.revokeObjectURL(img.previewUrl);
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if ((!trimmed && images.length === 0) || sending || disabled) return;

    const savedText = text;
    const savedImages = [...images];
    resetHistory();
    setImages([]);
    setSending(true);
    setShowSlashMenu(false);

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    let success: boolean;
    if (savedImages.length > 0 && onSendWithImages) {
      success = await onSendWithImages(trimmed, savedImages);
    } else {
      success = await onSend(trimmed);
    }

    if (!success) {
      setText(savedText);
      setImages(savedImages);
    } else {
      // Clean up preview URLs
      savedImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    }
    setSending(false);
    textareaRef.current?.focus();
  }, [text, images, sending, disabled, onSend, onSendWithImages, resetHistory]);

  const handleTerminalSend = useCallback(async () => {
    if (sending || !onTerminalSend) return;

    const trimmed = text.trim();
    const savedText = text;
    resetHistory();
    setSending(true);

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    // Send the trimmed text, or empty string for bare Enter (accepts prompts)
    const success = await onTerminalSend(trimmed);

    if (!success) {
      setText(savedText);
    }
    setSending(false);
    textareaRef.current?.focus();
  }, [text, sending, onTerminalSend, resetHistory, setText]);

  const handleSlashSelect = useCallback(
    (item: SlashMenuItem) => {
      setShowSlashMenu(false);
      if (item.action === 'send' && item.sendText) {
        // Quick actions: send immediately
        setText('');
        onSend(item.sendText);
      } else {
        // Skills and built-ins: insert /<name> and let user press Enter
        setText(`/${item.name}`);
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    },
    [onSend, setText]
  );

  const handleTextChange = useCallback(
    (value: string) => {
      setText(value);
      // Show slash menu when typing / at the start (only in chat mode)
      if (!terminalMode && value.match(/^\/\S*$/) && !value.includes(' ')) {
        setShowSlashMenu(true);
      } else {
        setShowSlashMenu(false);
      }
    },
    [setText, terminalMode]
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Terminal mode key handling
    if (terminalMode) {
      // Ctrl+C sends interrupt
      if (e.ctrlKey && e.key === 'c') {
        e.preventDefault();
        onTerminalKey?.('C-c');
        return;
      }
      // Up arrow when input is empty -> navigate tmux history
      if (e.key === 'ArrowUp' && text.trim() === '') {
        e.preventDefault();
        onTerminalKey?.('Up');
        return;
      }
      // Down arrow when input is empty -> navigate tmux history
      if (e.key === 'ArrowDown' && text.trim() === '') {
        e.preventDefault();
        onTerminalKey?.('Down');
        return;
      }
      // Enter (no shift) -> send to terminal
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleTerminalSend();
        return;
      }
      return;
    }

    // Chat mode key handling (unchanged)
    // When slash menu is open, let it handle navigation keys
    if (showSlashMenu && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Tab')) {
      return; // SlashMenu's keydown listener will handle these
    }
    if (showSlashMenu && e.key === 'Escape') {
      e.preventDefault();
      setShowSlashMenu(false);
      return;
    }

    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      if (undo() !== null) requestAnimationFrame(handleInput);
      return;
    }
    if ((mod && e.key === 'z' && e.shiftKey) || (e.ctrlKey && e.key === 'y')) {
      e.preventDefault();
      if (redo() !== null) requestAnimationFrame(handleInput);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      // If slash menu is open and has items, Enter selects from menu (handled by SlashMenu)
      if (showSlashMenu) return;
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

  const handlePaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (terminalMode) return; // No image paste in terminal mode
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      addImages(files);
    }
  }, [addImages, terminalMode]);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (terminalMode) return;
    e.preventDefault();
    setDragging(true);
  }, [terminalMode]);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (wrapperRef.current && !wrapperRef.current.contains(e.relatedTarget as Node)) {
      setDragging(false);
    }
  }, []);

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    if (terminalMode) return;
    const files = Array.from(e.dataTransfer.files);
    addImages(files);
  }, [addImages, terminalMode]);

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    addImages(files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [addImages]);

  const mobile = isMobileViewport();

  return (
    <div
      ref={wrapperRef}
      className="input-bar-wrapper"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{ position: 'relative' }}
    >
      {!terminalMode && showSlashMenu && (
        <SlashMenu
          query={slashQuery}
          skills={skills}
          onSelect={handleSlashSelect}
          onClose={() => setShowSlashMenu(false)}
        />
      )}
      {!terminalMode && images.length > 0 && (
        <div className="input-bar-images">
          {images.map((img) => (
            <div key={img.id} className="input-bar-image-preview">
              <img src={img.previewUrl} alt="preview" />
              <button
                className="input-bar-image-remove"
                onClick={() => removeImage(img.id)}
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="input-bar">
        {!terminalMode && (
          <>
            <button
              className="input-bar-attach-btn"
              onClick={handleFileSelect}
              title="Attach image"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M17.5 9.31l-7.12 7.12a4.5 4.5 0 01-6.36-6.36l7.12-7.12a3 3 0 014.24 4.24l-7.12 7.13a1.5 1.5 0 01-2.12-2.13L13.26 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
          </>
        )}
        <textarea
          ref={textareaRef}
          className="input-bar-textarea"
          value={text}
          onChange={(e) => { handleTextChange(e.target.value); handleInput(); }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={terminalMode ? 'Type a command...' : 'Send a message...'}
          disabled={disabled || sending}
          rows={1}
        />
        {terminalMode && mobile && (
          <div className="input-bar-terminal-arrows">
            <button
              className="input-bar-terminal-arrow-btn"
              onClick={() => onTerminalKey?.('Up')}
              title="Up arrow"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 3L3 9h10L8 3z" fill="currentColor"/>
              </svg>
            </button>
            <button
              className="input-bar-terminal-arrow-btn"
              onClick={() => onTerminalKey?.('Down')}
              title="Down arrow"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 13L3 7h10L8 13z" fill="currentColor"/>
              </svg>
            </button>
          </div>
        )}
        {mobile && onTerminalKey && (
          <button
            className="input-bar-esc-btn"
            onClick={() => onTerminalKey('Escape')}
            title="Escape"
          >
            Esc
          </button>
        )}
        <button
          className="input-bar-send"
          onClick={terminalMode ? handleTerminalSend : handleSend}
          disabled={!hasContent || sending || disabled}
          title={terminalMode ? 'Send command (Enter)' : 'Send (Enter)'}
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
      {!terminalMode && dragging && (
        <div className="input-bar-drop-overlay">
          Drop images here
        </div>
      )}
    </div>
  );
});
