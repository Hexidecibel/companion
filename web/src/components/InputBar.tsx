import { useState, useRef, useCallback, type KeyboardEvent, type ClipboardEvent, type DragEvent } from 'react';
import { PendingImage } from '../types';

interface InputBarProps {
  onSend: (text: string) => Promise<boolean>;
  onSendWithImages?: (text: string, images: PendingImage[]) => Promise<boolean>;
  disabled?: boolean;
}

let imageIdCounter = 0;

function fileToPreview(file: File): PendingImage {
  return {
    id: `img-${++imageIdCounter}`,
    file,
    previewUrl: URL.createObjectURL(file),
  };
}

export function InputBar({ onSend, onSendWithImages, disabled }: InputBarProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const hasContent = text.trim().length > 0 || images.length > 0;

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
    setText('');
    setImages([]);
    setSending(true);

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
  }, [text, images, sending, disabled, onSend, onSendWithImages]);

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

  const handlePaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
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
  }, [addImages]);

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
    addImages(files);
  }, [addImages]);

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    addImages(files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [addImages]);

  return (
    <div
      ref={wrapperRef}
      className="input-bar-wrapper"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{ position: 'relative' }}
    >
      {images.length > 0 && (
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
        <textarea
          ref={textareaRef}
          className="input-bar-textarea"
          value={text}
          onChange={(e) => { setText(e.target.value); handleInput(); }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Send a message..."
          disabled={disabled || sending}
          rows={1}
        />
        <button
          className="input-bar-send"
          onClick={handleSend}
          disabled={!hasContent || sending || disabled}
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
      {dragging && (
        <div className="input-bar-drop-overlay">
          Drop images here
        </div>
      )}
    </div>
  );
}
