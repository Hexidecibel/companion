import { useState, useRef, useCallback, useMemo, useEffect, forwardRef, useImperativeHandle, type KeyboardEvent, type ClipboardEvent, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { PendingAttachment, Skill } from '../types';
import { useUndoHistory } from '../hooks/useUndoHistory';
import { SlashMenu, SlashMenuItem } from './SlashMenu';
import { isMobileViewport, isTauriMobile } from '../utils/platform';
import { compressImage } from '../utils/imageCompression';

interface InputBarProps {
  onSend: (text: string) => Promise<boolean>;
  onSendWithImages?: (text: string, images: PendingAttachment[]) => Promise<boolean>;
  disabled?: boolean;
  skills?: Skill[];
  terminalMode?: boolean;
  onTerminalSend?: (text: string) => Promise<boolean>;
  onTerminalKey?: (key: string) => void;
}

export interface InputBarHandle {
  prefill: (text: string) => void;
}

let attachmentIdCounter = 0;

function fileToAttachment(file: File): PendingAttachment {
  const isImage = file.type.startsWith('image/');
  return {
    id: `att-${++attachmentIdCounter}`,
    file,
    name: file.name,
    mimeType: file.type,
    size: file.size,
    isImage,
    previewUrl: isImage ? URL.createObjectURL(file) : undefined,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

export const InputBar = forwardRef<InputBarHandle, InputBarProps>(function InputBar({ onSend, onSendWithImages, disabled, skills = [], terminalMode, onTerminalSend, onTerminalKey }, ref) {
  const { value: text, onChange: setText, undo, redo, reset: resetHistory } = useUndoHistory();
  const [sending, setSending] = useState(false);
  const [images, setImages] = useState<PendingAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [attachMenuPos, setAttachMenuPos] = useState<{ left: number; bottom: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);
  const attachBtnRef = useRef<HTMLButtonElement>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);
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

  const addFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    // Compress images only; non-image files pass through unmodified.
    const processed = await Promise.all(
      files.map(async (f) => (f.type.startsWith('image/') ? compressImage(f) : f)),
    );
    setImages((prev) => [...prev, ...processed.map(fileToAttachment)]);
  }, []);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => {
      const img = prev.find((i) => i.id === id);
      if (img?.previewUrl) URL.revokeObjectURL(img.previewUrl);
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
      savedImages.forEach((img) => { if (img.previewUrl) URL.revokeObjectURL(img.previewUrl); });
    }
    setSending(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [text, images, sending, disabled, onSend, onSendWithImages, resetHistory]);

  const handleTerminalSend = useCallback(async () => {
    if (sending || !onTerminalSend) return;

    // If images are attached, use the normal image send path
    if (images.length > 0 && onSendWithImages) {
      const trimmed = text.trim();
      const savedText = text;
      const savedImages = [...images];
      resetHistory();
      setImages([]);
      setSending(true);
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      const success = await onSendWithImages(trimmed, savedImages);
      if (!success) {
        setText(savedText);
        setImages(savedImages);
      } else {
        savedImages.forEach((img) => { if (img.previewUrl) URL.revokeObjectURL(img.previewUrl); });
      }
      setSending(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }

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
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [text, images, sending, onTerminalSend, onSendWithImages, resetHistory, setText]);

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
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const file = items[i].getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  }, [addFiles, terminalMode]);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (wrapperRef.current && !wrapperRef.current.contains(e.relatedTarget as Node)) {
      setDragging(false);
    }
  }, []);

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    addFiles(files);
  }, [addFiles]);

  // Mobile gets a "Photos / Camera / Files" chooser since native pickers map to
  // distinct accept/capture attributes; desktop/browser keeps the single picker.
  // isMobileViewport() also covers a narrow desktop window, matching the layout.
  const useAttachMenu = isTauriMobile() || isMobileViewport();

  const handleFileSelect = useCallback(() => {
    if (useAttachMenu) {
      // Anchor the popover above the attach button.
      const rect = attachBtnRef.current?.getBoundingClientRect();
      if (rect) {
        setAttachMenuPos({
          left: Math.max(rect.left, 8),
          bottom: Math.max(window.innerHeight - rect.top + 6, 8),
        });
      }
      setShowAttachMenu((v) => !v);
      return;
    }
    fileInputRef.current?.click();
  }, [useAttachMenu]);

  // Shared change handler: works regardless of which hidden input fired.
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const files = input.files ? Array.from(input.files) : [];
    addFiles(files);
    input.value = '';
  }, [addFiles]);

  const handleAttachChoice = useCallback((ref: React.RefObject<HTMLInputElement>) => {
    setShowAttachMenu(false);
    ref.current?.click();
  }, []);

  // Dismiss the attach menu on outside tap / Escape (matches HeaderOverflowMenu).
  useEffect(() => {
    if (!showAttachMenu) return;
    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (attachMenuRef.current?.contains(target)) return;
      if (attachBtnRef.current?.contains(target)) return;
      setShowAttachMenu(false);
    };
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setShowAttachMenu(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showAttachMenu]);

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
      {images.length > 0 && (
        <div className="input-bar-images">
          {images.map((att) => (
            att.isImage && att.previewUrl ? (
              <div key={att.id} className="input-bar-image-preview">
                <img src={att.previewUrl} alt="preview" />
                <button
                  className="input-bar-image-remove"
                  onClick={() => removeImage(att.id)}
                  title="Remove attachment"
                >
                  x
                </button>
              </div>
            ) : (
              <div key={att.id} className="input-bar-file-chip" title={att.name}>
                <svg className="input-bar-file-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M9 1.5H4a1 1 0 00-1 1v11a1 1 0 001 1h8a1 1 0 001-1V5.5L9 1.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
                  <path d="M9 1.5V5.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
                </svg>
                <div className="input-bar-file-meta">
                  <span className="input-bar-file-name">{att.name || 'file'}</span>
                  <span className="input-bar-file-size">{formatBytes(att.size)}</span>
                </div>
                <button
                  className="input-bar-file-remove"
                  onClick={() => removeImage(att.id)}
                  title="Remove attachment"
                >
                  x
                </button>
              </div>
            )
          ))}
        </div>
      )}
      <div className="input-bar">
        {!terminalMode && (
          <>
            <button
              ref={attachBtnRef}
              className="input-bar-attach-btn"
              onClick={handleFileSelect}
              title="Attach file"
              aria-haspopup={useAttachMenu ? 'menu' : undefined}
              aria-expanded={useAttachMenu ? showAttachMenu : undefined}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M17.5 9.31l-7.12 7.12a4.5 4.5 0 01-6.36-6.36l7.12-7.12a3 3 0 014.24 4.24l-7.12 7.13a1.5 1.5 0 01-2.12-2.13L13.26 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            {/* Desktop/browser single picker (accepts anything). */}
            <input
              ref={fileInputRef}
              type="file"
              accept="*/*"
              multiple
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
            {/* Mobile chooser targets — distinct accept/capture, shared handler. */}
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
            <input
              ref={filesInputRef}
              type="file"
              accept="*/*"
              multiple
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
            {showAttachMenu && attachMenuPos &&
              createPortal(
                <div
                  ref={attachMenuRef}
                  className="context-menu"
                  role="menu"
                  style={{ left: attachMenuPos.left, bottom: attachMenuPos.bottom }}
                >
                  <button
                    role="menuitem"
                    className="context-menu-item"
                    onClick={() => handleAttachChoice(photoInputRef)}
                  >
                    Photo Library
                  </button>
                  <button
                    role="menuitem"
                    className="context-menu-item"
                    onClick={() => handleAttachChoice(cameraInputRef)}
                  >
                    Camera
                  </button>
                  <button
                    role="menuitem"
                    className="context-menu-item"
                    onClick={() => handleAttachChoice(filesInputRef)}
                  >
                    Files
                  </button>
                </div>,
                document.body,
              )}
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
        {terminalMode && mobile && onTerminalKey && (
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
      {dragging && (
        <div className="input-bar-drop-overlay">
          Drop files here
        </div>
      )}
    </div>
  );
});
